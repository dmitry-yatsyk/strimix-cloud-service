import { ProjectDataProvider } from '@application/providers/project-data-provider'
import { ProjectResourcesRepository } from '@modules/project-resources'
import {
  EXCLUDED_REFERRERS_LEGACY_COLUMN,
  EXCLUDED_REFERRERS_TABLE_ID,
  EXCLUDED_REFERRERS_TABLE_SCHEMA,
  TRAFFIC_SETTINGS_REVISIONS_TABLE_ID,
  TRAFFIC_SETTINGS_REVISIONS_TABLE_SCHEMA,
  UPDATE_COSTS_AND_CALCULATE_ATTRIBUTION_TEMPLATE,
  buildTrafficSettingsRevisionsSeedQuery,
  processScheduledQueryTemplate,
} from '@modules/gcloud/bigquery'
import {
  CUSTOM_ID_PREFIX,
  RESOURCE_TABLE_IDS,
  TRAFFIC_SETTINGS_ITEM_RESOURCES,
  TRAFFIC_SETTINGS_RESOURCES,
  createBigQueryApiForContext,
  diffStoredHostList,
  qualifiedTableRef,
  requiredSchemaColumns,
  resolveProjectContext,
  TrafficSettingsReadiness,
  TrafficSettingsRepository,
  type IResourceReadiness,
  type TrafficSettingsItemResource,
  type TrafficSettingsResource,
} from '@modules/traffic-settings'
import {
  ATTRIBUTION_SIGNAL_MAPPINGS_TABLE_SCHEMA,
  EXCLUDED_URL_PARAMS_TABLE_SCHEMA,
  TRAFFIC_RULES_TABLE_SCHEMA,
  buildSystemTrafficRuleNamesBackfillQuery,
  systemTrafficRuleNamesBackfillPendingPredicate,
} from '@modules/gcloud/bigquery'

/**
 * Brings one project's traffic settings storage up to what the current code
 * expects, without changing what the configuration MEANS.
 *
 * The rule the whole script obeys: a step that cannot be performed without
 * altering the effective configuration is not performed. It is reported, and the
 * resource is left alone. A migration that "fixes" an excluded referrer list by
 * quietly dropping an entry it could not normalize would change which traffic is
 * attributed as referral — a data change disguised as maintenance.
 *
 * Everything here is idempotent, so a partially completed run can simply be run
 * again, and `dryRun` performs no writes at all.
 */

export interface IMigrationStep {
  step: string
  status: 'done' | 'planned' | 'skipped' | 'already_current'
  detail?: string
}

export type ReferrerConversionOutcome = 'done' | 'planned' | 'skipped' | 'already_current'

/**
 * The new attribution template reads the row-per-host shape. Deploying it while
 * the conversion was left alone would make the nightly job fail on `is_active`.
 */
export function referrerConversionBlocksAttributionRefresh(
  outcome: ReferrerConversionOutcome,
): boolean {
  return outcome === 'skipped'
}

/** A leftover temp table is an interrupted swap, not an empty project. */
export function missingReferrerTableAction(
  tempTableExists: boolean,
): 'resume_rename' | 'create_empty' {
  return tempTableExists ? 'resume_rename' : 'create_empty'
}

export interface IMigrationReport {
  projectId: number
  dryRun: boolean
  gcpProjectId?: string
  datasetId?: string
  steps: IMigrationStep[]
  readinessBefore?: Record<TrafficSettingsResource, IResourceReadiness>
  readinessAfter?: Record<TrafficSettingsResource, IResourceReadiness>
  failed: boolean
  failure?: string
}

const ITEM_TABLE_SCHEMAS: Record<
  TrafficSettingsItemResource,
  ReadonlyArray<{ name: string; type: string; mode?: string }>
> = {
  'excluded-url-params': EXCLUDED_URL_PARAMS_TABLE_SCHEMA,
  'excluded-referrers': EXCLUDED_REFERRERS_TABLE_SCHEMA,
  'traffic-rules': TRAFFIC_RULES_TABLE_SCHEMA,
  'attribution-signal-mappings': ATTRIBUTION_SIGNAL_MAPPINGS_TABLE_SCHEMA,
}

