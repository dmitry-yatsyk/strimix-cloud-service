import { randomUUID } from 'node:crypto'
import type {
  BigQueryApi,
  IParameterizedQueryParams,
  IQueryResult,
  QueryParameterTypes,
  QueryParameterValues,
} from '@modules/gcloud/bigquery'
import {
  CUSTOM_ID_PREFIX,
  RESOURCE_REVISION_KEYS,
  TRAFFIC_RULE_STAGE_SORT_ORDER,
  TRAFFIC_SETTINGS_LIMITS,
  type TrafficSettingsItemResource,
  type TrafficSettingsResource,
} from './traffic-settings.constants'
import { READABLE_COLUMNS, WRITABLE_COLUMNS, columnParameterType, idColumnOf } from './column-types'
import { qualifiedTableRef } from './project-context'
import type {
  IProjectBigQueryContext,
  ITrafficSettingsActor,
  TrafficSettingsItemInput,
} from './traffic-settings.interface'
import {
  EXCLUDED_URL_PARAM_PATTERNS_PARAM,
  buildActiveExcludedUrlParamPatternsQuery,
  buildUrlPreviewQuery,
} from './url-normalization.sql-helper'

/**
 * BigQuery access layer of the traffic and attribution settings.
 *
 * Two rules hold for every statement in this file:
 *  - values travel as query parameters, never as interpolated text, so a quote or
 *    a backslash inside a user regex cannot change the statement;
 *  - identifiers come from the project record and the schema-derived allowlists
 *    in `column-types.ts`, never from request keys. BigQuery cannot parameterize
 *    an identifier, so the allowlist is the substitute.
 *
 * Every mutation is ONE multi-statement transaction that bumps the collection
 * revision and writes the domain row together. A stale `expected_revision` makes
 * the conditional revision update match no row, which aborts the whole
 * transaction — so a lost update is impossible without relying on a per-process
 * mutex, which would be worthless across Cloud Run instances anyway.
 */

/** Result protocol of the mutation scripts below. */
type MutationOutcome =
  | 'OK'
  | 'REVISION_CONFLICT'
  | 'NOT_FOUND'
  | 'DUPLICATE_ID'
  | 'PRIORITY_CONFLICT'
  | 'HOST_CONFLICT'
  | 'LIMIT_EXCEEDED'
  | 'AFFECTED_ROWS_MISMATCH'

interface IMutationScriptRow {
  outcome: MutationOutcome
  current_revision: string | null
  conflicting_ids: string[] | null
  /** Values the statement deliberately did not write, e.g. hosts already listed. */
  skipped_values: string[] | null
  affected: number | null
}

export interface IMutationScriptResult {
  outcome: MutationOutcome
  currentRevision: string | null
  conflictingIds: string[]
  skippedValues: string[]
  affected: number
}

/** BigQuery returns absent values as undefined; the API contract uses null. */
function normalizeReadValue(value: unknown): unknown {
  if (value === undefined) {
    return null
  }
  // Wrapped integers are not requested, but a defensive unwrap keeps SDK objects
  // out of API responses if that default ever changes.
  if (value !== null && typeof value === 'object' && 'value' in (value as object)) {
    const inner = (value as { value: unknown }).value
    return typeof inner === 'string' && /^-?\d+$/.test(inner) ? Number(inner) : inner
  }
  return value
}

function normalizeRow<TItem>(row: Record<string, unknown>, columns: readonly string[]): TItem {
  const item: Record<string, unknown> = {}
  for (const column of columns) {
    item[column] = normalizeReadValue(row[column])
  }
  return item as TItem
}

/** `ORDER BY` clause implementing the contract's deterministic order. */
function orderByClause(resource: TrafficSettingsItemResource): string {
  switch (resource) {
    case 'traffic-rules':
      return `case t.stage ${Object.entries(TRAFFIC_RULE_STAGE_SORT_ORDER)
        .map(([stage, position]) => `when '${stage}' then ${position}`)
        .join(' ')} else 99 end, t.priority, t.rule_id`
    case 'attribution-signal-mappings':
      return 't.priority, t.mapping_id'
    // A domain list is read alphabetically; the id breaks ties only in the
    // impossible case of a duplicate host slipping past the uniqueness check.
    case 'excluded-referrers':
      return 't.host, t.referrer_id'
    case 'excluded-url-params':
    default:
      return 't.param_id'
  }
}

