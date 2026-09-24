import 'dotenv/config'
import mongoose from 'mongoose'
import { ProjectResourcesRepository } from '@modules/project-resources'
import {
  TRAFFIC_SETTINGS_ITEM_RESOURCES,
  TrafficSettingsRepository,
  WRITABLE_COLUMNS,
  createBigQueryApiForContext,
  resolveProjectContext,
  type ITrafficSettingsActor,
  type TrafficSettingsItemInput,
  type TrafficSettingsItemResource,
} from '@modules/traffic-settings'

/**
 * Release check for the traffic settings SQL.
 *
 * Every statement the repository sends is submitted to BigQuery as a dry run:
 * the service validates syntax, table and column existence, and the declared
 * query-parameter types against the project's real dataset, executes nothing and
 * scans zero bytes. Unit tests cannot cover any of that, because the SQL is only
 * meaningful against a real schema.
 *
 * A dry run cannot observe runtime behaviour — a revision conflict, `@@row_count`
 * after the conditional update, or a transaction rollback — so a passing report
 * means "every statement is valid against this dataset", not "concurrency works".
 *
 *   npx tsx src/scripts/dryrun-traffic-settings.ts --project=123
 *   npx tsx src/scripts/dryrun-traffic-settings.ts --all --limit=1
 *   npx tsx src/scripts/dryrun-traffic-settings.ts --all
 */

interface ICheckResult {
  name: string
  ok: boolean
  error?: string
}

/** Placeholder identity: nothing is executed, so nothing is attributed to it. */
const ACTOR: ITrafficSettingsActor = { actorId: 'dry-run', requestId: 'dry-run' }

/** A revision that cannot match any row, as a second guarantee of no effect. */
const EXPECTED_REVISION = '-1'

/** An id in the API's own format that no row can carry. */
const ITEM_ID = 'custom_00000000-0000-0000-0000-000000000000'

/** The fields each resource's statements reference directly. */
const DRAFT_OVERRIDES: Record<TrafficSettingsItemResource, Record<string, unknown>> = {
  'excluded-url-params': { param_key_regex: '^utm_', is_active: true, description: 'dry run' },
  'excluded-referrers': { host: 'example.com', is_active: true, description: 'dry run' },
  'traffic-rules': {
    priority: 1,
    is_active: true,
    stage: 'utm',
    target: 'both',
    applies_to_web: true,
    source_regex: '^example$',
    set_source: 'example',
  },
  'attribution-signal-mappings': {
    priority: 1,
    is_active: true,
    entity: 'order',
    param_source: 'custom_params',
    source_param_key: 'utm_source',
    match_source_regex: '^example$',
    mode: 'fallback',
  },
}

/**
 * A draft covering every writable column, null where the value does not matter.
 * Built from the allowlist rather than written out, so a new column is carried
 * into the check automatically instead of being silently left untested. Null is a
 * valid value for almost every column and the repository types each parameter
 * explicitly, so this exercises the real parameter set.
 */
function draftFor(resource: TrafficSettingsItemResource): TrafficSettingsItemInput {
  const draft: Record<string, unknown> = {}
  for (const column of WRITABLE_COLUMNS[resource]) {
    draft[column] = null
  }

  // The domain validation the API runs before a write is not repeated here: this
  // check is about the SQL, and an invalid draft would never reach BigQuery
  return { ...draft, ...DRAFT_OVERRIDES[resource] } as TrafficSettingsItemInput
}

