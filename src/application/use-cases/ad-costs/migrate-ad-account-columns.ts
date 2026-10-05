import {
  AD_COSTS_TABLE_ID,
  AD_COSTS_TABLE_SCHEMA,
  FACEBOOK_ADS_AD_COSTS_TABLE_ID,
  FACEBOOK_ADS_AD_COSTS_TABLE_SCHEMA,
  GOOGLE_ADS_AD_COSTS_TABLE_ID,
  GOOGLE_ADS_AD_COSTS_TABLE_SCHEMA,
  TIKTOK_ADS_AD_COSTS_TABLE_ID,
  TIKTOK_ADS_AD_COSTS_TABLE_SCHEMA,
} from '@modules/gcloud/bigquery'
import { createBigQueryApiForContext, resolveProjectContext } from '@modules/traffic-settings'
import type {
  IMigrationReport,
  IMigrationStep,
} from '@application/use-cases/traffic-settings/migrate-traffic-settings'
import { AD_ACCOUNT_PATCH_MARKER, addAdAccountColumnsToQuery } from './ad-account-query-patch'

/**
 * Adds the ad account columns to one project and patches its attribution query
 * to fill them: `ad_account_name` in the platform staging tables,
 * `ad_account_id` / `ad_account_name` in `ad_costs`.
 *
 * Order matters: the patched query reads `ad_account_name` from the staging
 * tables and writes both columns to `ad_costs`, so it is updated only after every
 * existing table has them. The deployed query is patched, not re-rendered, to
 * keep per-project customizations (see ad-account-query-patch.ts).
 * Additive and idempotent; `dryRun` writes nothing.
 */

const AD_ACCOUNT_COLUMNS = ['ad_account_id', 'ad_account_name']

// Staging tables are created by the workers on the first export, so a project
// may lack some of them; such a table gets the column from its current schema.
const TABLES: ReadonlyArray<{
  tableId: string
  schema: ReadonlyArray<{ name: string; type: string }>
  required: boolean
}> = [
  {
    tableId: FACEBOOK_ADS_AD_COSTS_TABLE_ID,
    schema: FACEBOOK_ADS_AD_COSTS_TABLE_SCHEMA,
    required: false,
  },
  {
    tableId: GOOGLE_ADS_AD_COSTS_TABLE_ID,
    schema: GOOGLE_ADS_AD_COSTS_TABLE_SCHEMA,
    required: false,
  },
  {
    tableId: TIKTOK_ADS_AD_COSTS_TABLE_ID,
    schema: TIKTOK_ADS_AD_COSTS_TABLE_SCHEMA,
    required: false,
  },
  { tableId: AD_COSTS_TABLE_ID, schema: AD_COSTS_TABLE_SCHEMA, required: true },
]

const migrateAdAccountColumns = async (
  projectId: number,
  options: { dryRun: boolean },
): Promise<IMigrationReport> => {
  const { dryRun } = options
  const report: IMigrationReport = { projectId, dryRun, steps: [], failed: false }

  const record = (step: string, status: IMigrationStep['status'], detail?: string): void => {
    report.steps.push({ step, status, detail })
  }

  try {
    const { context } = await resolveProjectContext(projectId)
    const bigqueryApi = createBigQueryApiForContext(context)
    report.gcpProjectId = context.gcpProjectId
    report.datasetId = context.datasetId

    // 1. Columns
    let columnsReady = true
    for (const { tableId, schema, required } of TABLES) {
      const step = `add ad account columns to ${tableId}`
      const metadata = await bigqueryApi.getTableMetadata(context.datasetId, tableId)
      if (!metadata) {
        if (required) columnsReady = false
        record(step, required ? 'skipped' : 'already_current', 'Table does not exist')
        continue
      }

      const present = new Set(metadata.schema.map((field) => field.name))
      const additions = schema
        .filter((field) => AD_ACCOUNT_COLUMNS.includes(field.name) && !present.has(field.name))
        .map((field) => ({ ...field, mode: 'NULLABLE' }))

      if (additions.length === 0) {
        record(step, 'already_current')
      } else if (dryRun) {
        record(step, 'planned', additions.map((field) => field.name).join(', '))
      } else {
        await bigqueryApi.addMissingColumns(context.datasetId, tableId, additions)
        record(step, 'done', additions.map((field) => field.name).join(', '))
      }
    }

    // 2. Attribution query
    const step = 'patch attribution scheduled query'
    const deployed = context.scheduledQueryName
      ? await bigqueryApi.getScheduledQuery(context.scheduledQueryName)
      : null

    if (!columnsReady) {
      record(step, 'skipped', 'ad_costs does not exist')
    } else if (!context.scheduledQueryName || !deployed?.query) {
      record(step, 'skipped', 'No attribution scheduled query is registered for this project')
    } else if (deployed.query.includes(AD_ACCOUNT_PATCH_MARKER)) {
      record(step, 'already_current')
    } else {
      let patched: string | null = null
      try {
        patched = addAdAccountColumnsToQuery(deployed.query)
      } catch (error) {
        record(step, 'skipped', `Unexpected query shape, update it manually: ${String(error)}`)
      }
      if (patched !== null) {
        if (dryRun) {
          record(step, 'planned', 'ad account columns in the Facebook, Google and TikTok branches')
        } else {
          await bigqueryApi.updateScheduledQueryText(context.scheduledQueryName, patched)
          record(step, 'done')
        }
      }
    }
  } catch (error) {
    report.failed = true
    report.failure = error instanceof Error ? error.message : String(error)
  }

  return report
}

export { migrateAdAccountColumns }