const migrateTrafficSettings = async (
  projectId: number,
  options: { dryRun: boolean },
): Promise<IMigrationReport> => {
  const { dryRun } = options
  const report: IMigrationReport = { projectId, dryRun, steps: [], failed: false }

  const record = (step: string, status: IMigrationStep['status'], detail?: string): void => {
    report.steps.push({ step, status, detail })
  }

  try {
    const { context, misregisteredResources } = await resolveProjectContext(projectId)
    const bigqueryApi = createBigQueryApiForContext(context)
    report.gcpProjectId = context.gcpProjectId
    report.datasetId = context.datasetId

    report.readinessBefore = await new TrafficSettingsReadiness(
      context,
      bigqueryApi,
      misregisteredResources,
    ).evaluateAll()

    // A stored reference that contradicts the project's own dataset is never
    // "corrected" here: it could mean the project record was crossed with another
    // tenant's, and repointing it would be the wrong repair to guess at.
    if (misregisteredResources.length > 0) {
      record(
        'verify stored table references',
        'skipped',
        `These resources point outside the project dataset and need manual review: ${misregisteredResources.join(', ')}`,
      )
    }

    // 1. Revisions table. Without it there is no concurrency control at all, so
    // this is the one step that unlocks writing for a legacy project.
    const revisionsExist = await bigqueryApi.tableExists(
      context.datasetId,
      TRAFFIC_SETTINGS_REVISIONS_TABLE_ID,
    )
    if (revisionsExist) {
      record('create revisions table', 'already_current')
    } else if (dryRun) {
      record('create revisions table', 'planned')
    } else {
      await bigqueryApi.createTable({
        projectId: context.gcpProjectId,
        datasetId: context.datasetId,
        tableId: TRAFFIC_SETTINGS_REVISIONS_TABLE_ID,
        schema: TRAFFIC_SETTINGS_REVISIONS_TABLE_SCHEMA,
        description:
          'Per-collection revision of the traffic and attribution config tables. Bumped inside the same transaction as every settings write; never edited directly.',
      })
      record('create revisions table', 'done')
    }

    // 2. Revision rows. The seed only inserts what is missing, so an existing
    // revision is never reset and a re-run cannot create the duplicate row that
    // would make the resource unwritable.
    if (dryRun) {
      record('initialise revision rows', 'planned', 'Inserts only the missing resources')
    } else {
      await bigqueryApi.runQuery(
        buildTrafficSettingsRevisionsSeedQuery(context.gcpProjectId, context.datasetId),
      )
      record('initialise revision rows', 'done')
    }

    // 3. Excluded referrers become one row per host. This runs before the additive
    // column step, because a legacy referrer table cannot be repaired by adding
    // columns — the rows themselves have to be rewritten — and once it has run the
    // additive step sees the current shape and has nothing to do.
    const referrersOutcome = await migrateExcludedReferrers(context, bigqueryApi, dryRun, record)

    // 4. Columns added by later versions. Only additive: BigQuery cannot add a
    // REQUIRED column to a populated table, and nothing is ever dropped or
    // retyped, so existing rows keep their values and read back as NULL for the
    // new fields.
    for (const resource of TRAFFIC_SETTINGS_ITEM_RESOURCES) {
      const tableId = RESOURCE_TABLE_IDS[resource]
      const metadata = await bigqueryApi.getTableMetadata(context.datasetId, tableId)
      if (!metadata) {
        record(`add missing columns to ${tableId}`, 'skipped', 'Table does not exist')
        continue
      }

      const present = new Set(metadata.schema.map((field) => field.name))

      // Only reachable when the conversion above was skipped: adding the new
      // referrer columns to a table that still holds the array would produce a
      // shape that satisfies the readiness probe while holding no usable rows.
      if (resource === 'excluded-referrers' && present.has(EXCLUDED_REFERRERS_LEGACY_COLUMN)) {
        record(
          `add missing columns to ${tableId}`,
          'skipped',
          'Table still holds the legacy host array, so the conversion has to succeed first',
        )
        continue
      }

      const missing = requiredSchemaColumns(resource).filter((column) => !present.has(column))

      if (missing.length === 0) {
        record(`add missing columns to ${tableId}`, 'already_current')
        continue
      }

      const additions = ITEM_TABLE_SCHEMAS[resource]
        .filter((field) => missing.includes(field.name))
        .map((field) => ({ ...field, mode: 'NULLABLE' }))

      if (dryRun) {
        record(`add missing columns to ${tableId}`, 'planned', missing.join(', '))
      } else {
        await bigqueryApi.addMissingColumns(context.datasetId, tableId, additions)
        record(`add missing columns to ${tableId}`, 'done', missing.join(', '))
      }
    }

    // 4b. Backfill short display names on system traffic rules. Only fills empty
    // names so an operator edit is never overwritten. Attribution signal
    // mappings have no system seed rows.
    await backfillSystemTrafficRuleNames(context, bigqueryApi, dryRun, record)

    // 5. Register anything the project record does not know about yet, so the API
    // can resolve it. Only tables that actually exist are registered.
    await registerTableReferences(projectId, context, bigqueryApi, dryRun, record)

    // 6. Report which stored exclusion patterns behave differently under the new
    // logic, before the step that would actually deploy it.
    await reportExclusionBehaviourChanges(context, bigqueryApi, record)

    // 7. Refresh the attribution job. The new template reads `host` / `is_active`
    // on excluded_referrers, so it must not be deployed while that table is still
    // the legacy array — the nightly job would fail on every run.
    await refreshScheduledQuery(projectId, context, bigqueryApi, dryRun, record, {
      referrersReady: !referrerConversionBlocksAttributionRefresh(referrersOutcome),
    })

    if (!dryRun) {
      const { context: refreshed, misregisteredResources: stillMisregistered } =
        await resolveProjectContext(projectId)
      report.readinessAfter = await new TrafficSettingsReadiness(
        refreshed,
        createBigQueryApiForContext(refreshed),
        stillMisregistered,
      ).evaluateAll()
    }
  } catch (error) {
    report.failed = true
    report.failure = error instanceof Error ? error.message : String(error)
  }

  return report
}

