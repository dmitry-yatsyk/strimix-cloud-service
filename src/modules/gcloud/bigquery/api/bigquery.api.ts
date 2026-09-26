import { BigQuery, BigQueryOptions, Query, TableField } from '@google-cloud/bigquery'
import type {
  ICreateDatasetParams,
  ICreateTableParams,
  ICreateViewParams,
  ICreateScheduledQueryParams,
  IDatasetInfo,
  ITableInfo,
  IScheduledQueryInfo,
  IParameterizedQueryParams,
  IQueryResult,
  ITableMetadata,
  MultiRegionLocation,
} from '../bigquery.interface'
import type { CredentialBody } from 'google-auth-library'
import { DataTransferServiceClient, protos } from '@google-cloud/bigquery-data-transfer'
import {
  hasActiveTransferRun,
  pickLatestTransferRun,
  TRANSFER_RUNS_STATUS_PAGE_SIZE,
} from './transfer-run-status'

type TransferStateEnum = typeof protos.google.cloud.bigquery.datatransfer.v1.TransferState
type ITransferRun = protos.google.cloud.bigquery.datatransfer.v1.ITransferRun
type ITimestamp = protos.google.protobuf.ITimestamp

/**
 * Prefer end time when the run SUCCEEDED; otherwise start time. Returns ISO-8601
 * or null when neither timestamp is present.
 */
function pickTransferRunTimestamp(
  run: ITransferRun,
  TransferState: TransferStateEnum,
): string | null {
  const succeeded = run.state === TransferState.SUCCEEDED
  const raw: ITimestamp | null | undefined =
    succeeded && run.endTime ? run.endTime : run.startTime
  return protobufTimestampToIso(raw)
}

