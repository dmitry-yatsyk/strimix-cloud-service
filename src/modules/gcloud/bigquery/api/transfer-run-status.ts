import type { protos } from '@google-cloud/bigquery-data-transfer'

type ITransferRun = protos.google.cloud.bigquery.datatransfer.v1.ITransferRun
type ITimestamp = protos.google.protobuf.ITimestamp

/** PENDING / RUNNING — matches Data Transfer TransferState enum numbers. */
export const TRANSFER_STATE_PENDING = 2
export const TRANSFER_STATE_RUNNING = 3

/**
 * Enough runs to cover a concurrent active run plus recent finished ones when
 * listTransferRuns is unfiltered. Status only needs "any active?" + "latest".
 */
export const TRANSFER_RUNS_STATUS_PAGE_SIZE = 10

function protobufTimestampToMs(ts: ITimestamp | null | undefined): number | null {
  if (!ts || ts.seconds == null) return null
  const rawSeconds = ts.seconds
  const seconds =
    typeof rawSeconds === 'object' && rawSeconds != null && 'toNumber' in rawSeconds
      ? (rawSeconds as { toNumber: () => number }).toNumber()
      : Number(rawSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const nanos = typeof ts.nanos === 'number' ? ts.nanos : 0
  return seconds * 1000 + Math.floor(nanos / 1e6)
}

/**
 * Sort key for "most recent" transfer run. ListTransferRuns order is not
 * documented in the proto; existing client comments claim newest-first by start
 * time, but we still pick max by timestamp so pageSize > 1 stays correct.
 */
export function transferRunRecencyMs(run: ITransferRun): number {
  return (
    protobufTimestampToMs(run.startTime) ??
    protobufTimestampToMs(run.runTime) ??
    protobufTimestampToMs(run.scheduleTime) ??
    0
  )
}

export function isActiveTransferRun(run: ITransferRun): boolean {
  return run.state === TRANSFER_STATE_PENDING || run.state === TRANSFER_STATE_RUNNING
}

/** Newest run by startTime (then runTime / scheduleTime). Null when empty. */
export function pickLatestTransferRun(runs: readonly ITransferRun[]): ITransferRun | null {
  if (!Array.isArray(runs) || runs.length === 0) return null

  let latest = runs[0]
  let latestMs = transferRunRecencyMs(latest)
  for (let i = 1; i < runs.length; i++) {
    const candidate = runs[i]
    const ms = transferRunRecencyMs(candidate)
    if (ms > latestMs) {
      latest = candidate
      latestMs = ms
    }
  }
  return latest
}

export function hasActiveTransferRun(runs: readonly ITransferRun[]): boolean {
  return Array.isArray(runs) && runs.some(isActiveTransferRun)
}
