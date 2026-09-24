import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  missingReferrerTableAction,
  referrerConversionBlocksAttributionRefresh,
} from './migrate-traffic-settings'

test('a skipped referrer conversion must not refresh the attribution query', () => {
  assert.equal(referrerConversionBlocksAttributionRefresh('skipped'), true)
  assert.equal(referrerConversionBlocksAttributionRefresh('done'), false)
  assert.equal(referrerConversionBlocksAttributionRefresh('already_current'), false)
  assert.equal(referrerConversionBlocksAttributionRefresh('planned'), false)
})

test('a missing main table with a leftover temp table resumes the rename', () => {
  assert.equal(missingReferrerTableAction(true), 'resume_rename')
  assert.equal(missingReferrerTableAction(false), 'create_empty')
})
