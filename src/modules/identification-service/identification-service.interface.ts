/**
 * Identification (identity resolution) job document stored in Mongo.
 *
 * One document per project. The identity Cloud Run module owns `is_running`
 * and may set `status` to ERROR; CMS only reads the document and may update
 * `status` to ACTIVE or PAUSED when recovering from ERROR (or toggling).
 */

const IDENTIFICATION_JOB_STATUSES = ['PAUSED', 'ACTIVE', 'ERROR'] as const

type IdentificationJobStatus = (typeof IDENTIFICATION_JOB_STATUSES)[number]

/** Statuses an operator may set through CMS (never ERROR — that is module-owned). */
const IDENTIFICATION_JOB_SETTABLE_STATUSES = ['PAUSED', 'ACTIVE'] as const

type IdentificationJobSettableStatus = (typeof IDENTIFICATION_JOB_SETTABLE_STATUSES)[number]

interface IIdentificationJob {
  id: string
  project_id: number
  is_running: boolean
  status: IdentificationJobStatus
  last_run: number
  error_spec: null | Record<string, unknown>
}

export type {
  IIdentificationJob,
  IdentificationJobStatus,
  IdentificationJobSettableStatus,
}
export { IDENTIFICATION_JOB_STATUSES, IDENTIFICATION_JOB_SETTABLE_STATUSES }