/**
 * Converts excluded referrers to one row per host, keeping the excluded set
 * exactly as it is.
 *
 * Three shapes exist in the wild and all of them end up here: a project with no
 * table at all, the oldest projects where `excluded_referrers` is a VIEW, and
 * projects holding a table with a single repeated `hosts` column. The first is
 * created empty; the other two are read through that same `hosts` column, so one
 * query covers both.
 *
 * If current normalization would change the set — a host that no longer parses, or
 * one that normalizes to a different string — the conversion stops and reports.
 * Writing a different list would silently change which traffic counts as referral,
 * and that decision belongs to whoever owns the project, not to a migration.
 *
 * The new table is built under a temporary name and swapped in, so the window in
 * which `excluded_referrers` does not exist is two metadata operations rather than
 * a whole load. The attribution job reads this table on every run.
 */
async function backfillSystemTrafficRuleNames(
  context: Awaited<ReturnType<typeof resolveProjectContext>>['context'],
  bigqueryApi: ReturnType<typeof createBigQueryApiForContext>,
  dryRun: boolean,
  record: (step: string, status: IMigrationStep['status'], detail?: string) => void,
): Promise<void> {
  const step = 'backfill system traffic rule names'
  const tableId = RESOURCE_TABLE_IDS['traffic-rules']
  const metadata = await bigqueryApi.getTableMetadata(context.datasetId, tableId)

  if (!metadata) {
    record(step, 'skipped', 'Table does not exist')
    return
  }

  const hasName = metadata.schema.some((field) => field.name === 'name')
  if (!hasName) {
    if (dryRun) {
      record(
        step,
        'planned',
        'Would fill short names on system rules after the name column is added',
      )
      return
    }
    record(
      step,
      'skipped',
      'Column name is not present yet; the additive column step must succeed first',
    )
    return
  }

  const tableRef = qualifiedTableRef(context, tableId)
  const { rows } = await bigqueryApi.queryWithParams<{ pending: number }>({
    query: `select count(*) as pending
from ${tableRef}
where ${systemTrafficRuleNamesBackfillPendingPredicate()}`,
  })
  const pending = Number(rows[0]?.pending ?? 0)

  if (pending === 0) {
    record(step, 'already_current')
    return
  }

  if (dryRun) {
    record(step, 'planned', `${pending} system rule(s) would receive a short English name`)
    return
  }

  await bigqueryApi.runQuery(
    buildSystemTrafficRuleNamesBackfillQuery(context.gcpProjectId, context.datasetId),
  )
  record(step, 'done', `Filled or renamed name on ${pending} system rule(s)`)
}

/**
 * Converts excluded referrers to one row per host, keeping the excluded set
 * exactly as it is.
 *
 * Three shapes exist in the wild and all of them end up here: a project with no
 * table at all, the oldest projects where `excluded_referrers` is a VIEW, and
 * projects holding a table with a single repeated `hosts` column. The first is
 * created empty; the other two are read through that same `hosts` column, so one
 * query covers both.
 *
 * If current normalization would change the set — a host that no longer parses, or
 * one that normalizes to a different string — the conversion stops and reports.
 * Writing a different list would silently change which traffic counts as referral,
 * and that decision belongs to whoever owns the project, not to a migration.
 *
 * The new table is built under a temporary name and swapped in, so the window in
 * which `excluded_referrers` does not exist is two metadata operations rather than
 * a whole load. The attribution job reads this table on every run.
 */
