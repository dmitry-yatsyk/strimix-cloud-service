import { protos } from '@google-cloud/bigquery-data-transfer'

type ITransferRun = protos.google.cloud.bigquery.datatransfer.v1.ITransferRun
type ITimestamp = protos.google.protobuf.ITimestamp

const TransferState = protos.google.cloud.bigquery.datatransfer.v1.TransferState

/** Numeric google.cloud.bigquery.datatransfer.v1.TransferState value. */
export type TransferStateNumber = protos.google.cloud.bigquery.datatransfer.v1.TransferState

export const ACTIVE_TRANSFER_STATES: readonly TransferStateNumber[] = [
  TransferState.PENDING,
  TransferState.RUNNING,
]

export const FINISHED_TRANSFER_STATES: readonly TransferStateNumber[] = [
  TransferState.SUCCEEDED,
  TransferState.FAILED,
  TransferState.CANCELLED,
]

/** Finished runs fetched in one page to pick the most recent one from. */
export const FINISHED_TRANSFER_RUNS_PAGE_SIZE = 20

function isKnownTransferState(value: number): value is TransferStateNumber {
  return Number.isInteger(value) && typeof (TransferState as Record<number, unknown>)[value] === 'string'
}

/**
 * Normalizes a TransferState to its numeric enum value, or null when unknown.
 *
 * google-gax loads protos with `enums: String`, so TransferRun.state and
 * TransferConfig.state arrive as names ('RUNNING', 'FAILED', ...) at runtime even
 * though the typings also allow numbers.
 */
export function normalizeTransferState(state: unknown): TransferStateNumber | null {
  if (state == null) return null
  if (typeof state === 'number') {
    return isKnownTransferState(state) ? state : null
  }
  if (typeof state !== 'string') return null

  const trimmed = state.trim()
  if (trimmed === '') return null
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed)
    return isKnownTransferState(numeric) ? numeric : null
  }
  if (Object.prototype.hasOwnProperty.call(TransferState, trimmed)) {
    const value = (TransferState as unknown as Record<string, unknown>)[trimmed]
    return typeof value === 'number' && isKnownTransferState(value) ? value : null
  }
  return null
}

/** Seconds may be a number, a string (`longs: String`) or a Long-like object. */
export function protobufTimestampToMs(ts: ITimestamp | null | undefined): number | null {
  if (!ts || ts.seconds == null) return null
  const rawSeconds = ts.seconds
  const seconds =
    typeof rawSeconds === 'object' && rawSeconds != null && 'toNumber' in rawSeconds
      ? (rawSeconds as { toNumber: () => number }).toNumber()
      : Number(rawSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const nanos = Number(ts.nanos ?? 0)
  return seconds * 1000 + Math.floor((Number.isFinite(nanos) ? nanos : 0) / 1e6)
}

export function protobufTimestampToIso(ts: ITimestamp | null | undefined): string | null {
  const ms = protobufTimestampToMs(ts)
  return ms == null ? null : new Date(ms).toISOString()
}

export function isActiveTransferRun(run: ITransferRun): boolean {
  const state = normalizeTransferState(run.state)
  return state != null && ACTIVE_TRANSFER_STATES.includes(state)
}

/** Recency of a finished run: endTime, then startTime, runTime, scheduleTime. */
export function finishedTransferRunRecencyMs(run: ITransferRun): number {
  return (
    protobufTimestampToMs(run.endTime) ??
    protobufTimestampToMs(run.startTime) ??
    protobufTimestampToMs(run.runTime) ??
    protobufTimestampToMs(run.scheduleTime) ??
    0
  )
}

/** Most recent run by finishedTransferRunRecencyMs. Null when empty. */
export function pickLatestFinishedTransferRun(
  runs: readonly ITransferRun[] | null | undefined,
): ITransferRun | null {
  if (!Array.isArray(runs) || runs.length === 0) return null

  let latest = runs[0]
  let latestMs = finishedTransferRunRecencyMs(latest)
  for (let i = 1; i < runs.length; i++) {
    const candidate = runs[i]
    const ms = finishedTransferRunRecencyMs(candidate)
    if (ms > latestMs) {
      latest = candidate
      latestMs = ms
    }
  }
  return latest
}

/** ISO-8601 of the run's endTime, else startTime. Null when neither is set. */
export function transferRunLastRunAt(run: ITransferRun): string | null {
  return protobufTimestampToIso(run.endTime) ?? protobufTimestampToIso(run.startTime)
}