export class TrafficSettingsRepository {
  private readonly context: IProjectBigQueryContext
  private readonly bigqueryApi: BigQueryApi
  private readonly isDryRun: boolean

  /**
   * With `isDryRun` every statement is validated by BigQuery against the real
   * dataset and never executed, so reads come back empty and writes change
   * nothing. It exists for the release check, which has to exercise the exact
   * SQL this class sends rather than a copy of it.
   */
  constructor(
    context: IProjectBigQueryContext,
    bigqueryApi: BigQueryApi,
    options: { isDryRun?: boolean } = {},
  ) {
    this.context = context
    this.bigqueryApi = bigqueryApi
    this.isDryRun = options.isDryRun === true
  }

  private async runQuery<TRow>(
    params: Omit<IParameterizedQueryParams, 'dryRun'>,
  ): Promise<IQueryResult<TRow>> {
    return this.bigqueryApi.queryWithParams<TRow>({ ...params, dryRun: this.isDryRun })
  }

  private revisionsTableRef(): string {
    return qualifiedTableRef(this.context, this.context.revisionsTableId)
  }

  private tableRef(resource: TrafficSettingsResource): string {
    const tableId = this.context.tableIds[resource]
    if (!tableId) {
      throw new Error(`Traffic settings resource "${resource}" is not provisioned`)
    }
    return qualifiedTableRef(this.context, tableId)
  }

  /**
   * Reads the whole collection AND its revision in ONE query, so the two come
   * from the same snapshot. Two separate queries could return rows from before a
   * concurrent write and a revision from after it, handing the client a value
   * that would later be accepted for a stale draft.
   *
   * Both are read through `array_agg` rather than scalar subqueries so that a
   * duplicated revision row is reported as a diagnosable state instead of
   * failing the query with "more than one row".
   */
  public async readCollection<TItem>(
    resource: TrafficSettingsItemResource,
  ): Promise<{ items: TItem[]; revisions: string[] }> {
    const columns = READABLE_COLUMNS[resource]
    const query = `select
  (select array_agg(cast(revision as string) order by revision)
   from ${this.revisionsTableRef()}
   where resource = @resource) as revisions,
  (select array_agg(struct(${columns.map((c) => `t.${c}`).join(', ')}) order by ${orderByClause(resource)})
   from ${this.tableRef(resource)} as t) as items`

    const { rows } = await this.runQuery<{
      revisions: string[] | null
      items: Array<Record<string, unknown>> | null
    }>({
      query,
      params: { resource: RESOURCE_REVISION_KEYS[resource] },
      types: { resource: 'STRING' },
    })

    const row = rows[0]
    return {
      items: (row?.items ?? []).map((item) => normalizeRow<TItem>(item, columns)),
      revisions: row?.revisions ?? [],
    }
  }

  /** Active exclusion patterns, in the same order and with the same filter as the job. */
  public async readActiveExcludedUrlParamPatterns(): Promise<string[]> {
    const tableId = this.context.tableIds['excluded-url-params']
    if (!tableId) {
      throw new Error('Traffic settings resource "excluded-url-params" is not provisioned')
    }

    const { rows } = await this.runQuery<{ patterns: string[] | null }>({
      query: buildActiveExcludedUrlParamPatternsQuery(
        this.context.gcpProjectId,
        this.context.datasetId,
        tableId,
      ),
    })
    return rows[0]?.patterns ?? []
  }

  /** Counts occurrences of an id. More than one is a diagnosable state, never a mass update. */
  public async countItemsWithId(
    resource: TrafficSettingsItemResource,
    id: string,
  ): Promise<number> {
    const query = `select count(*) as occurrences
from ${this.tableRef(resource)}
where ${idColumnOf(resource)} = @item_id`

    const { rows } = await this.runQuery<{ occurrences: number }>({
      query,
      params: { item_id: id },
      types: { item_id: 'STRING' },
    })
    return Number(rows[0]?.occurrences ?? 0)
  }

