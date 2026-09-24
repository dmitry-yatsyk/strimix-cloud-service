import { ATTRIBUTION_SIGNAL_MAPPINGS_TABLE_ID } from './bigquery.attribution_signal_mappings.schema'
import { EXCLUDED_REFERRERS_TABLE_ID } from './bigquery.excluded_referrers.schema'
import { EXCLUDED_URL_PARAMS_TABLE_ID } from './bigquery.excluded_url_params.schema'
import { TRAFFIC_RULES_TABLE_ID } from './bigquery.traffic_rules.schema'

export const TRAFFIC_SETTINGS_REVISIONS_TABLE_ID = 'traffic_settings_revisions'

/**
 * Service table backing optimistic concurrency for the four traffic and
 * attribution config tables. It holds exactly four rows per project — one per
 * config table, addressed by the canonical BigQuery table name — and is the
 * only place where a collection version lives.
 *
 * `revision` is a monotonic per-collection counter starting at 1. Every
 * successful mutation bumps it exactly once inside the SAME multi-statement
 * transaction that writes the domain row, so a stale `expected_revision` can
 * never overwrite a concurrent change. Reads take the domain rows and the
 * revision from one consistent snapshot.
 *
 * The table is created (and its four rows initialised) only by controlled
 * provisioning / migration — never lazily on a GET, which would race four
 * concurrent readers into duplicate rows. Re-deploying a project must not
 * reset a revision: the initial insert is conditional on absence.
 *
 * It carries no business semantics and does not change the schema of the four
 * domain tables. Direct manual SQL against the domain tables during operation
 * must bump the matching revision through the same transaction, otherwise
 * clients holding an older revision would not notice the change.
 */
export const TRAFFIC_SETTINGS_REVISIONS_TABLE_SCHEMA = [
  { name: 'resource', type: 'STRING', mode: 'REQUIRED' },
  { name: 'revision', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'updated_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'updated_by', type: 'STRING' },
]

/**
 * The four `resource` keys, which are exactly the canonical table names of the
 * config tables they version. Imported rather than retyped so a table rename
 * cannot leave the revision rows pointing at a name nothing else uses.
 */
export const TRAFFIC_SETTINGS_REVISION_RESOURCES = [
  EXCLUDED_URL_PARAMS_TABLE_ID,
  EXCLUDED_REFERRERS_TABLE_ID,
  TRAFFIC_RULES_TABLE_ID,
  ATTRIBUTION_SIGNAL_MAPPINGS_TABLE_ID,
]

/**
 * Initialises the missing revision rows and nothing else.
 *
 * `where resource not in (...)` makes it idempotent, which matters because
 * project deployment is re-runnable: an unconditional insert would add a second
 * row per resource on every re-deploy, and two revision rows are precisely the
 * state that makes safe editing impossible. It also means re-running deployment
 * never resets a revision that clients already hold.
 */
export function buildTrafficSettingsRevisionsSeedQuery(
  projectId: string,
  datasetId: string,
): string {
  const tableRef = `\`${projectId}.${datasetId}.${TRAFFIC_SETTINGS_REVISIONS_TABLE_ID}\``
  const resourceList = TRAFFIC_SETTINGS_REVISION_RESOURCES.map((name) => `'${name}'`).join(', ')

  return `insert into ${tableRef} (resource, revision, updated_at, updated_by)
select resource, 1, current_timestamp(), 'provisioning'
from unnest([${resourceList}]) as resource
where resource not in (select resource from ${tableRef})`
}