async function migrateExcludedReferrers(
  context: Awaited<ReturnType<typeof resolveProjectContext>>['context'],
  bigqueryApi: ReturnType<typeof createBigQueryApiForContext>,
  dryRun: boolean,
  record: (step: string, status: IMigrationStep['status'], detail?: string) => void,
): Promise<ReferrerConversionOutcome> {
  const step = 'convert excluded_referrers to one row per host'
  const temporaryTableId = `${EXCLUDED_REFERRERS_TABLE_ID}_migration_tmp`
  const metadata = await bigqueryApi.getTableMetadata(
    context.datasetId,
    EXCLUDED_REFERRERS_TABLE_ID,
  )

  if (!metadata) {
    const tempExists = await bigqueryApi.tableExists(context.datasetId, temporaryTableId)
    const action = missingReferrerTableAction(tempExists)

    if (action === 'resume_rename') {
      if (dryRun) {
        record(
          step,
          'planned',
          'Main table is missing; leftover migration temp table will be renamed into place',
        )
        return 'planned'
      }

      const temporaryRef = qualifiedTableRef(context, temporaryTableId)
      await bigqueryApi.runQuery(
        `alter table ${temporaryRef} rename to ${EXCLUDED_REFERRERS_TABLE_ID}`,
      )
      record(step, 'done', 'Finished an interrupted conversion by renaming the leftover temp table')
      return 'done'
    }

    if (dryRun) {
      record(step, 'planned', 'Table is missing entirely and will be created empty')
      return 'planned'
    }
    await createExcludedReferrersTable(bigqueryApi, context, EXCLUDED_REFERRERS_TABLE_ID)
    record(step, 'done', 'Created empty table')
    return 'done'
  }

  const isView = metadata.type !== 'TABLE'
  const holdsHostArray = metadata.schema.some(
    (field) => field.name === EXCLUDED_REFERRERS_LEGACY_COLUMN,
  )

  if (!isView && !holdsHostArray) {
    record(step, 'already_current')
    return 'already_current'
  }

  const currentRef = qualifiedTableRef(context, EXCLUDED_REFERRERS_TABLE_ID)
  const { rows } = await bigqueryApi.queryWithParams<{ hosts: string[] | null }>({
    query: `select ifnull(array_agg(distinct host order by host), []) as hosts
from ${currentRef}, unnest(${EXCLUDED_REFERRERS_LEGACY_COLUMN}) as host
where host is not null`,
  })
  const storedHosts = rows[0]?.hosts ?? []
  const diff = diffStoredHostList(storedHosts)

  if (!diff.unchanged) {
    const problems = [
      ...diff.rejected.map((issue) => `${issue.field}: ${issue.message}`),
      ...diff.changed.map((change) => `"${change.from}" would become "${change.to}"`),
    ]
    record(
      step,
      'skipped',
      `Converting would change the excluded set, so it was left alone. Resolve these first: ${problems.join('; ')}`,
    )
    return 'skipped'
  }

  if (dryRun) {
    record(
      step,
      'planned',
      `${storedHosts.length} host(s) would become ${storedHosts.length} active row(s), unchanged`,
    )
    return 'planned'
  }

  const temporaryRef = qualifiedTableRef(context, temporaryTableId)

  // A previous run may have created the temp table and then died before the
  // swap. Recreating it would abort with "already exists"; the main table
  // still holds the source rows, so dropping the leftover is safe.
  if (await bigqueryApi.tableExists(context.datasetId, temporaryTableId)) {
    await bigqueryApi.runQuery(`drop table ${temporaryRef}`)
  }

  // Created from the canonical schema rather than through CREATE TABLE AS SELECT,
  // so the migrated table carries the same REQUIRED modes as a freshly deployed
  // one instead of an inferred all-nullable variant.
  await createExcludedReferrersTable(bigqueryApi, context, temporaryTableId)

  if (diff.normalized.length > 0) {
    await bigqueryApi.queryWithParams({
      query: `insert into ${temporaryRef} (referrer_id, host, is_active, description)
select concat(@id_prefix, generate_uuid()), host, true, null
from unnest(@hosts) as host`,
      params: { hosts: diff.normalized, id_prefix: CUSTOM_ID_PREFIX },
      types: { hosts: ['STRING'], id_prefix: 'STRING' },
    })
  }

  await bigqueryApi.runQuery(isView ? `drop view ${currentRef}` : `drop table ${currentRef}`)
  await bigqueryApi.runQuery(`alter table ${temporaryRef} rename to ${EXCLUDED_REFERRERS_TABLE_ID}`)

  record(step, 'done', `${diff.normalized.length} host(s) carried over unchanged as active row(s)`)
  return 'done'
}