  /**
   * Server-side URL preview. Runs the SAME normalization SQL as the attribution
   * job against a single supplied URL, with the draft's pattern bound as the
   * one-element pattern array. It reads no stored rows and no raw events, and it
   * never fetches the address.
   */
  public async previewUrl(
    url: string,
    patterns: string[],
  ): Promise<{
    normalized_landing_page: string | null
    excluded_keys: string[]
    retained_keys: string[]
  }> {
    const { rows } = await this.runQuery<{
      normalized_landing_page: string | null
      excluded_keys: string[] | null
      retained_keys: string[] | null
    }>({
      query: buildUrlPreviewQuery(),
      params: { url, [EXCLUDED_URL_PARAM_PATTERNS_PARAM]: patterns },
      types: { url: 'STRING', [EXCLUDED_URL_PARAM_PATTERNS_PARAM]: ['STRING'] },
    })

    const row = rows[0]
    return {
      normalized_landing_page: row?.normalized_landing_page ?? null,
      excluded_keys: row?.excluded_keys ?? [],
      retained_keys: row?.retained_keys ?? [],
    }
  }

  /**
   * Shared skeleton of every mutation.
   *
   * Order inside the transaction matters:
   *  1. bump the revision conditionally — this is the concurrency guard, and it
   *     must happen before anything else so two writers cannot both proceed;
   *  2. read the new revision, still inside the transaction;
   *  3. run the caller's checks against the current collection state;
   *  4. run the caller's DML and assert it touched exactly the intended rows;
   *  5. commit, or roll every step back and re-read the true current revision so
   *     the client receives an actionable conflict.
   *
   * The script ends in a single SELECT, which is what BigQuery returns for a
   * multi-statement script, so the outcome and the resulting revision come from
   * the very execution that performed the write.
   */
  private buildMutationScript(bodySql: string): string {
    return `begin

declare revision_updated int64 default 0;
declare current_revision string default null;
declare target_count int64 default 0;
declare affected int64 default 0;
declare conflicting_ids array<string> default [];
declare skipped_values array<string> default [];
declare outcome string default 'OK';

begin transaction;

-- Concurrency guard: the update matches a row only while the caller's revision is
-- still current. Zero matched rows means somebody else wrote first.
update ${this.revisionsTableRef()}
set revision = revision + 1,
    updated_at = current_timestamp(),
    updated_by = @actor_id
where resource = @resource
  and cast(revision as string) = @expected_revision;

set revision_updated = @@row_count;

if revision_updated <> 1 then
  set outcome = 'REVISION_CONFLICT';
else
  set current_revision = (
    select cast(revision as string)
    from ${this.revisionsTableRef()}
    where resource = @resource
  );

${bodySql}
end if;

if outcome = 'OK' then
  commit transaction;
else
  rollback transaction;
  -- After the rollback this is the genuinely current value, which is what the
  -- client needs in order to reload and resolve the conflict.
  set current_revision = (
    select cast(min(revision) as string)
    from ${this.revisionsTableRef()}
    where resource = @resource
  );
end if;

select outcome, current_revision, conflicting_ids, skipped_values, affected;

end;`
  }

  private async runMutationScript(
    bodySql: string,
    resource: TrafficSettingsResource,
    expectedRevision: string,
    actor: ITrafficSettingsActor,
    extraParams: QueryParameterValues = {},
    extraTypes: QueryParameterTypes = {},
  ): Promise<IMutationScriptResult> {
    const { rows } = await this.runQuery<IMutationScriptRow>({
      query: this.buildMutationScript(bodySql),
      params: {
        resource: RESOURCE_REVISION_KEYS[resource],
        expected_revision: expectedRevision,
        actor_id: actor.actorId,
        ...extraParams,
      },
      types: {
        resource: 'STRING',
        expected_revision: 'STRING',
        actor_id: 'STRING',
        ...extraTypes,
      },
    })

    const row = rows[0]
    return {
      outcome: row?.outcome ?? 'AFFECTED_ROWS_MISMATCH',
      currentRevision: row?.current_revision ?? null,
      conflictingIds: row?.conflicting_ids ?? [],
      skippedValues: row?.skipped_values ?? [],
      affected: Number(row?.affected ?? 0),
    }
  }

