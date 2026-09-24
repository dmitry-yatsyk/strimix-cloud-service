import 'dotenv/config'
import mongoose from 'mongoose'
import {
  createBigQueryApiForContext,
  qualifiedTableRef,
  resolveProjectContext,
  RESOURCE_TABLE_IDS,
} from '@modules/traffic-settings'

/**
 * Backfills `applies_to_web = true` on origin/channel visit-targeting rules.
 *
 * Why this exists: the attribution job used to ignore `applies_to_web` on
 * origin and channel, so every such rule classified web visits. After the SQL
 * honors the flag (same as utm: null/false → synthetic only), existing rows
 * with null (system seeds) or false (frontend saves) would stop matching web
 * visits unless they are flipped to true first.
 *
 * HARD CONSTRAINT: the only write is `UPDATE ... SET applies_to_web = TRUE`.
 * Rule bodies (name, priority, regex, outputs, stage, target, is_active, …)
 * are never overwritten, deleted, reseeded, or replaced. UTM rules and
 * ad_cost-only rules are never touched.
 *
 * Dry run is the default. Prefer an explicit project id — do not sweep every
 * tenant unless you mean to.
 *
 *   npx tsx src/scripts/backfill-applies-to-web-origin-channel.ts --project=7919
 *   npx tsx src/scripts/backfill-applies-to-web-origin-channel.ts --project=7919 --apply
 *
 * New installs get applies_to_web=true from buildTrafficRulesSeedQuery; this
 * script is for already-provisioned datasets only.
 */

interface IOptions {
  projectIds: number[]
  apply: boolean
}

interface IPendingRow {
  rule_id: string
  name: string | null
  stage: string
  applies_to_web: boolean | null
}

const PENDING_PREDICATE = `stage in ('origin', 'channel')
  and target in ('visit', 'both')
  and (applies_to_web is null or applies_to_web = false)`

function parseArguments(argv: string[]): IOptions {
  const apply = argv.includes('--apply')

  if (argv.includes('--all')) {
    throw new Error(
      'This backfill requires an explicit --project=<id>[,<id>...]. Refusing --all so every customer dataset is not scanned by default.',
    )
  }

  const projectIds = argv
    .filter((argument) => argument.startsWith('--project='))
    .flatMap((argument) => argument.slice('--project='.length).split(','))
    .map((value) => Number(value.trim()))

  if (projectIds.length === 0 || projectIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error('Specify --project=<id>[,<id>...] with positive integer project ids')
  }

  return { projectIds, apply }
}

async function backfillProject(projectId: number, apply: boolean): Promise<boolean> {
  const mode = apply ? 'APPLY' : 'DRY RUN'
  console.log(`\n=== project ${projectId} (${mode}) ===`)

  const { context, misregisteredResources } = await resolveProjectContext(projectId)
  if (misregisteredResources.includes('traffic-rules')) {
    console.log('  FAILED: traffic-rules table reference is misregistered; needs manual review')
    return false
  }

  const tableId = context.tableIds['traffic-rules'] ?? RESOURCE_TABLE_IDS['traffic-rules']
  const tableRef = qualifiedTableRef(context, tableId)
  const bigqueryApi = createBigQueryApiForContext(context)

  console.log(`  dataset: ${context.gcpProjectId}.${context.datasetId}`)
  console.log(`  table: ${tableRef}`)

  const { rows } = await bigqueryApi.queryWithParams<IPendingRow>({
    query: `select rule_id, name, stage, applies_to_web
from ${tableRef}
where ${PENDING_PREDICATE}
order by stage, priority, rule_id`,
  })

  if (rows.length === 0) {
    console.log('  already current: no origin/channel visit-targeting rows with null/false applies_to_web')
    return true
  }

  console.log(`  ${rows.length} row(s) would set applies_to_web = true:`)
  for (const row of rows) {
    const oldFlag =
      row.applies_to_web === null || row.applies_to_web === undefined
        ? 'null'
        : String(row.applies_to_web)
    console.log(
      `    project=${projectId} rule_id=${row.rule_id} name=${JSON.stringify(row.name)} stage=${row.stage} old_applies_to_web=${oldFlag}`,
    )
  }

  if (!apply) {
    console.log('  dry-run only — no UPDATE executed')
    return true
  }

  const { numDmlAffectedRows } = await bigqueryApi.queryWithParams({
    query: `update ${tableRef}
set applies_to_web = true
where ${PENDING_PREDICATE}`,
  })

  console.log(
    `  applied: set applies_to_web = true on ${numDmlAffectedRows ?? rows.length} row(s) (bodies untouched)`,
  )
  return true
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))

  await mongoose.connect(`${process.env.MONGO_CREDENTIALS}`)

  try {
    console.log(
      `Backfilling applies_to_web for origin/channel visit rules on ${options.projectIds.length} project(s) in ${
        options.apply ? 'apply' : 'dry-run'
      } mode`,
    )

    let failed = 0
    for (const projectId of options.projectIds) {
      const ok = await backfillProject(projectId, options.apply)
      if (!ok) {
        failed += 1
      }
    }

    console.log(`\nDone. ${options.projectIds.length} project(s), ${failed} failed.`)
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