function createExcludedReferrersTable(
  bigqueryApi: ReturnType<typeof createBigQueryApiForContext>,
  context: Awaited<ReturnType<typeof resolveProjectContext>>['context'],
  tableId: string,
): Promise<unknown> {
  return bigqueryApi.createTable({
    projectId: context.gcpProjectId,
    datasetId: context.datasetId,
    tableId,
    schema: EXCLUDED_REFERRERS_TABLE_SCHEMA,
    description:
      'Excluded referrer hosts, one row per host. Client-owned; edited via the traffic settings UI. The attribution job reads the active rows when classifying referrals.',
  })
}

/**
 * Fills in the table references the project record is missing. Registration is
 * what lets the API address a table at all, and an older project may hold a table
 * that was created before the field existed.
 */
async function registerTableReferences(
  projectId: number,
  context: Awaited<ReturnType<typeof resolveProjectContext>>['context'],
  bigqueryApi: ReturnType<typeof createBigQueryApiForContext>,
  dryRun: boolean,
  record: (step: string, status: IMigrationStep['status'], detail?: string) => void,
): Promise<void> {
  const projectResources = await ProjectResourcesRepository.findOne({ project_id: projectId })
  if (!projectResources) {
    record('register table references', 'skipped', 'Project resources record disappeared')
    return
  }

  const tables = projectResources.gcloud.bigquery.tables as unknown as Record<string, string | null>
  const toRegister: string[] = []

  for (const tableId of [
    ...TRAFFIC_SETTINGS_RESOURCES.map((resource) => RESOURCE_TABLE_IDS[resource]),
    TRAFFIC_SETTINGS_REVISIONS_TABLE_ID,
  ]) {
    if (tables[tableId]) {
      continue
    }
    if (await bigqueryApi.tableExists(context.datasetId, tableId)) {
      toRegister.push(tableId)
    }
  }

  if (toRegister.length === 0) {
    record('register table references', 'already_current')
    return
  }

  if (dryRun) {
    record('register table references', 'planned', toRegister.join(', '))
    return
  }

  for (const tableId of toRegister) {
    tables[tableId] = `${context.gcpProjectId}.${context.datasetId}.${tableId}`
  }
  projectResources.markModified('gcloud.bigquery.tables')
  await projectResources.save()
  record('register table references', 'done', toRegister.join(', '))
}

/**
 * Replaces the deployed attribution query with the current template.
 *
 * This is not cosmetic: the URL-exclusion logic changed, and a scheduled query
 * keeps executing the text it was created with. Until it is replaced, a project
 * would keep applying the old combined-alternation matching, so edits made in the
 * new UI would appear to have no effect.
 */
async function refreshScheduledQuery(
  projectId: number,
  context: Awaited<ReturnType<typeof resolveProjectContext>>['context'],
  bigqueryApi: ReturnType<typeof createBigQueryApiForContext>,
  dryRun: boolean,
  record: (step: string, status: IMigrationStep['status'], detail?: string) => void,
  options: { referrersReady: boolean },
): Promise<void> {
  const step = 'refresh attribution scheduled query'

  if (!options.referrersReady) {
    record(
      step,
      'skipped',
      'Attribution query left untouched because excluded_referrers still has the old shape. Both must move together',
    )
    return
  }

  if (!context.scheduledQueryName) {
    record(step, 'skipped', 'No attribution scheduled query is registered for this project')
    return
  }

  const projectInfo = await ProjectDataProvider.getProjectInfo(projectId)
  if (!projectInfo) {
    record(step, 'skipped', 'Project info is unavailable, so the timezone cannot be resolved')
    return
  }

  const expectedQuery = processScheduledQueryTemplate(
    UPDATE_COSTS_AND_CALCULATE_ATTRIBUTION_TEMPLATE,
    {
      projectName: context.gcpProjectId,
      datasetName: context.datasetId,
      projectTimezone: projectInfo.timezone,
    },
  )

  const deployed = await bigqueryApi.getScheduledQuery(context.scheduledQueryName)
  if (!deployed) {
    record(step, 'skipped', 'The registered scheduled query no longer exists')
    return
  }
  if (deployed.query === expectedQuery) {
    record(step, 'already_current')
    return
  }

  if (dryRun) {
    record(
      step,
      'planned',
      `Deployed query text differs from the current template — ${summarizeQueryDifference(
        deployed.query ?? '',
        expectedQuery,
      )}`,
    )
    return
  }

  await bigqueryApi.updateScheduledQueryText(context.scheduledQueryName, expectedQuery)
  record(step, 'done')
}

