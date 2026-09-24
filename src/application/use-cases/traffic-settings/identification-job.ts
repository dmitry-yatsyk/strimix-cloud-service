import {
  IdentificationJobRepository,
  IDENTIFICATION_JOB_SETTABLE_STATUSES,
  type IdentificationJobSettableStatus,
  type IIdentificationJob,
} from '@modules/identification-service'
import { runIdentificationCloudRunJob } from '@modules/identification-service/identification-service.client'
import { TrafficSettingsError } from '@modules/traffic-settings'

/**
 * Manual start and Mongo-backed status of the project's identification job.
 *
 * Status and `is_running` live in the existing `identification_jobs` collection
 * (one document per project). CMS never writes `is_running` — only the identity
 * Cloud Run Job module does. CMS may update `status` to ACTIVE or PAUSED.
 *
 * Manual start calls Cloud Run Jobs API `runJob` (`:run`) with a per-execution
 * PROJECT_ID container env override — it does not mutate the job template.
 *
 * These endpoints NEVER create an `identification_jobs` document, Cloud Run
 * Job, or project_resources row. Provisioning belongs only to
 * deploy-project-resources.
 */

export interface IIdentificationJobView {
  project_id: number
  is_running: boolean
  status: IIdentificationJob['status']
  last_run: number
  error_spec: IIdentificationJob['error_spec']
  /**
   * False when no Mongo `identification_jobs` document exists for this project.
   * Status/run must not invent one — GET reports not-configured; POST run 404s.
   */
  configured: boolean
}

export interface IIdentificationJobRunResult extends IIdentificationJobView {
  /** True when this call successfully started a Cloud Run Job execution. */
  started: boolean
}

function toView(doc: {
  project_id: number
  is_running: boolean
  status: IIdentificationJob['status']
  last_run: number
  error_spec?: IIdentificationJob['error_spec'] | null
}): IIdentificationJobView {
  return {
    project_id: doc.project_id,
    is_running: doc.is_running === true,
    status: doc.status,
    last_run: typeof doc.last_run === 'number' ? doc.last_run : 0,
    error_spec: doc.error_spec ?? null,
    configured: true,
  }
}

/** Soft not-configured payload for GET — never inserts a Mongo document. */
function notConfiguredView(projectId: number): IIdentificationJobView {
  return {
    project_id: projectId,
    is_running: false,
    status: 'PAUSED',
    last_run: 0,
    error_spec: null,
    configured: false,
  }
}

async function requireJob(projectId: number) {
  const doc = await IdentificationJobRepository.findOne({ project_id: projectId }).lean()

  if (!doc) {
    throw TrafficSettingsError.identificationJobNotFound()
  }

  return doc
}

/**
 * Reads the identification job document for one project from Mongo.
 *
 * When the document is missing, returns a not-configured / not-running view
 * without creating one.
 */
export async function getIdentificationJobStatus(
  projectId: number,
): Promise<IIdentificationJobView> {
  const doc = await IdentificationJobRepository.findOne({ project_id: projectId }).lean()

  if (!doc) {
    return notConfiguredView(projectId)
  }

  return toView(doc)
}

/**
 * Starts a manual identity-resolution Cloud Run Job execution for one project.
 *
 * Refuses with IDENTIFICATION_JOB_NOT_FOUND when no document exists (does not
 * create one). Refuses a second start while `is_running` is true. Does not write
 * `is_running` — the identity module sets it when the execution begins.
 */
export async function runIdentificationJob(
  projectId: number,
): Promise<IIdentificationJobRunResult> {
  const doc = await requireJob(projectId)

  if (doc.is_running === true) {
    throw TrafficSettingsError.identificationJobAlreadyRunning()
  }

  await runIdentificationCloudRunJob(projectId)

  const after = await IdentificationJobRepository.findOne({ project_id: projectId }).lean()
  const view = toView(after ?? doc)

  return {
    ...view,
    // Optimistic: Jobs.run accepted; poll will converge on Mongo `is_running`.
    is_running: true,
    started: true,
  }
}

/**
 * Updates only the job `status` field (ACTIVE or PAUSED). Never touches
 * `is_running`. Used to recover from ERROR the same way Facebook cost-export
 * jobs toggle ACTIVE / STOPPED — here STOPPED maps to PAUSED.
 *
 * Refuses with IDENTIFICATION_JOB_NOT_FOUND when no document exists (does not
 * create one).
 */
export async function updateIdentificationJobStatus(
  projectId: number,
  status: IdentificationJobSettableStatus,
): Promise<IIdentificationJobView> {
  if (!(IDENTIFICATION_JOB_SETTABLE_STATUSES as readonly string[]).includes(status)) {
    throw TrafficSettingsError.identificationJobInvalidStatus(status)
  }

  const doc = await requireJob(projectId)

  await IdentificationJobRepository.updateOne({ _id: doc._id }, { $set: { status } })

  return toView({ ...doc, status })
}
