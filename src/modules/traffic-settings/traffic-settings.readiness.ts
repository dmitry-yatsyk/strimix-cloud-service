import {
  EXCLUDED_REFERRERS_LEGACY_COLUMN,
  type BigQueryApi,
  type ITableMetadata,
} from '@modules/gcloud/bigquery'
import {
  MAPPING_REGEX_COLUMNS,
  RESOURCE_REVISION_KEYS,
  TRAFFIC_RULE_REGEX_COLUMNS,
  TRAFFIC_SETTINGS_APPLICATION_MODE,
  TRAFFIC_SETTINGS_RESOURCES,
  type TrafficSettingsItemResource,
  type TrafficSettingsResource,
} from './traffic-settings.constants'
import { READABLE_COLUMNS, idColumnOf } from './column-types'
import { qualifiedTableRef } from './project-context'
import { TrafficSettingsError } from './traffic-settings.errors'
import type {
  IMetaResult,
  IProjectBigQueryContext,
  IResourceReadiness,
} from './traffic-settings.interface'

/**
 * Readiness preflight.
 *
 * The four config tables were introduced over time and older projects can be in
 * any of several intermediate states: no table at all, the legacy
 * `excluded_referrers` VIEW, a table created before a column was added, or no
 * revision row. This module names each of those states explicitly so the API can
 * answer "not ready, and here is why" instead of the two answers that would both
 * be wrong: an empty list (which looks like "nothing is configured" and invites
 * the user to re-create settings that already exist) or a bare 500.
 *
 * It is used twice: to build `GET /meta`, and to re-check the single resource a
 * mutation targets. The flags in `/meta` are a UI hint; this check on the write
 * path is the authority.
 */

/** Columns holding a user-authored RE2 pattern, per resource. */
const RESOURCE_REGEX_COLUMNS: Record<TrafficSettingsItemResource, readonly string[]> = {
  'excluded-url-params': ['param_key_regex'],
  // Referrer hosts are normalized literals, not patterns: nothing to compile.
  'excluded-referrers': [],
  'traffic-rules': TRAFFIC_RULE_REGEX_COLUMNS,
  'attribution-signal-mappings': MAPPING_REGEX_COLUMNS,
}

const READINESS_MESSAGES: Record<string, string> = {
  TABLE_MISSING:
    'This setting is not provisioned for the project yet. An administrator must deploy the project resources before it can be used.',
  DATASET_MISSING:
    'The project has no analytics storage registered yet, so traffic settings cannot be read.',
  LEGACY_VIEW:
    'This project still stores excluded referrers as a view. An administrator must run the migration before the list can be used.',
  LEGACY_HOSTS_COLUMN:
    'This project still stores excluded referrers as one row with a list of hosts. An administrator must run the migration before the list can be used.',
  REVISION_ROW_MISSING:
    'This setting has no revision record yet, so concurrent edits cannot be protected. An administrator must run the migration before it can be edited.',
  REVISION_ROWS_DUPLICATED:
    'This setting has more than one revision record, which makes safe editing impossible. An administrator must repair it.',
  SCHEMA_COLUMNS_MISSING:
    'This setting was created by an older version and is missing fields the current version uses. An administrator must run the migration.',
  DUPLICATE_ITEM_IDS:
    'Two or more records share the same identifier, so no single record can be addressed safely. An administrator must repair the data.',
  RESOURCE_MISREGISTERED:
    'The stored location of this setting contradicts the project configuration. An administrator must repair the project registration.',
  INVALID_STORED_REGEX:
    'At least one saved pattern is not a valid expression. It is ignored by the attribution job and can be corrected, disabled or deleted here.',
  PRIORITY_CONFLICTS:
    'Some active rules share a priority within the same stage. The attribution job resolves them in an unspecified order until one of them is changed.',
}

function readiness(
  state: IResourceReadiness['state'],
  readable: boolean,
  writable: boolean,
  reasonCode?: string,
): IResourceReadiness {
  if (!reasonCode) {
    return { readable, writable, state }
  }
  return {
    readable,
    writable,
    state,
    reason_code: reasonCode,
    message: READINESS_MESSAGES[reasonCode],
  }
}

/** Diagnostics one query can answer once a table is known to exist and be complete. */
interface IResourceProbe {
  revisionRows: number
  duplicateIdGroups: number
  invalidRegexValues: number
  priorityConflictRows: number
}

export class TrafficSettingsReadiness {
  private readonly context: IProjectBigQueryContext
  private readonly bigqueryApi: BigQueryApi
  private readonly misregisteredResources: Set<TrafficSettingsResource>
  /** Per-request memo: /meta probes four resources and shares the revisions table. */
  private readonly metadataCache = new Map<string, Promise<ITableMetadata | null>>()