  /**
   * Builds the parameter name, value and type triples for a writable column set.
   * Every value is explicitly typed because BigQuery cannot infer the type of a
   * null, and null is a meaningful value for almost every column here.
   */
  private buildColumnParameters(
    resource: TrafficSettingsItemResource,
    input: Record<string, unknown>,
  ): {
    columns: string[]
    placeholders: string[]
    assignments: string[]
    params: QueryParameterValues
    types: QueryParameterTypes
  } {
    const columns: string[] = []
    const placeholders: string[] = []
    const assignments: string[] = []
    const params: QueryParameterValues = {}
    const types: QueryParameterTypes = {}

    for (const column of WRITABLE_COLUMNS[resource]) {
      const parameterName = `col_${column}`
      columns.push(column)
      placeholders.push(`@${parameterName}`)
      assignments.push(`${column} = @${parameterName}`)
      // An absent optional field is null, not "leave unchanged": PUT is a full
      // replacement of the mutable configuration.
      params[parameterName] = input[column] === undefined ? null : input[column]
      types[parameterName] = columnParameterType(resource, column)
    }

    return { columns, placeholders, assignments, params, types }
  }

  /**
   * Checks whether activating a rule at a given priority would create a NEW
   * conflict with another active rule of the same stage whose target overlaps.
   * `both` overlaps `visit` and `ad_cost`; `visit` and `ad_cost` do not overlap
   * each other. Pre-existing conflicts are deliberately not considered here, so a
   * legacy configuration stays repairable.
   */
  private priorityConflictCheckSql(excludeSelf: boolean): string {
    return `  set conflicting_ids = ifnull((
    select array_agg(rule_id order by rule_id)
    from ${this.tableRef('traffic-rules')}
    where is_active = true
      and stage = @col_stage
      and priority = @col_priority
      and (target = @col_target or target = 'both' or @col_target = 'both')
      ${excludeSelf ? 'and rule_id <> @item_id' : ''}
  ), []);

  if @col_is_active = true and array_length(conflicting_ids) > 0 then
    set outcome = 'PRIORITY_CONFLICT';
  end if;
`
  }

  /**
   * Checks whether a host is already listed. Unlike a priority clash this holds
   * regardless of `is_active`: a disabled row still owns its domain, and a second
   * row for the same host would leave it ambiguous which one an operator edits.
   * Hosts are normalized before they reach here, so plain equality is enough.
   */
  private hostConflictCheckSql(excludeSelf: boolean): string {
    return `  set conflicting_ids = ifnull((
    select array_agg(referrer_id order by referrer_id)
    from ${this.tableRef('excluded-referrers')}
    where host = @col_host
      ${excludeSelf ? 'and referrer_id <> @item_id' : ''}
  ), []);

  if array_length(conflicting_ids) > 0 then
    set outcome = 'HOST_CONFLICT';
  end if;
`
  }

  /** Collection-level invariants of one resource, asserted inside the transaction. */
  private collectionChecksSql(resource: TrafficSettingsItemResource, excludeSelf: boolean): string {
    switch (resource) {
      case 'traffic-rules':
        return this.priorityConflictCheckSql(excludeSelf)
      case 'excluded-referrers':
        return this.hostConflictCheckSql(excludeSelf)
      default:
        return ''
    }
  }

  public async createItem<TItem>(
    resource: TrafficSettingsItemResource,
    input: TrafficSettingsItemInput,
    expectedRevision: string,
    actor: ITrafficSettingsActor,
  ): Promise<{ result: IMutationScriptResult; generatedId: string }> {
    const idColumn = idColumnOf(resource)
    // The server owns identity: a client never supplies an id, and never supplies
    // is_system, which is false for everything created through the API.
    const generatedId = `${CUSTOM_ID_PREFIX}${randomUUID()}`
    const hasIsSystem = READABLE_COLUMNS[resource].includes('is_system')

    const { columns, placeholders, params, types } = this.buildColumnParameters(
      resource,
      input as Record<string, unknown>,
    )

    const insertColumns = [idColumn, ...columns, ...(hasIsSystem ? ['is_system'] : [])]
    const valueList = ['@item_id', ...placeholders, ...(hasIsSystem ? ['false'] : [])]

    const checks = this.collectionChecksSql(resource, false)

    const body = `${checks}
  if outcome = 'OK' then
    insert into ${this.tableRef(resource)} (${insertColumns.join(', ')})
    values (${valueList.join(', ')});

    set affected = @@row_count;

    -- The generated id must be unique inside the project. A collision, or an
    -- insert that produced anything other than one row, aborts the transaction.
    set target_count = (
      select count(*) from ${this.tableRef(resource)} where ${idColumn} = @item_id
    );

    if affected <> 1 then
      set outcome = 'AFFECTED_ROWS_MISMATCH';
    elseif target_count <> 1 then
      set outcome = 'DUPLICATE_ID';
    end if;
  end if;`

    const result = await this.runMutationScript(
      body,
      resource,
      expectedRevision,
      actor,
      { ...params, item_id: generatedId },
      { ...types, item_id: 'STRING' },
    )

    return { result, generatedId }
  }

