import assert from 'node:assert/strict'
import { test } from 'node:test'
import { protos } from '@google-cloud/bigquery-data-transfer'
import {
  isActiveTransferRun,
  normalizeTransferState,
  pickLatestFinishedTransferRun,
  protobufTimestampToIso,
  transferRunLastRunAt,
} from './transfer-run-status'

const TransferState = protos.google.cloud.bigquery.datatransfer.v1.TransferState

test('normalizeTransferState maps numbers, numeric strings and enum names', () => {
  assert.equal(normalizeTransferState(3), TransferState.RUNNING)
  assert.equal(normalizeTransferState(5), TransferState.FAILED)
  assert.equal(normalizeTransferState('2'), TransferState.PENDING)
  assert.equal(normalizeTransferState('4'), TransferState.SUCCEEDED)
  assert.equal(normalizeTransferState('PENDING'), 2)
  assert.equal(normalizeTransferState('RUNNING'), 3)
  assert.equal(normalizeTransferState('SUCCEEDED'), 4)
  assert.equal(normalizeTransferState('FAILED'), 5)
  assert.equal(normalizeTransferState('CANCELLED'), 6)
})

test('normalizeTransferState returns null for missing or unknown values', () => {
  assert.equal(normalizeTransferState(null), null)
  assert.equal(normalizeTransferState(undefined), null)
  assert.equal(normalizeTransferState(''), null)
  assert.equal(normalizeTransferState(1), null)
  assert.equal(normalizeTransferState('99'), null)
  assert.equal(normalizeTransferState('BOGUS'), null)
  assert.equal(normalizeTransferState('toString'), null)
})

test('isActiveTransferRun accepts numeric and string TransferState', () => {
  assert.equal(isActiveTransferRun({ state: 2 }), true)
  assert.equal(isActiveTransferRun({ state: 'RUNNING' }), true)
  assert.equal(isActiveTransferRun({ state: 'PENDING' }), true)
  assert.equal(isActiveTransferRun({ state: 'SUCCEEDED' }), false)
  assert.equal(isActiveTransferRun({ state: 5 }), false)
  assert.equal(isActiveTransferRun({}), false)
})

test('pickLatestFinishedTransferRun prefers endTime regardless of list order', () => {
  const older = { state: 'SUCCEEDED' as const, startTime: { seconds: 500 }, endTime: { seconds: 600 } }
  const newer = { state: 'FAILED' as const, startTime: { seconds: 400 }, endTime: { seconds: 900 } }
  assert.equal(pickLatestFinishedTransferRun([older, newer]), newer)
  assert.equal(pickLatestFinishedTransferRun([newer, older]), newer)
  assert.equal(pickLatestFinishedTransferRun([]), null)
  assert.equal(pickLatestFinishedTransferRun(null), null)
})

test('pickLatestFinishedTransferRun falls back to startTime, then runTime', () => {
  const byStart = { state: 'CANCELLED' as const, startTime: { seconds: 300 } }
  const byEnd = { state: 'SUCCEEDED' as const, endTime: { seconds: 200 } }
  assert.equal(pickLatestFinishedTransferRun([byEnd, byStart]), byStart)

  const byRunTime = { state: 'SUCCEEDED' as const, runTime: { seconds: 400 } }
  assert.equal(pickLatestFinishedTransferRun([byStart, byRunTime]), byRunTime)
})

test('protobufTimestampToIso handles number, string and Long-like seconds', () => {
  const iso = '2026-01-01T00:00:00.500Z'
  const seconds = Date.parse('2026-01-01T00:00:00Z') / 1000
  assert.equal(protobufTimestampToIso({ seconds, nanos: 500_000_000 }), iso)
  assert.equal(protobufTimestampToIso({ seconds: String(seconds), nanos: 500_000_000 }), iso)
  const longLike = { toNumber: () => seconds } as unknown as protos.google.protobuf.ITimestamp['seconds']
  assert.equal(protobufTimestampToIso({ seconds: longLike, nanos: 500_000_000 }), iso)
  assert.equal(protobufTimestampToIso(null), null)
  assert.equal(protobufTimestampToIso({}), null)
})

test('transferRunLastRunAt uses endTime, else startTime', () => {
  assert.equal(
    transferRunLastRunAt({ startTime: { seconds: '100' }, endTime: { seconds: '200' } }),
    new Date(200_000).toISOString(),
  )
  assert.equal(
    transferRunLastRunAt({ state: 'FAILED', startTime: { seconds: '100' } }),
    new Date(100_000).toISOString(),
  )
  assert.equal(transferRunLastRunAt({}), null)
})