  constructor(
    context: IProjectBigQueryContext,
    bigqueryApi: BigQueryApi,
    misregisteredResources: TrafficSettingsResource[] = [],
  ) {
    this.context = context
    this.bigqueryApi = bigqueryApi
    this.misregisteredResources = new Set(misregisteredResources)
  }

  private tableMetadata(tableId: string): Promise<ITableMetadata | null> {
    const cached = this.metadataCache.get(tableId)
    if (cached) {
      return cached
    }
    const pending = this.bigqueryApi.getTableMetadata(this.context.datasetId, tableId)
    this.metadataCache.set(tableId, pending)
    return pending
  }

  /**
   * Single diagnostics query for one resource. It is only ever built for a table
   * that exists and carries every column referenced below, so a failure here is a
   * genuine BigQuery problem rather than an expected "older project" shape.
   */
  private async probeResource(resource: TrafficSettingsResource): Promise<IResourceProbe> {
    const revisionRowsSql = `(select count(*) from ${this.revisionsTableRef()} where resource = @resource)`

    const itemResource = resource as TrafficSettingsItemResource
    const tableRef = this.tableRef(itemResource)
    const idColumn = idColumnOf(itemResource)
    const regexColumns = RESOURCE_REGEX_COLUMNS[itemResource]

    // `safe.regexp_contains` yields NULL instead of failing the query when the
    // pattern does not compile, which is exactly the distinction wanted here:
    // "this stored pattern is broken" rather than "this pattern matches nothing".
    const invalidRegexSql =
      regexColumns.length > 0
        ? `(select countif(pattern is not null and safe.regexp_contains('', pattern) is null)
     from ${tableRef} as t, unnest([${regexColumns.map((column) => `t.${column}`).join(', ')}]) as pattern)`
        : '0'

    // Pre-existing collisions only. `both` overlaps `visit` and `ad_cost`, while
    // `visit` and `ad_cost` do not overlap each other.
    const priorityConflictSql =
      itemResource === 'traffic-rules'
        ? `(select count(*) from (
       select a.rule_id
       from ${tableRef} as a
       join ${tableRef} as b
         on a.rule_id != b.rule_id
        and a.stage = b.stage
        and a.priority = b.priority
        and (a.target = b.target or a.target = 'both' or b.target = 'both')
       where a.is_active = true and b.is_active = true
       group by a.rule_id
     ))`
        : '0'

    const query = `select
  ${revisionRowsSql} as revision_rows,
  (select count(*) from (
     select ${idColumn}
     from ${tableRef}
     group by ${idColumn}
     having count(*) > 1
   )) as duplicate_id_groups,
  ${invalidRegexSql} as invalid_regex_values,
  ${priorityConflictSql} as priority_conflict_rows`

    const { rows } = await this.bigqueryApi.queryWithParams<{
      revision_rows: number
      duplicate_id_groups: number
      invalid_regex_values: number
      priority_conflict_rows: number
    }>({
      query,
      params: { resource: RESOURCE_REVISION_KEYS[resource] },
      types: { resource: 'STRING' },
    })

    const row = rows[0]
    return {
      revisionRows: Number(row?.revision_rows ?? 0),
      duplicateIdGroups: Number(row?.duplicate_id_groups ?? 0),
      invalidRegexValues: Number(row?.invalid_regex_values ?? 0),
      priorityConflictRows: Number(row?.priority_conflict_rows ?? 0),
    }
  }

  private revisionsTableRef(): string {
    return qualifiedTableRef(this.context, this.context.revisionsTableId)
  }

  private tableRef(resource: TrafficSettingsItemResource): string {
    return qualifiedTableRef(this.context, this.context.tableIds[resource] as string)
  }

  private requiredColumnsOf(resource: TrafficSettingsResource): readonly string[] {
    return READABLE_COLUMNS[resource as TrafficSettingsItemResource]
  }