async function runCheck(name: string, check: () => Promise<unknown>): Promise<ICheckResult> {
  try {
    await check()

    return { name, ok: true }
  } catch (error) {
    return { name, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function checkProject(projectId: number): Promise<ICheckResult[]> {
  const { context, misregisteredResources } = await resolveProjectContext(projectId)
  const bigqueryApi = createBigQueryApiForContext(context)
  const repository = new TrafficSettingsRepository(context, bigqueryApi, { isDryRun: true })

  console.log(
    `\n=== project ${projectId} — ${context.gcpProjectId}.${context.datasetId} (${context.datasetLocation}) ===`,
  )

  if (misregisteredResources.length > 0) {
    console.log(`  note: misregistered resources: ${misregisteredResources.join(', ')}`)
  }

  const results: ICheckResult[] = []

  results.push(
    await runCheck('readActiveExcludedUrlParamPatterns', () =>
      repository.readActiveExcludedUrlParamPatterns(),
    ),
    await runCheck('previewUrl', () =>
      repository.previewUrl('https://example.com/p?utm_source=a&id=1', ['^utm_']),
    ),
    await runCheck('createReferrers', () =>
      repository.createReferrers(['example.com', 'ads.example.com'], EXPECTED_REVISION, ACTOR),
    ),
  )

  for (const resource of TRAFFIC_SETTINGS_ITEM_RESOURCES) {
    const draft = draftFor(resource)

    results.push(
      await runCheck(`readCollection ${resource}`, () => repository.readCollection(resource)),
      await runCheck(`readItem ${resource}`, () => repository.readItem(resource, ITEM_ID)),
      await runCheck(`countItemsWithId ${resource}`, () =>
        repository.countItemsWithId(resource, ITEM_ID),
      ),
      await runCheck(`createItem ${resource}`, () =>
        repository.createItem(resource, draft, EXPECTED_REVISION, ACTOR),
      ),
      await runCheck(`replaceItem ${resource}`, () =>
        repository.replaceItem(resource, ITEM_ID, draft, EXPECTED_REVISION, ACTOR),
      ),
      await runCheck(`setItemActive ${resource}`, () =>
        repository.setItemActive(resource, ITEM_ID, true, EXPECTED_REVISION, ACTOR),
      ),
      await runCheck(`deleteItem ${resource}`, () =>
        repository.deleteItem(resource, ITEM_ID, EXPECTED_REVISION, ACTOR),
      ),
    )
  }

  for (const result of results) {
    console.log(`  [${result.ok ? 'ok  ' : 'FAIL'}] ${result.name}`)
    if (result.error) {
      console.log(`         ${result.error.split('\n')[0]}`)
    }
  }

  return results
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const all = argv.includes('--all')
  const projectIds = argv
    .filter((argument) => argument.startsWith('--project='))
    .flatMap((argument) => argument.slice('--project='.length).split(','))
    .map((value) => Number(value.trim()))

  // The statements are identical for every tenant, so one project is enough to
  // validate them; the full sweep is for confirming each dataset is migrated
  const limitArgument = argv.find((argument) => argument.startsWith('--limit='))
  const limit = limitArgument ? Number(limitArgument.slice('--limit='.length)) : null

  if (!all && (projectIds.length === 0 || projectIds.some((id) => !Number.isInteger(id)))) {
    throw new Error('Specify --all or --project=<id>[,<id>...]')
  }

  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error('--limit must be a positive integer')
  }

  await mongoose.connect(`${process.env.MONGO_CREDENTIALS}`)

  try {
    const resolved = all
      ? (await ProjectResourcesRepository.find({}, { project_id: 1 }).lean())
          .map((document) => document.project_id)
          .sort((left, right) => left - right)
      : projectIds

    const targets = limit === null ? resolved : resolved.slice(0, limit)

    let failed = 0
    for (const projectId of targets) {
      try {
        const results = await checkProject(projectId)
        failed += results.filter((result) => !result.ok).length
      } catch (error) {
        failed += 1
        console.log(
          `\n=== project ${projectId} ===\n  FAILED to resolve: ${
            error instanceof Error ? error.message : error
          }`,
        )
      }
    }

    console.log(`\nDone. ${targets.length} project(s), ${failed} failing statement(s).`)

    if (failed > 0) {
      process.exitCode = 1
    }
  } finally {
    await mongoose.connection.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
