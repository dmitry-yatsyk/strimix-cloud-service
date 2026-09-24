import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UPDATE_COSTS_AND_CALCULATE_ATTRIBUTION_TEMPLATE } from '@modules/gcloud/bigquery'
import {
  EXCLUDED_URL_PARAM_KEY_EXPRESSION,
  EXCLUDED_URL_PARAM_PATTERNS_PARAM,
  EXCLUDED_URL_PARAM_RETAIN_PREDICATE,
  buildUrlPreviewQuery,
} from './url-normalization.sql-helper'

/**
 * Guards the one invariant this feature cannot survive without: the exclusion
 * logic in the scheduled query and the logic behind the UI preview must be the
 * same logic.
 *
 * If they drift, the product lies to the user — the preview says a parameter is
 * removed from the landing page and the nightly job keeps it, or the other way
 * round, and nobody notices until a report is wrong. The test compares the
 * whitespace-normalized text rather than bytes, because the template is indented
 * to its surrounding query while the helper emits its own indentation; everything
 * that affects the SQL's meaning still has to match exactly.
 */

/** Collapses runs of whitespace so indentation differences do not count. */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

const NORMALIZED_TEMPLATE = normalizeSql(UPDATE_COSTS_AND_CALCULATE_ATTRIBUTION_TEMPLATE)
const NORMALIZED_PREDICATE = normalizeSql(EXCLUDED_URL_PARAM_RETAIN_PREDICATE)

test('the retain predicate appears in both branches of the attribution job', () => {
  // Two occurrences, not one: visits and ad_costs each build their own
  // landing_page, and a fix applied to only one of them produces two different
  // normalizations of the same URL.
  assert.equal(
    countOccurrences(NORMALIZED_TEMPLATE, NORMALIZED_PREDICATE),
    2,
    'the shared exclusion predicate must appear in the visits branch and the ad_costs branch',
  )
})

test('the preview query uses the same retain predicate as the job', () => {
  const preview = normalizeSql(buildUrlPreviewQuery())
  assert.ok(
    preview.includes(NORMALIZED_PREDICATE),
    'the preview must evaluate exclusions with the predicate the job uses',
  )
})

test('both branches bind the patterns as a query parameter', () => {
  assert.equal(
    countOccurrences(
      NORMALIZED_TEMPLATE,
      `execute immediate (query) using ${EXCLUDED_URL_PARAM_PATTERNS_PARAM} as ${EXCLUDED_URL_PARAM_PATTERNS_PARAM}`,
    ),
    2,
    'patterns must travel as a bound array parameter in both branches',
  )
})

test('the key is extracted rather than matched inside the whole pair', () => {
  // The original defect: the wrapper was matched against the whole `key=value`
  // token, which made an anchored pattern such as `^fbclid$` impossible to satisfy.
  assert.ok(
    NORMALIZED_TEMPLATE.includes(normalizeSql(EXCLUDED_URL_PARAM_KEY_EXPRESSION)),
    'the template must match against the extracted parameter key',
  )
})

test('the legacy single-alternation approach is gone', () => {
  // Each of these reintroduces a specific, verified bug:
  //  - one combined alternation shares a flag context, so one author's `(?i)`
  //    changed the case-sensitivity of every following pattern;
  //  - stripping quotes silently altered user patterns;
  //  - requiring `=` meant a bare `?flag` was never excluded.
  for (const legacyFragment of [
    'excluded_url_params_regex',
    "replace(param_key_regex, \"'\", '')",
    'string_agg(param_key_regex',
  ]) {
    assert.equal(
      NORMALIZED_TEMPLATE.includes(legacyFragment),
      false,
      `the template must not contain the legacy construct: ${legacyFragment}`,
    )
  }
})

test('each pattern is wrapped independently as a full case-insensitive key match', () => {
  assert.ok(
    NORMALIZED_PREDICATE.includes("concat('(?i)^(?:', excluded_url_param_pattern, r')$')"),
    'every pattern must get its own anchored, case-insensitive wrapper',
  )
  assert.ok(
    NORMALIZED_PREDICATE.includes(`unnest(@${EXCLUDED_URL_PARAM_PATTERNS_PARAM})`),
    'patterns must be evaluated one by one, so no pattern can affect another',
  )
})
