import type { TableField } from '@google-cloud/bigquery'

export type MultiRegionLocation = 'EU' | 'US'

export interface ICreateDatasetParams {
  projectId: string
  datasetId: string
  location: MultiRegionLocation
  description?: string
  defaultTableExpirationMs?: number
  labels?: Record<string, string>
}

export interface ICreateTableParams {
  projectId: string
  datasetId: string
  tableId: string
  schema: TableField[]
  description?: string
  timePartitioning?: {
    type: 'DAY' | 'HOUR' | 'MONTH' | 'YEAR'
    field?: string
    expirationMs?: number
    requirePartitionFilter?: boolean
  }
  clustering?: {
    fields: string[]
  }
  labels?: Record<string, string>
}

export interface ICreateViewParams {
  projectId: string
  datasetId: string
  viewId: string
  query: string
  description?: string
  useLegacySql?: boolean
  labels?: Record<string, string>
}

export interface IDatasetInfo {
  id: string
  projectId: string
  location: string
  createdAt?: Date
}

export interface ITableInfo {
  id: string
  datasetId: string
  projectId: string
  createdAt?: Date
  type: 'TABLE' | 'VIEW' | 'EXTERNAL'
}

export interface ICreateScheduledQueryParams {
  /** Optional. Omit for script queries (BEGIN/END, DML) - scripts cannot have destination table */
  datasetId?: string
  displayName: string
  query: string
  schedule: string
  /** BigQuery multi-region location (EU, US) - must match dataset location */
  location: MultiRegionLocation
  startNow?: boolean
  endTime?: Date
  disabled?: boolean
  serviceAccountName?: string
}

export interface IScheduledQueryInfo {
  name: string
  configId: string
  displayName: string
}

/**
 * Named query parameter values. `null` is allowed and REQUIRES an entry in
 * `types`: BigQuery cannot infer the type of a null, and an empty array is
 * bound as NULL, so its element type has to be declared as well.
 */
export type QueryParameterValues = Record<string, unknown>

/**
 * Explicit parameter types, in the shape the BigQuery client expects:
 * `'STRING'`, `'INT64'`, `'BOOL'`, `['STRING']` for `ARRAY<STRING>`. Mirrors the
 * SDK's recursive `QueryParamTypeStruct` so it can be passed straight through.
 */
export type QueryParameterTypes = {
  [name: string]: string | string[] | QueryParameterTypes | QueryParameterTypes[]
}

export interface IParameterizedQueryParams {
  query: string
  params?: QueryParameterValues
  types?: QueryParameterTypes
  /** Overrides the instance location; must match the dataset location. */
  location?: MultiRegionLocation
  /** Validates the statement without executing it and without cost. */
  dryRun?: boolean
  labels?: Record<string, string>
}

export interface IQueryResult<TRow> {
  rows: TRow[]
  /**
   * Rows changed by the statement. For a multi-statement script this is the
   * total across its DML statements, so per-statement counts have to be
   * asserted inside the script itself.
   */
  numDmlAffectedRows: number | null
  jobId: string | null
}

export interface ITableMetadata {
  tableId: string
  type: 'TABLE' | 'VIEW' | 'EXTERNAL' | 'MATERIALIZED_VIEW' | 'SNAPSHOT' | 'UNKNOWN'
  schema: TableField[]
  numRows: number | null
  /** SQL text of a view definition, present only for views. */
  viewQuery: string | null
  location: string | null
}