  public async evaluateResource(resource: TrafficSettingsResource): Promise<IResourceReadiness> {
    if (this.misregisteredResources.has(resource)) {
      return readiness('invalid_configuration', false, false, 'RESOURCE_MISREGISTERED')
    }

    if (!this.context.tableIds[resource]) {
      return readiness('not_provisioned', false, false, 'TABLE_MISSING')
    }

    const [metadata, revisionsMetadata] = await Promise.all([
      this.tableMetadata(this.context.tableIds[resource] as string),
      this.tableMetadata(this.context.revisionsTableId),
    ])

    if (!metadata) {
      return readiness('not_provisioned', false, false, 'TABLE_MISSING')
    }

    // Two pre-row-per-host shapes exist in the wild and neither can be read with
    // the current columns, so both refuse reads as well as writes. They are
    // reported apart from a generic column mismatch because the fix differs: the
    // view has to be dropped, the table has to be rewritten row by row.
    if (resource === 'excluded-referrers') {
      if (metadata.type !== 'TABLE') {
        return readiness('migration_required', false, false, 'LEGACY_VIEW')
      }
      if (metadata.schema.some((field) => field.name === EXCLUDED_REFERRERS_LEGACY_COLUMN)) {
        return readiness('migration_required', false, false, 'LEGACY_HOSTS_COLUMN')
      }
    }

    const presentColumns = new Set(metadata.schema.map((field) => field.name))
    const missingColumns = this.requiredColumnsOf(resource).filter(
      (column) => !presentColumns.has(column),
    )
    if (missingColumns.length > 0) {
      return readiness('migration_required', false, false, 'SCHEMA_COLUMNS_MISSING')
    }

    // Every read joins the revisions table. If it is missing the query fails
    // with "table not found", so claiming the resource is readable would send
    // the client into a 500. Same reason as a missing revision row: migrate.
    if (!revisionsMetadata) {
      return readiness('migration_required', false, false, 'REVISION_ROW_MISSING')
    }

    const probe = await this.probeResource(resource)

    if (probe.revisionRows === 0) {
      return readiness('migration_required', true, false, 'REVISION_ROW_MISSING')
    }
    if (probe.revisionRows > 1) {
      return readiness('invalid_configuration', true, false, 'REVISION_ROWS_DUPLICATED')
    }
    // An ambiguous id makes every single-row statement unsafe: the same WHERE
    // clause would touch two records. Reads still work, so an administrator can
    // see what has to be repaired.
    if (probe.duplicateIdGroups > 0) {
      return readiness('invalid_configuration', true, false, 'DUPLICATE_ITEM_IDS')
    }
    // The two remaining states keep `writable: true` on purpose: a broken pattern
    // or a legacy priority collision is repaired through this very API, so
    // blocking writes would make the configuration permanently unfixable.
    if (probe.priorityConflictRows > 0) {
      return readiness('invalid_configuration', true, true, 'PRIORITY_CONFLICTS')
    }
    if (probe.invalidRegexValues > 0) {
      return readiness('invalid_configuration', true, true, 'INVALID_STORED_REGEX')
    }

    return readiness('ready', true, true)
  }

  public async evaluateAll(): Promise<Record<TrafficSettingsResource, IResourceReadiness>> {
    const entries = await Promise.all(
      TRAFFIC_SETTINGS_RESOURCES.map(
        async (resource) => [resource, await this.evaluateResource(resource)] as const,
      ),
    )
    return Object.fromEntries(entries) as Record<TrafficSettingsResource, IResourceReadiness>
  }

  public async buildMeta(): Promise<IMetaResult> {
    return {
      project_id: this.context.projectId,
      application: {
        mode: TRAFFIC_SETTINGS_APPLICATION_MODE,
        scheduled_query_configured: Boolean(this.context.scheduledQueryName),
      },
      resources: await this.evaluateAll(),
    }
  }

  /**
   * Guards a read. Throws the state-specific domain error so the client can show
   * "not provisioned" / "migration required" instead of interpreting a failure as
   * an empty configuration.
   */
  public async assertReadable(resource: TrafficSettingsResource): Promise<IResourceReadiness> {
    const state = await this.evaluateResource(resource)
    if (!state.readable) {
      throw this.toError(resource, state)
    }
    return state
  }

  /** Guards a write. This, not the `/meta` flag, is what actually protects the data. */
  public async assertWritable(resource: TrafficSettingsResource): Promise<IResourceReadiness> {
    const state = await this.evaluateResource(resource)
    if (!state.writable) {
      throw this.toError(resource, state)
    }
    return state
  }

  private toError(resource: TrafficSettingsResource, state: IResourceReadiness): Error {
    const reasonCode = state.reason_code ?? 'TABLE_MISSING'
    switch (state.state) {
      case 'not_provisioned':
        return TrafficSettingsError.notProvisioned(resource)
      case 'migration_required':
        return TrafficSettingsError.migrationRequired(resource, reasonCode)
      case 'invalid_configuration':
      default:
        return TrafficSettingsError.invalidConfiguration(resource, reasonCode)
    }
  }
}

/** All-not-provisioned readiness, used when the project has no dataset at all. */
export function datasetMissingMeta(projectId: number): IMetaResult {
  const resources = Object.fromEntries(
    TRAFFIC_SETTINGS_RESOURCES.map((resource) => [
      resource,
      readiness('not_provisioned', false, false, 'DATASET_MISSING'),
    ]),
  ) as Record<TrafficSettingsResource, IResourceReadiness>

  return {
    project_id: projectId,
    application: { mode: TRAFFIC_SETTINGS_APPLICATION_MODE, scheduled_query_configured: false },
    resources,
  }
}

/** Kept for the migration script, which reports the same states per resource. */
export type { IResourceProbe }