/**
 * Which stored exclusion patterns the template change gives a different meaning.
 *
 * Replacing the attribution query makes the job recompute `landing_page` for the
 * whole history, so the operator needs to know up front whether that recomputation
 * can differ at all for this project. It can only differ for patterns that the old
 * combined-alternation form mishandled:
 *
 *  - a quote was deleted from the pattern before it was inlined, so what ran was
 *    not what was stored;
 *  - the old form appended `=` to the alternation and matched the whole `key=value`
 *    token, so a pattern ending in `$` could never match;
 *  - alternation made an inline flag in one pattern apply to its neighbours;
 *  - an empty pattern turned into an empty alternative, which matched every token.
 *
 * A project whose patterns hit none of these recomputes to the same values, which
 * is the answer that lets the refresh proceed without a data review.
 */
async function reportExclusionBehaviourChanges(
  context: Awaited<ReturnType<typeof resolveProjectContext>>['context'],
  bigqueryApi: ReturnType<typeof createBigQueryApiForContext>,
  record: (step: string, status: IMigrationStep['status'], detail?: string) => void,
): Promise<void> {
  const step = 'check stored exclusion patterns against the new logic'

  if (!context.tableIds['excluded-url-params']) {
    record(step, 'skipped', 'excluded_url_params does not exist for this project')
    return
  }

  const patterns = await new TrafficSettingsRepository(
    context,
    bigqueryApi,
  ).readActiveExcludedUrlParamPatterns()

  if (patterns.length === 0) {
    // The old form fell back to '$^', which matches nothing, and an empty array
    // now excludes nothing either — the same outcome
    record(step, 'already_current', 'No active patterns, so nothing is excluded either way')
    return
  }

  const changed = patterns.flatMap((pattern: string) => {
    const reasons: string[] = []

    if (pattern.includes("'")) {
      reasons.push('quote was stripped before')
    }
    if (pattern.trimEnd().endsWith('$')) {
      reasons.push('anchored with $, never matched before')
    }
    if (/\(\?[a-zA-Z]+\)/.test(pattern)) {
      reasons.push('inline flag leaked into other patterns before')
    }

    return reasons.length > 0 ? [`"${pattern}" (${reasons.join(', ')})`] : []
  })

  if (changed.length === 0) {
    record(
      step,
      'already_current',
      `${patterns.length} active pattern(s), all behave identically under the new logic`,
    )
    return
  }

  record(
    step,
    'planned',
    `${changed.length} of ${patterns.length} pattern(s) change meaning: ${changed.join('; ')}`,
  )
}

/**
 * How the deployed attribution query differs from the template, in lines.
 *
 * Replacing the query text changes how a live attribution job computes its
 * output, so the dry run has to say more than "differs": an operator needs to see
 * the size of the change before agreeing to it.
 */
function summarizeQueryDifference(deployed: string, expected: string): string {
  const deployedLines = deployed.split('\n')
  const expectedLines = expected.split('\n')
  const deployedSet = new Set(deployedLines.map((line) => line.trim()))
  const expectedSet = new Set(expectedLines.map((line) => line.trim()))

  const added = expectedLines.filter((line) => !deployedSet.has(line.trim()))
  const removed = deployedLines.filter((line) => !expectedSet.has(line.trim()))

  const sample = (lines: string[]): string => {
    const first = lines.find((line) => line.trim().length > 0)?.trim() ?? ''
    return first.length > 90 ? `${first.slice(0, 90)}…` : first
  }

  return [
    `${deployedLines.length} deployed line(s) vs ${expectedLines.length} template line(s)`,
    `+${added.length} / -${removed.length}`,
    added.length > 0 ? `first added: ${sample(added)}` : '',
    removed.length > 0 ? `first removed: ${sample(removed)}` : '',
  ]
    .filter((part) => part.length > 0)
    .join('; ')
}

export { migrateTrafficSettings }
