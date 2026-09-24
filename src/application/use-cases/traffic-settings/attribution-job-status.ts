/**
 * Health-chip mapping for the attribution scheduled query (BigQuery Data Transfer).
 * Kept free of Google / Mongo I/O so it can be unit-tested in isolation.
 */

/** Same health enum as identification jobs / Facebook cost-export chips. */
export type AttributionJobHealthStatus = 'ACTIVE' | 'PAUSED' | 'ERROR'

/** google.cloud.bigquery.datatransfer.v1.TransferState.FAILED */
const TRANSFER_STATE_FAILED = 5

function isTransferFailed(state: number | string | null | undefined): boolean {
  if (state == null) return false
  return state === TRANSFER_STATE_FAILED || state === 'FAILED'
}

/**
 * Maps BigQuery Data Transfer config + latest run into the shared health chip
 * enum (ACTIVE / PAUSED / ERROR). Does not invent states beyond those three.
 *
 * - `disabled` or `disableAutoScheduling` → PAUSED (stopped family)
 * - config `state` FAILED or latest run FAILED → ERROR
 * - otherwise (enabled scheduled query) → ACTIVE
 *
 * A currently PENDING/RUNNING transfer is still ACTIVE health; callers keep
 * `running` separate for the "running now" line.
 */
export function mapAttributionJobHealthStatus(input: {
  disabled: boolean
  disableAutoScheduling: boolean
  configState: number | string | null | undefined
  latestRunState: number | string | null | undefined
}): AttributionJobHealthStatus {
  if (input.disabled || input.disableAutoScheduling) {
    return 'PAUSED'
  }
  if (isTransferFailed(input.configState) || isTransferFailed(input.latestRunState)) {
    return 'ERROR'
  }
  return 'ACTIVE'
}
