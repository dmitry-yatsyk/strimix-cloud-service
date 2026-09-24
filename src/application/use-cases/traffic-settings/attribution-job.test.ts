import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapAttributionJobHealthStatus } from './attribution-job-status'

/** google.cloud.bigquery.datatransfer.v1.TransferState */
const TransferState = {
  PENDING: 2,
  RUNNING: 3,
  SUCCEEDED: 4,
  FAILED: 5,
  CANCELLED: 6,
} as const

test('enabled config with successful latest run → ACTIVE', () => {
  assert.equal(
    mapAttributionJobHealthStatus({
      disabled: false,
      disableAutoScheduling: false,
      configState: TransferState.SUCCEEDED,
      latestRunState: TransferState.SUCCEEDED,
    }),
    'ACTIVE',
  )
})

test('enabled config with no runs yet → ACTIVE', () => {
  assert.equal(
    mapAttributionJobHealthStatus({
      disabled: false,
      disableAutoScheduling: false,
      configState: null,
      latestRunState: null,
    }),
    'ACTIVE',
  )
})

test('PENDING/RUNNING latest run stays ACTIVE health (running is separate)', () => {
  assert.equal(
    mapAttributionJobHealthStatus({
      disabled: false,
      disableAutoScheduling: false,
      configState: TransferState.RUNNING,
      latestRunState: TransferState.PENDING,
    }),
    'ACTIVE',
  )
})

test('disabled transfer config → PAUSED', () => {
  assert.equal(
    mapAttributionJobHealthStatus({
      disabled: true,
      disableAutoScheduling: false,
      configState: TransferState.SUCCEEDED,
      latestRunState: TransferState.SUCCEEDED,
    }),
    'PAUSED',
  )
})

test('schedule auto-scheduling disabled → PAUSED', () => {
  assert.equal(
    mapAttributionJobHealthStatus({
      disabled: false,
      disableAutoScheduling: true,
      configState: TransferState.SUCCEEDED,
      latestRunState: TransferState.SUCCEEDED,
    }),
    'PAUSED',
  )
})

test('disabled wins over FAILED latest run → PAUSED', () => {
  assert.equal(
    mapAttributionJobHealthStatus({
      disabled: true,
      disableAutoScheduling: false,
      configState: TransferState.FAILED,
      latestRunState: TransferState.FAILED,
    }),
    'PAUSED',
  )
})

test('latest run FAILED → ERROR', () => {
  assert.equal(
    mapAttributionJobHealthStatus({
      disabled: false,
      disableAutoScheduling: false,
      configState: TransferState.SUCCEEDED,
      latestRunState: TransferState.FAILED,
    }),
    'ERROR',
  )
})

test('config state FAILED → ERROR', () => {
  assert.equal(
    mapAttributionJobHealthStatus({
      disabled: false,
      disableAutoScheduling: false,
      configState: TransferState.FAILED,
      latestRunState: TransferState.SUCCEEDED,
    }),
    'ERROR',
  )
})

test('string FAILED also maps to ERROR', () => {
  assert.equal(
    mapAttributionJobHealthStatus({
      disabled: false,
      disableAutoScheduling: false,
      configState: null,
      latestRunState: 'FAILED',
    }),
    'ERROR',
  )
})

test('CANCELLED latest run is not ERROR → ACTIVE', () => {
  assert.equal(
    mapAttributionJobHealthStatus({
      disabled: false,
      disableAutoScheduling: false,
      configState: TransferState.CANCELLED,
      latestRunState: TransferState.CANCELLED,
    }),
    'ACTIVE',
  )
})