function protobufTimestampToIso(ts: ITimestamp | null | undefined): string | null {
  if (!ts || ts.seconds == null) return null
  const rawSeconds = ts.seconds
  const seconds =
    typeof rawSeconds === 'object' && rawSeconds != null && 'toNumber' in rawSeconds
      ? (rawSeconds as { toNumber: () => number }).toNumber()
      : Number(rawSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const nanos = typeof ts.nanos === 'number' ? ts.nanos : 0
  return new Date(seconds * 1000 + Math.floor(nanos / 1e6)).toISOString()
}

export class BigQueryApi {
  private readonly credentials: CredentialBody
  private readonly location: MultiRegionLocation
  private readonly bigquery: BigQuery
  private readonly bqTransfer: DataTransferServiceClient
  private readonly projectId: string

  constructor({
    projectId,
    datasetLocation,
  }: {
    projectId: string
    datasetLocation: MultiRegionLocation
  }) {
    this.credentials = JSON.parse(process.env.GOOGLE_CLOUD_SERVICE_ACCOUNT as string)
    this.location = datasetLocation
    this.projectId = projectId
    this.bigquery = new BigQuery({
      credentials: this.credentials,
      projectId: projectId,
    })
    this.bqTransfer = new DataTransferServiceClient({
      credentials: this.credentials,
      projectId: projectId,
    })
  }

  /**
   * Creates a new dataset in the specified multi-regional location
   * @param params - Dataset creation parameters
   * @returns Created dataset information
   */
  public async createDataset(params: ICreateDatasetParams): Promise<IDatasetInfo> {
    const { projectId, datasetId, location, description, defaultTableExpirationMs, labels } = params

    const dataset = this.bigquery.dataset(datasetId)

    await dataset.create({
      location,
      description,
      defaultTableExpirationMs: defaultTableExpirationMs?.toString(),
      labels,
    })

    const [metadata] = await dataset.getMetadata()

    return {
      id: dataset.id as string,
      projectId,
      location: metadata.location ?? location,
      createdAt: metadata.creationTime ? new Date(parseInt(metadata.creationTime)) : undefined,
    }
  }

  /**
   * Creates a new table with the specified schema in a dataset
   * @param params - Table creation parameters
   * @returns Created table information
   */
  public async createTable(params: ICreateTableParams): Promise<ITableInfo> {
    const {
      projectId,
      datasetId,
      tableId,
      schema,
      description,
      timePartitioning,
      clustering,
      labels,
    } = params

    const dataset = this.bigquery.dataset(datasetId)

    const options: Record<string, unknown> = {
      schema: {
        fields: schema,
      },
    }

    if (description) {
      options.description = description
    }

    if (timePartitioning) {
      options.timePartitioning = {
        type: timePartitioning.type,
        field: timePartitioning.field,
        expirationMs: timePartitioning.expirationMs,
      }
      if (typeof timePartitioning.requirePartitionFilter !== 'undefined') {
        options.requirePartitionFilter = timePartitioning.requirePartitionFilter
      }
    }

    if (clustering) {
      options.clustering = {
        fields: clustering.fields,
      }
    }

    if (labels) {
      options.labels = labels
    }

    const [table] = await dataset.createTable(tableId, options)
    const metadata = await table.getMetadata()

    return {
      id: table.id as string,
      datasetId,
      projectId,
      createdAt: metadata[0].creationTime
        ? new Date(parseInt(metadata[0].creationTime))
        : undefined,
      type: 'TABLE',
    }
  }

  /**
   * Creates a new view in a dataset
   * @param params - View creation parameters
   * @returns Created view information
   */
  public async createView(params: ICreateViewParams): Promise<ITableInfo> {
    const {
      projectId,
      datasetId,
      viewId,
      query,
      description,
      useLegacySql = false,
      labels,
    } = params

    const dataset = this.bigquery.dataset(datasetId)

    const options: Record<string, unknown> = {
      view: {
        query,
        useLegacySql,
      },
    }

    if (description) {
      options.description = description
    }

    if (labels) {
      options.labels = labels
    }

    const [view] = await dataset.createTable(viewId, options)
    const metadata = await view.getMetadata()

    return {
      id: view.id as string,
      datasetId,
      projectId,
      createdAt: metadata[0].creationTime
        ? new Date(parseInt(metadata[0].creationTime))
        : undefined,
      type: 'VIEW',
    }
  }

  /**
   * Runs an arbitrary SQL statement (e.g. seeding config tables with
   * default rows right after creation)
   * @param query - SQL statement to execute
   */
  public async runQuery(query: string): Promise<void> {
    await this.bigquery.query({ query, location: this.location })
  }

  /**
   * Runs a parameterized statement (or multi-statement script) and returns its
   * rows together with job statistics.
   *
   * Values always travel as query parameters, never as interpolated text, so
   * quotes and backslashes in user-supplied regexes keep their meaning. Table
   * and column identifiers cannot be parameterized in BigQuery, so callers must
   * take them from a fixed allowlist.
   *
   * For a multi-statement script the returned rows are those of the script's
   * last result-producing statement, which is how the transactional CRUD
   * reports the new revision and the affected row counts it asserted.
   */
  public async queryWithParams<TRow = Record<string, unknown>>(
    params: IParameterizedQueryParams,
  ): Promise<IQueryResult<TRow>> {
    const { query, params: values, types, location, dryRun, labels } = params

    const options: Query = {
      query,
      location: location ?? this.location,
      params: values,
      types,
      dryRun,
      labels,
      // Keep INT64 as a plain number: every integer this service reads back is
      // either cast to STRING in SQL (revisions) or bounded well inside the
      // safe range (priorities, row counts).
      wrapIntegers: false,
    }

    const [job] = await this.bigquery.createQueryJob(options)

    if (dryRun) {
      return { rows: [], numDmlAffectedRows: null, jobId: job.id ?? null }
    }

    const [rows] = await job.getQueryResults()
    const affected = job.metadata?.statistics?.query?.numDmlAffectedRows

    return {
      rows: rows as TRow[],
      numDmlAffectedRows: affected == null ? null : Number(affected),
      jobId: job.id ?? null,
    }
  }

  /**
   * Validates a statement without running it: no bytes billed, no side effects.
   * Used to prove that a generated script parses before it is scheduled.
   */
  public async dryRunQuery(params: Omit<IParameterizedQueryParams, 'dryRun'>): Promise<void> {
    await this.queryWithParams({ ...params, dryRun: true })
  }

  /**
   * Reads real table metadata: object type, schema and, for a view, its SQL.
   * Returns null when the object does not exist, which the readiness check
   * reports as `not_provisioned` — a missing table is not an empty list.
   */
  public async getTableMetadata(
    datasetId: string,
    tableId: string,
  ): Promise<ITableMetadata | null> {
    const table = this.bigquery.dataset(datasetId).table(tableId)

    const [exists] = await table.exists()
    if (!exists) {
      return null
    }

    const [metadata] = await table.getMetadata()

    return {
      tableId,
      type: (metadata.type as ITableMetadata['type']) ?? 'UNKNOWN',
      schema: (metadata.schema?.fields ?? []) as TableField[],
      numRows: metadata.numRows == null ? null : Number(metadata.numRows),
      viewQuery: metadata.view?.query ?? null,
      location: metadata.location ?? null,
    }
  }

  /**
   * Adds missing nullable columns to an existing table. Additive-only and
   * idempotent: it never drops, retypes or reorders an existing column, so a
   * schema migration cannot lose configuration.
   */
  public async addMissingColumns(
    datasetId: string,
    tableId: string,
    columns: TableField[],
  ): Promise<void> {
    if (columns.length === 0) {
      return
    }

    const table = this.bigquery.dataset(datasetId).table(tableId)
    const [metadata] = await table.getMetadata()
    const existing: TableField[] = metadata.schema?.fields ?? []
    const existingNames = new Set(existing.map((field) => field.name))

    const additions = columns.filter((column) => !existingNames.has(column.name))
    if (additions.length === 0) {
      return
    }

    await table.setMetadata({
      schema: { fields: [...existing, ...additions.map((c) => ({ ...c, mode: 'NULLABLE' }))] },
    })
  }

  /**
   * Reads the query text and the settings of an existing transfer config.
   * The migration needs them to update only the SQL while preserving schedule,
   * destination dataset, service account and enabled/disabled state.
   *
   * Pass `statusFieldsOnly: true` for attribution job status/health: GetTransferConfig
   * has no request read_mask, so we send the X-Goog-FieldMask system parameter via
   * gax CallOptions and omit `params` (the attribution SQL body). Migration keeps
   * the default full read.
   */
  public async getScheduledQuery(
    name: string,
    options?: { statusFieldsOnly?: boolean },
  ): Promise<{
    name: string
    displayName: string | null
    query: string | null
    schedule: string | null
    destinationDatasetId: string | null
    disabled: boolean
    /** True when auto-scheduling is off (`scheduleOptions.disableAutoScheduling`). */
    disableAutoScheduling: boolean
    /**
     * TransferConfig.state from Data Transfer (TransferState enum number), or
     * null when Google omits it. FAILED (5) surfaces as health ERROR.
     */
    state: number | null
    serviceAccountName: string | null
  } | null> {
    // Health mapping only needs name/state/disabled/scheduleOptions.disableAutoScheduling.
    // Without a mask Google returns the full TransferConfig, including params.query.
    const callOptions = options?.statusFieldsOnly
      ? {
          otherArgs: {
            headers: {
              'x-goog-fieldmask':
                'name,state,disabled,scheduleOptions.disableAutoScheduling',
            },
          },
        }
      : undefined

    const [config] = await this.bqTransfer.getTransferConfig({ name }, callOptions)
    if (!config) {
      return null
    }

    const queryValue = options?.statusFieldsOnly
      ? null
      : config.params?.fields?.query?.stringValue
    const rawState = config.state

    return {
      name: config.name as string,
      displayName: config.displayName ?? null,
      query: queryValue ?? null,
      schedule: config.schedule ?? null,
      destinationDatasetId: config.destinationDatasetId ?? null,
      disabled: Boolean(config.disabled),
      disableAutoScheduling: Boolean(config.scheduleOptions?.disableAutoScheduling),
      state: typeof rawState === 'number' ? rawState : null,
      // Only exposed on the config for some API versions; absent means
      // "unchanged" on update, which is exactly what we want.
      serviceAccountName: (config as { serviceAccountName?: string }).serviceAccountName ?? null,
    }
  }

  /**
   * Replaces ONLY the SQL text of an existing transfer config, via an explicit
   * update mask. Schedule, destination dataset, location, service account and
   * enabled/disabled state are untouched, and the config is never deleted and
   * recreated — its run history and identity survive.
   */
  public async updateScheduledQueryText(name: string, query: string): Promise<void> {
    await this.bqTransfer.updateTransferConfig({
      transferConfig: {
        name,
        params: { fields: { query: { stringValue: query } } },
      },
      updateMask: { paths: ['params'] },
    })
  }

  /**
   * Checks if a dataset exists
   * @param projectId - GCP Project ID
   * @param datasetId - Dataset ID to check
   * @returns True if dataset exists, false otherwise
   */
  public async datasetExists(datasetId: string): Promise<boolean> {
    const [exists] = await this.bigquery.dataset(datasetId).exists()
    return exists
  }

  /**
   * Checks if a table or view exists
   * @param datasetId - Dataset ID
   * @param tableId - Table or View ID to check
   * @returns True if table/view exists, false otherwise
   */
  public async tableExists(datasetId: string, tableId: string): Promise<boolean> {
    const [exists] = await this.bigquery.dataset(datasetId).table(tableId).exists()
    return exists
  }

  /**
   * Finds Scheduled Query by displayName
   * Prevents duplicate creation
   */
  public async findScheduledQueryByName(displayName: string): Promise<{
    exists: boolean
    configId?: string
    name?: string
  }> {
    const parent = `projects/${this.projectId}/locations/${this.location}`

    const [configs] = await this.bqTransfer.listTransferConfigs({ parent })
    const found = configs.find((config) => config.displayName === displayName)
    if (found && found.name) {
      return {
        exists: true,
        name: found.name,
        configId: found.name.split('/').pop(),
      }
    }

    return { exists: false }
  }

  /**
   * Deletes a Scheduled Query (transfer config) by its full resource name,
   * e.g. `projects/{id}/locations/{loc}/transferConfigs/{configId}`.
   * Used to remove the legacy per-connector jobs after they were merged
   * into the single update-costs-and-calculate-attribution job.
   */
  public async deleteScheduledQuery(name: string): Promise<void> {
    await this.bqTransfer.deleteTransferConfig({ name })
  }

  /**
   * Starts one manual run of an existing scheduled query (transfer config).
   * Uses BigQuery Data Transfer `startManualTransferRuns` against the stored
   * transfer config resource name — not `jobs.insert` / a one-shot query job.
   *
   * `requestedRunTime` must be in the past per the Data Transfer API; we pass
   * "now" truncated to whole seconds, which Google accepts as a run-now trigger
   * for scheduled queries.
   */
  public async startScheduledQueryManualRun(name: string): Promise<void> {
    // Data Transfer requires requestedRunTime in the past; one second ago is the
    // conventional "run now" trigger for scheduled queries.
    const runTimeSeconds = Math.floor(Date.now() / 1000) - 1
    await this.bqTransfer.startManualTransferRuns({
      parent: name,
      requestedRunTime: { seconds: runTimeSeconds },
    })
  }

  /**
   * Returns whether the scheduled query currently has an active (PENDING or
   * RUNNING) transfer run. Status is read live from Google Cloud — never from
   * Mongo.
   */
  public async isScheduledQueryRunActive(name: string): Promise<boolean> {
    const status = await this.getScheduledQueryRunStatus(name)
    return status.running
  }

  /**
   * Live run status for a scheduled query (transfer config), read from Google
   * Cloud Data Transfer — never from Mongo.
   *
   * Single unfiltered listTransferRuns (pageSize 10): derive `running` from any
   * PENDING/RUNNING in the page, and `last_run_at` / `latest_run_state` from the
   * newest run by startTime (proto does not guarantee list order).
   *
   * - `running`: true when any PENDING or RUNNING transfer run exists.
   * - `last_run_at`: ISO-8601 of the newest run by start time. Prefers end
   *   time when that run SUCCEEDED; otherwise start time. Null when there
   *   are no runs.
   * - `latest_run_state`: TransferState of that newest run (number), or null.
   */
  public async getScheduledQueryRunStatus(name: string): Promise<{
    running: boolean
    last_run_at: string | null
    latest_run_state: number | null
  }> {
    const TransferState = protos.google.cloud.bigquery.datatransfer.v1.TransferState

    const [runs] = await this.bqTransfer.listTransferRuns({
      parent: name,
      pageSize: TRANSFER_RUNS_STATUS_PAGE_SIZE,
    })
    const list = Array.isArray(runs) ? runs : []
    const running = hasActiveTransferRun(list)
    const latest = pickLatestTransferRun(list)
    const rawLatestState = latest?.state

    return {
      running,
      last_run_at: latest ? pickTransferRunTimestamp(latest, TransferState) : null,
      latest_run_state: typeof rawLatestState === 'number' ? rawLatestState : null,
    }
  }

  public async createScheduledQuery(
    params: ICreateScheduledQueryParams,
  ): Promise<IScheduledQueryInfo> {
    const {
      datasetId,
      displayName,
      query,
      schedule,
      location,
      startNow = true,
      endTime,
      disabled = false,
      serviceAccountName,
    } = params

    const parent = `projects/${this.projectId}/locations/${location}`

    const transferConfig: Record<string, unknown> = {
      displayName,
      dataSourceId: 'scheduled_query',
      schedule,
      disabled,
      params: {
        fields: {
          query: { stringValue: query },
        },
      },
    }

    if (datasetId != null) {
      transferConfig.destinationDatasetId = datasetId
    }

    if (!startNow || endTime) {
      const scheduleOptions: Record<string, unknown> = {}
      if (!startNow) scheduleOptions.disableAutoScheduling = true
      if (endTime) scheduleOptions.endTime = { seconds: Math.floor(endTime.getTime() / 1000) }
      transferConfig.scheduleOptions = scheduleOptions
    }

    const request: Record<string, unknown> = { parent, transferConfig }
    if (serviceAccountName) request.serviceAccountName = serviceAccountName

    const [config] = await this.bqTransfer.createTransferConfig(request)

    const name = config.name as string
    const configId = name.split('/').pop() as string

    return { name, configId, displayName: config.displayName as string }
  }
}
