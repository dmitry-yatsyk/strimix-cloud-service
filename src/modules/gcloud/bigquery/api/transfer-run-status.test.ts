import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  hasActiveTransferRun,
  pickLatestTransferRun,
  TRANSFER_STATE_PENDING,
  TRANSFER_STATE_RUNNING,
} from './transfer-run-status'

const SUCCEEDED = 4

test('hasActiveTransferRun is true when any PENDING/RUNNING exists', () => {
  assert.equal(
    hasActiveTransferRun([
      { state: SUCCEEDED, startTime: { seconds: 100 } },
      { state: TRANSFER_STATE_RUNNING, startTime: { seconds: 90 } },
    ]),
    true,
  )
  assert.equal(
    hasActiveTransferRun([{ state: SUCCEEDED, startTime: { seconds: 100 } }]),
    false,
  )
  assert.equal(hasActiveTransferRun([]), false)
})

test('pickLatestTransferRun picks max by startTime even if not first', () => {
  const older = { state: SUCCEEDED, startTime: { seconds: 50 } }
  const newer = { state: TRANSFER_STATE_PENDING, startTime: { seconds: 200 } }
  const mid = { state: SUCCEEDED, startTime: { seconds: 100 } }

  assert.equal(pickLatestTransferRun([older, newer, mid]), newer)
  assert.equal(pickLatestTransferRun([newer, older]), newer)
  assert.equal(pickLatestTransferRun([]), null)
})

test('pickLatestTransferRun falls back to runTime when startTime missing', () => {
  const byRunTime = { state: SUCCEEDED, runTime: { seconds: 300 } }
  const byStart = { state: SUCCEEDED, startTime: { seconds: 100 } }
  assert.equal(pickLatestTransferRun([byStart, byRunTime]), byRunTime)
})