  public async replaceItem(
    resource: TrafficSettingsItemResource,
    id: string,
    input: TrafficSettingsItemInput,
    expectedRevision: string,
    actor: ITrafficSettingsActor,
  ): Promise<IMutationScriptResult> {
    const idColumn = idColumnOf(resource)
    const { assignments, params, types } = this.buildColumnParameters(
      resource,
      input as Record<string, unknown>,
    )

    const checks = this.collectionChecksSql(resource, true)

    // `is_system` is deliberately absent from the assignment list: editing a
    // system row keeps its origin, it does not turn it into a custom one.
    const body = `  set target_count = (
    select count(*) from ${this.tableRef(resource)} where ${idColumn} = @item_id
  );

  if target_count = 0 then
    set outcome = 'NOT_FOUND';
  elseif target_count > 1 then
    set outcome = 'DUPLICATE_ID';
  end if;

  if outcome = 'OK' then
${checks}
  end if;

  if outcome = 'OK' then
    update ${this.tableRef(resource)}
    set ${assignments.join(',\n        ')}
    where ${idColumn} = @item_id;

    set affected = @@row_count;

    if affected <> 1 then
      set outcome = 'AFFECTED_ROWS_MISMATCH';
    end if;
  end if;`

    return this.runMutationScript(
      body,
      resource,
      expectedRevision,
      actor,
      { ...params, item_id: id },
      { ...types, item_id: 'STRING' },
    )
  }

  public async setItemActive(
    resource: TrafficSettingsItemResource,
    id: string,
    isActive: boolean,
    expectedRevision: string,
    actor: ITrafficSettingsActor,
  ): Promise<IMutationScriptResult> {
    const idColumn = idColumnOf(resource)

    // Enabling a rule can create a priority conflict, so the check runs with the
    // row's own stage/priority/target read inside the transaction. Disabling can
    // only remove conflicts and is therefore always allowed — that is what makes
    // a legacy conflicting configuration fixable.
    const enableCheck =
      resource === 'traffic-rules'
        ? `    if @is_active = true then
      set conflicting_ids = ifnull((
        select array_agg(other.rule_id order by other.rule_id)
        from ${this.tableRef(resource)} as other
        join ${this.tableRef(resource)} as self
          on self.${idColumn} = @item_id
        where other.rule_id <> @item_id
          and other.is_active = true
          and other.stage = self.stage
          and other.priority = self.priority
          and (other.target = self.target or other.target = 'both' or self.target = 'both')
      ), []);

      if array_length(conflicting_ids) > 0 then
        set outcome = 'PRIORITY_CONFLICT';
      end if;
    end if;
`
        : ''

    const body = `  set target_count = (
    select count(*) from ${this.tableRef(resource)} where ${idColumn} = @item_id
  );

  if target_count = 0 then
    set outcome = 'NOT_FOUND';
  elseif target_count > 1 then
    set outcome = 'DUPLICATE_ID';
  end if;

  if outcome = 'OK' then
${enableCheck}  end if;

  if outcome = 'OK' then
    update ${this.tableRef(resource)}
    set is_active = @is_active
    where ${idColumn} = @item_id;

    set affected = @@row_count;

    if affected <> 1 then
      set outcome = 'AFFECTED_ROWS_MISMATCH';
    end if;
  end if;`

    return this.runMutationScript(
      body,
      resource,
      expectedRevision,
      actor,
      { item_id: id, is_active: isActive },
      { item_id: 'STRING', is_active: 'BOOL' },
    )
  }

