import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WRITABLE_COLUMNS } from '@modules/traffic-settings'
import {
  ITEM_SCHEMAS,
  addReferrerHostsBodySchema,
  itemMutationBodySchema,
  previewExcludedUrlParamBodySchema,
  validateBodySchema,
} from './traffic-settings.api.schema'

/**
 * Request-shape rules that protect the user from a silent no-op save.
 *
 * Strictness is the important one. If an unknown key were stripped instead of
 * rejected, a client sending `paramKeyRegex` — or a field renamed in a later
 * version — would receive 200 and believe its change was stored. Rejecting it is
 * the only answer that cannot be misread.
 */

test('an unknown key in a write item is rejected, not ignored', () => {
  const schema = itemMutationBodySchema('excluded-url-params')
  const result = schema.safeParse({
    expected_revision: '5',
    item: { param_key_regex: 'utm_[a-z]+', is_active: true, paramKeyRegex: 'typo' },
  })
  assert.equal(result.success, false)
})

test('read-only fields are rejected inside a write item', () => {
  for (const [resource, readOnlyField] of [
    ['excluded-url-params', 'param_id'],
    ['excluded-url-params', 'is_system'],
    ['traffic-rules', 'rule_id'],
    ['traffic-rules', 'is_system'],
    ['attribution-signal-mappings', 'mapping_id'],
  ] as const) {
    const base: Record<string, unknown> =
      resource === 'excluded-url-params'
        ? { param_key_regex: 'x', is_active: true }
        : resource === 'traffic-rules'
          ? { priority: 1, is_active: true, stage: 'utm', target: 'both', set_source: 'x' }
          : {
              priority: 1,
              is_active: true,
              entity: 'order',
              param_source: 'custom_params',
              mode: 'fallback',
              source_param_key: 'utm_source',
            }

    assert.equal(
      ITEM_SCHEMAS[resource].safeParse({ ...base, [readOnlyField]: 'injected' }).success,
      false,
      `${resource} must reject ${readOnlyField}`,
    )
  }
})

test('an omitted optional field becomes an explicit null', () => {
  // PUT replaces the mutable configuration, so "absent" cannot mean "keep". The
  // schema resolves it here, which keeps `undefined` out of the domain checks and
  // out of the parameterized statements entirely.
  const parsed = ITEM_SCHEMAS['excluded-url-params'].parse({
    param_key_regex: 'utm_[a-z]+',
    is_active: true,
  })
  assert.equal((parsed as { description: unknown }).description, null)

  const rule = ITEM_SCHEMAS['traffic-rules'].parse({
    priority: 1,
    is_active: true,
    stage: 'utm',
    target: 'both',
    set_source: 'google',
  }) as Record<string, unknown>

  for (const column of WRITABLE_COLUMNS['traffic-rules']) {
    assert.notEqual(rule[column], undefined, `${column} must be present after parsing`)
  }
  assert.equal(rule.applies_to_web, null)
  assert.equal(rule.set_traffic_channel, null)
})

test('a parsed item covers exactly the writable columns', () => {
  const rule = ITEM_SCHEMAS['traffic-rules'].parse({
    priority: 1,
    is_active: true,
    stage: 'utm',
    target: 'both',
    set_source: 'google',
  }) as Record<string, unknown>

  assert.deepEqual(
    Object.keys(rule).sort(),
    [...WRITABLE_COLUMNS['traffic-rules']].sort(),
  )
})

test('expected_revision must be an opaque decimal string', () => {
  const schema = itemMutationBodySchema('excluded-url-params')
  const item = { param_key_regex: 'x', is_active: true }

  assert.equal(schema.safeParse({ expected_revision: '12', item }).success, true)
  // A number would work by accident today and break the moment a revision exceeds
  // the safe integer range, so it is refused outright.
  assert.equal(schema.safeParse({ expected_revision: 12, item }).success, false)
  assert.equal(schema.safeParse({ expected_revision: '12.5', item }).success, false)
  assert.equal(schema.safeParse({ item }).success, false)
})

test('a bulk host add must carry at least one host and stay within the limit', () => {
  assert.equal(
    addReferrerHostsBodySchema.safeParse({ expected_revision: '1', hosts: ['example.com'] })
      .success,
    true,
  )
  // Nothing to add is a client bug rather than a state to store: the previous
  // whole-list PUT used an empty array to clear the list, and this endpoint does not.
  assert.equal(
    addReferrerHostsBodySchema.safeParse({ expected_revision: '1', hosts: [] }).success,
    false,
  )
  assert.equal(
    addReferrerHostsBodySchema.safeParse({
      expected_revision: '1',
      hosts: Array.from({ length: 1001 }, (_, index) => `h${index}.example.com`),
    }).success,
    false,
  )
})

test('validate keeps the draft loose so problems are reported per field', () => {
  // The envelope is strict, but a broken draft must come back as a validation
  // result rather than a rejected request — otherwise the editor cannot show the
  // user which field is wrong.
  assert.equal(
    validateBodySchema.safeParse({
      resource: 'traffic-rules',
      item: { stage: 'nonsense', whatever: 1 },
    }).success,
    true,
  )
  assert.equal(
    validateBodySchema.safeParse({ resource: 'unknown-resource', item: {} }).success,
    false,
  )
  assert.equal(
    validateBodySchema.safeParse({ resource: 'traffic-rules', item: {}, extra: 1 }).success,
    false,
  )
})

test('preview accepts a draft with an empty pattern', () => {
  // Preview reports "nothing is excluded" as a warning; rejecting the request
  // would leave the editor with no way to show what normalization alone does.
  assert.equal(
    previewExcludedUrlParamBodySchema.safeParse({
      url: 'https://shop.example/chairs?utm_source=meta',
      item: { param_key_regex: '', is_active: false },
    }).success,
    true,
  )
  assert.equal(
    previewExcludedUrlParamBodySchema.safeParse({
      url: '',
      item: { param_key_regex: 'utm_[a-z]+', is_active: true },
    }).success,
    false,
  )
})
