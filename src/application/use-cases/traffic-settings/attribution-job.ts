import { HttpException } from '@presentation/exceptions/http.exception'
import { TrafficSettingsError } from '@modules/traffic-settings'
import { openTrafficSettingsSession } from './traffic-settings.session'
import {
  mapAttributionJobHealthStatus,
  type AttributionJobHealthStatus,
} from './attribution-job-status'

export type { AttributionJobHealthStatus }
export { mapAttributionJobHealthStatus }

/**
 * Manual start and live status of the project's attribution scheduled query.
 *
 * The transfer config resource name is read from the existing
 * `project_resources.gcloud.bigquery.scheduled_queries.update_costs_and_calculate_attribution`
 * field. Status is never persisted in Mongo — every call asks Google Cloud.
 *
 * These endpoints NEVER create a scheduled query, transfer config, or
 * project_resources document. Provisioning belongs only to deploy-project-resources.
 */

export interface IAttributionJobStatus {
  project_id: number
  /** True when Google reports a PENDING or RUNNING transfer run. */
  running: boolean
  /**
   * ISO-8601 timestamp of the most recent transfer run (newest by start time).
   * Prefers end time when that run SUCCEEDED; otherwise start time. Null when
   * there are no runs, or when the transfer config is not configured.
   */
  last_run_at: string | null
  /**
   * Health chip value derived from TransferConfig + latest TransferRun.
   * Matches identification job `status` (ACTIVE | PAUSED | ERROR).
   */
  status: AttributionJobHealthStatus
  /**
   * False when the scheduled query (or project resources) is missing.
   * GET returns this soft view without creating anything; POST run still 409.
   */
  configured: boolean
}

export interface IAttributionJobRunResult extends IAttributionJobStatus {
  /** True when this call started a new run; false when one was already active. */
  started: boolean
}

/** Codes that mean "this project has no attribution job to ask about". */
const NOT_CONFIGURED_CODES = new Set([
  'TRAFFIC_SETTINGS_ATTRIBUTION_JOB_NOT_CONFIGURED',
  'TRAFFIC_SETTINGS_PROJECT_RESOURCES_NOT_FOUND',
  'TRAFFIC_SETTINGS_NOT_PROVISIONED',
])

function isNotConfiguredError(error: unknown): boolean {
  return error instanceof HttpException && NOT_CONFIGURED_CODES.has(error.code)
}

function notConfiguredStatus(projectId: number): IAttributionJobStatus {
  return {
    project_id: projectId,
    running: false,
    last_run_at: null,
    status: 'PAUSED',
    configured: false,
  }
}

async function requireScheduledQueryName(projectId: number) {
  const session = await openTrafficSettingsSession(projectId)
  const name = session.context.scheduledQueryName

  if (!name) {
    throw TrafficSettingsError.attributionJobNotConfigured()
  }

  return { session, name }
}

async function readLiveStatus(
  projectId: number,
  session: Awaited<ReturnType<typeof openTrafficSettingsSession>>,
  name: string,
): Promise<IAttributionJobStatus> {
  const [config, runStatus] = await Promise.all([
    session.bigqueryApi.getScheduledQuery(name, { statusFieldsOnly: true }),
    session.bigqueryApi.getScheduledQueryRunStatus(name),
  ])

  if (!config) {
    return notConfiguredStatus(projectId)
  }

  const { running, last_run_at, latest_run_state } = runStatus

  return {
    project_id: projectId,
    running,
    last_run_at,
    status: mapAttributionJobHealthStatus({
      disabled: config.disabled,
      disableAutoScheduling: config.disableAutoScheduling,
      configState: config.state,
      latestRunState: latest_run_state,
    }),
    configured: true,
  }
}

/**
 * Live status of the attribution scheduled query for one project.
 *
 * When the scheduled query (or project resources) is missing, returns a soft
 * not-configured payload — never inserts or calls Google create APIs.
 */
export async function getAttributionJobStatus(projectId: number): Promise<IAttributionJobStatus> {
  try {
    const { session, name } = await requireScheduledQueryName(projectId)
    return await readLiveStatus(projectId, session, name)
  } catch (error) {
    if (isNotConfiguredError(error)) {
      return notConfiguredStatus(projectId)
    }
    throw error
  }
}

/**
 * Starts a manual transfer run of the attribution scheduled query.
 *
 * If the scheduled query is not registered, refuses with
 * ATTRIBUTION_JOB_NOT_CONFIGURED (does not create one). If a run is already
 * PENDING or RUNNING, refuses with ATTRIBUTION_JOB_ALREADY_RUNNING.
 */
export async function runAttributionJob(projectId: number): Promise<IAttributionJobRunResult> {
  const { session, name } = await requireScheduledQueryName(projectId)
  const alreadyRunning = await session.bigqueryApi.isScheduledQueryRunActive(name)

  if (alreadyRunning) {
    throw TrafficSettingsError.attributionJobAlreadyRunning()
  }

  await session.bigqueryApi.startScheduledQueryManualRun(name)

  // Re-read after start so last_run_at / status reflect what Google reports.
  const live = await readLiveStatus(projectId, session, name)

  return {
    ...live,
    running: true,
    started: true,
  }
}