  public async deleteItem(
    resource: TrafficSettingsItemResource,
    id: string,
    expectedRevision: string,
    actor: ITrafficSettingsActor,
  ): Promise<IMutationScriptResult> {
    const idColumn = idColumnOf(resource)

    // Deleting a system row is allowed and permanent: the deploy use case and the
    // attribution job never re-insert seeds, so it does not come back.
    const body = `  set target_count = (
    select count(*) from ${this.tableRef(resource)} where ${idColumn} = @item_id
  );

  if target_count = 0 then
    set outcome = 'NOT_FOUND';
  elseif target_count > 1 then
    set outcome = 'DUPLICATE_ID';
  end if;

  if outcome = 'OK' then
    delete from ${this.tableRef(resource)}
    where ${idColumn} = @item_id;

    set affected = @@row_count;

    if affected <> 1 then
      set outcome = 'AFFECTED_ROWS_MISMATCH';
    end if;
  end if;`

    return this.runMutationScript(
      body,
      resource,
      expectedRevision,
      actor,
      { item_id: id },
      { item_id: 'STRING' },
    )
  }

  /**
   * Adds several referrer hosts in one transaction.
   *
   * Hosts already on the list are skipped rather than rejected: pasting a set of
   * own domains that partly overlaps the current list is the normal way this
   * resource is filled, and failing the whole call would leave the operator to
   * diff it by hand. Which ones were skipped travels back in `skippedValues`, so
   * the UI can say so instead of silently adding fewer rows than asked.
   *
   * The row limit is asserted inside the transaction: a single call is capped by
   * the request schema, but repeated calls are not, and the job scans this table
   * on every run.
   */
  public async createReferrers(
    hosts: string[],
    expectedRevision: string,
    actor: ITrafficSettingsActor,
  ): Promise<IMutationScriptResult> {
    const tableRef = this.tableRef('excluded-referrers')

    const body = `  set skipped_values = ifnull((
    select array_agg(distinct host order by host)
    from unnest(@hosts) as host
    where host in (select host from ${tableRef})
  ), []);

  insert into ${tableRef} (referrer_id, host, is_active, description)
  select concat(@id_prefix, generate_uuid()), host, true, null
  from (select distinct host from unnest(@hosts) as host)
  where host not in (select host from ${tableRef});

  set affected = @@row_count;

  set target_count = (select count(*) from ${tableRef});

  if target_count > @max_rows then
    set outcome = 'LIMIT_EXCEEDED';
  end if;`

    return this.runMutationScript(
      body,
      'excluded-referrers',
      expectedRevision,
      actor,
      { hosts, id_prefix: CUSTOM_ID_PREFIX, max_rows: TRAFFIC_SETTINGS_LIMITS.HOSTS_MAX_COUNT },
      { hosts: ['STRING'], id_prefix: 'STRING', max_rows: 'INT64' },
    )
  }

  /** Reads one row by id, used by detail reads and by validate's context check. */
  public async readItem<TItem>(
    resource: TrafficSettingsItemResource,
    id: string,
  ): Promise<{ items: TItem[]; revisions: string[] }> {
    const columns = READABLE_COLUMNS[resource]
    const query = `select
  (select array_agg(cast(revision as string) order by revision)
   from ${this.revisionsTableRef()}
   where resource = @resource) as revisions,
  (select array_agg(struct(${columns.map((c) => `t.${c}`).join(', ')}))
   from ${this.tableRef(resource)} as t
   where t.${idColumnOf(resource)} = @item_id) as items`

    const { rows } = await this.runQuery<{
      revisions: string[] | null
      items: Array<Record<string, unknown>> | null
    }>({
      query,
      params: { resource: RESOURCE_REVISION_KEYS[resource], item_id: id },
      types: { resource: 'STRING', item_id: 'STRING' },
    })

    const row = rows[0]
    return {
      items: (row?.items ?? []).map((item) => normalizeRow<TItem>(item, columns)),
      revisions: row?.revisions ?? [],
    }
  }
}
