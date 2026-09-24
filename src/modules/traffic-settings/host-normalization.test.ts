import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  diffStoredHostList,
  normalizeHost,
  normalizeHostList,
  splitHostInput,
} from './host-normalization'

/**
 * These cases exist because every one of them is a way for a referrer exclusion to
 * look correct in the UI and never match anything at run time. The attribution job
 * compares a stored value against the referrer HOST, so `https://example.com/`
 * stored verbatim excludes nothing at all — silently, and for as long as nobody
 * checks the report.
 */

function expectAccepted(input: string, expected: string): void {
  const { host, error } = normalizeHost(input, 'hosts[0]')
  assert.equal(error, null, `${input} should be accepted`)
  assert.equal(host, expected)
}

function expectRejected(input: string, code: string): void {
  const { host, error } = normalizeHost(input, 'hosts[0]')
  assert.equal(host, null, `${input} should be rejected`)
  assert.equal(error?.code, code, `${input} should be rejected with ${code}`)
}

test('normalization is trim, lower case, punycode and one trailing dot', () => {
  expectAccepted('  Example.COM  ', 'example.com')
  expectAccepted('example.com.', 'example.com')
  expectAccepted('WWW.Example.com', 'www.example.com')
  // An internationalized domain has to be stored the way the job will see it.
  expectAccepted('пример.рф', 'xn--e1afmkfd.xn--p1ai')
  expectAccepted('München.de', 'xn--mnchen-3ya.de')
})

test('a subdomain is its own entry and is never folded into the parent', () => {
  expectAccepted('mail.example.com', 'mail.example.com')
  const { hosts } = normalizeHostList(['example.com', 'mail.example.com'])
  assert.deepEqual(hosts, ['example.com', 'mail.example.com'])
})

test('anything that is not a bare hostname is rejected with a specific reason', () => {
  expectRejected('https://example.com', 'HOST_CONTAINS_SCHEME')
  expectRejected('example.com/path', 'HOST_CONTAINS_PATH')
  expectRejected('example.com?a=1', 'HOST_CONTAINS_QUERY_OR_FRAGMENT')
  expectRejected('example.com#top', 'HOST_CONTAINS_QUERY_OR_FRAGMENT')
  expectRejected('user@example.com', 'HOST_CONTAINS_USERINFO')
  expectRejected('*.example.com', 'HOST_CONTAINS_WILDCARD')
  expectRejected('example.com:8080', 'HOST_CONTAINS_PORT')
  expectRejected('exa mple.com', 'HOST_CONTAINS_WHITESPACE')
  expectRejected('', 'HOST_EMPTY')
})

test('IP addresses and single-label hosts are refused rather than half-supported', () => {
  expectRejected('127.0.0.1', 'HOST_IS_IP_ADDRESS')
  expectRejected('localhost', 'HOST_SINGLE_LABEL')
})

test('structurally invalid hosts are refused', () => {
  expectRejected('.example.com', 'HOST_EMPTY_LABEL')
  expectRejected('example..com', 'HOST_EMPTY_LABEL')
  expectRejected('-example.com', 'HOST_INVALID_LABEL')
  expectRejected('example-.com', 'HOST_INVALID_LABEL')
  expectRejected(`${'a'.repeat(64)}.com`, 'HOST_LABEL_TOO_LONG')
})

test('the stored list is de-duplicated after normalization, not before', () => {
  // These three inputs are one host. Reporting it as a removed duplicate is the
  // difference between "your list shrank" and "your list shrank and here is why".
  const outcome = normalizeHostList(['Example.com', 'example.com.', '  EXAMPLE.COM  '])
  assert.deepEqual(outcome.hosts, ['example.com'])
  assert.equal(outcome.errors.length, 0)
  assert.equal(outcome.duplicates.length, 2)
  assert.equal(outcome.warnings[0]?.code, 'HOSTS_DUPLICATES_REMOVED')
})

test('an empty list is a valid state meaning "exclude nothing"', () => {
  const outcome = normalizeHostList([])
  assert.deepEqual(outcome.hosts, [])
  assert.equal(outcome.errors.length, 0)
})

test('the list order is deterministic regardless of input order', () => {
  const ascending = normalizeHostList(['b.example.com', 'a.example.com', 'c.example.com'])
  const descending = normalizeHostList(['c.example.com', 'b.example.com', 'a.example.com'])
  assert.deepEqual(ascending.hosts, descending.hosts)
})

test('a rejected entry is reported against its own index', () => {
  const outcome = normalizeHostList(['good.example.com', 'https://bad.example.com'])
  assert.deepEqual(outcome.hosts, ['good.example.com'])
  assert.equal(outcome.errors.length, 1)
  assert.equal(outcome.errors[0].field, 'hosts[1]')
})

test('the count limit is enforced', () => {
  const tooMany = Array.from({ length: 1001 }, (_, index) => `h${index}.example.com`)
  const outcome = normalizeHostList(tooMany)
  assert.ok(outcome.errors.some((issue) => issue.code === 'HOSTS_LIMIT_EXCEEDED'))
})

test('pasted input splits on newlines, commas and semicolons', () => {
  assert.deepEqual(splitHostInput('a.example.com\nb.example.com, c.example.com; d.example.com'), [
    'a.example.com',
    'b.example.com',
    'c.example.com',
    'd.example.com',
  ])
  assert.deepEqual(splitHostInput('\n\n a.example.com \n\n'), ['a.example.com'])
})

test('an already normalized stored list is reported as unchanged', () => {
  const diff = diffStoredHostList(['a.example.com', 'b.example.com'])
  assert.equal(diff.unchanged, true)
  assert.deepEqual(diff.changed, [])
  assert.deepEqual(diff.rejected, [])
})

test('a stored list that normalization would alter is reported, not altered', () => {
  // This is what stops the migration: converting the legacy view here would change
  // which referrers count as referral traffic, and that is not a migration's call.
  const diff = diffStoredHostList(['Example.COM', 'https://bad.example.com'])
  assert.equal(diff.unchanged, false)
  assert.deepEqual(diff.changed, [{ from: 'Example.COM', to: 'example.com' }])
  assert.equal(diff.rejected.length, 1)
})
