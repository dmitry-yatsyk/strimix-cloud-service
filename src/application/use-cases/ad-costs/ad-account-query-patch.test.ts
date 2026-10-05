import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UPDATE_COSTS_AND_CALCULATE_ATTRIBUTION_TEMPLATE } from '@modules/gcloud/bigquery'
import { AD_ACCOUNT_PATCH_MARKER, addAdAccountColumnsToQuery } from './ad-account-query-patch'

test('the attribution template already has the ad account columns', () => {
  assert.equal(
    UPDATE_COSTS_AND_CALCULATE_ATTRIBUTION_TEMPLATE.split(AD_ACCOUNT_PATCH_MARKER).length - 1,
    3,
  )
})

test('a query of an unexpected shape is not patched', () => {
  assert.throws(() => addAdAccountColumnsToQuery('select 1'), /table reference not found/)
  // Patching twice would duplicate the columns: the anchors are already changed
  assert.throws(() => addAdAccountColumnsToQuery(UPDATE_COSTS_AND_CALCULATE_ATTRIBUTION_TEMPLATE))
})
