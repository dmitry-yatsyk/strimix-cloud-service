import type { BigQueryApi } from '@modules/gcloud/bigquery'
import {
  MAPPING_BOUNDARY_REGEX_COLUMNS,
  MAPPING_MATCH_REGEX_COLUMNS,
  TRAFFIC_RULE_REGEX_COLUMNS,
} from './traffic-settings.constants'
import type {
  IAttributionSignalMappingInput,
  IExcludedUrlParamInput,
  ITrafficRuleInput,
  IValidationIssue,
} from './traffic-settings.interface'
import { EXCLUDED_URL_PARAM_PATTERNS_PARAM } from './url-normalization.sql-helper'

/**
 * Regex validation with real BigQuery RE2 semantics.
 *
 * `new RegExp(...)` is not an acceptable substitute: JavaScript accepts
 * lookbehind and backreferences that RE2 rejects, and rejects some constructs
 * RE2 accepts. Every non-null pattern is therefore compiled by BigQuery itself,
 * in ONE batched parameterized query, without reading any user event data.
 *
 * Crucially, each pattern is checked in the EXACT wrapper the attribution job
 * applies to it, because the wrapper is part of what has to compile: a trailing
 * backslash or an unbalanced paren only breaks once anchors and flags are added
 * around it.
 *
 * `SAFE.REGEXP_CONTAINS` is used to turn a compilation error into NULL so the
 * failure can be attributed to the field that caused it. NULL is reported as an
 * error — never as "this pattern matched nothing".
 */

/**
 * How a regex column is actually evaluated by the attribution job. These are
 * read off the SQL, not assumed:
 *  - `bare`: `regexp_contains(value, pattern)` — partial match, case-sensitive
 *    as written. Used by every traffic rule condition and every mapping
 *    `match_*_regex`.
 *  - `caseInsensitivePrefix`: `regexp_contains(value, concat('(?i)', pattern))`
 *    — partial match, case-insensitive. Used by the two mapping resolution
 *    boundaries.
 *  - `anchoredKeyCaseInsensitive`:
 *    `regexp_contains(key, concat('(?i)^(?:', pattern, ')$'))` — full match of a
 *    URL param key, case-insensitive. Used by excluded_url_params.
 */
export type RegexWrapper = 'bare' | 'caseInsensitivePrefix' | 'anchoredKeyCaseInsensitive'

export interface IRegexCandidate {
  field: string
  pattern: string
  wrapper: RegexWrapper
}

/** Mirrors the SQL wrappers above. Kept next to them so the two cannot drift. */
export function wrapPattern(pattern: string, wrapper: RegexWrapper): string {
  switch (wrapper) {
    case 'anchoredKeyCaseInsensitive':
      return `(?i)^(?:${pattern})$`
    case 'caseInsensitivePrefix':
      return `(?i)${pattern}`
    case 'bare':
    default:
      return pattern
  }
}

/**
 * Subject the probe matches against. Its content is irrelevant to whether a
 * pattern compiles; it exists only so the function is actually evaluated.
 */
const PROBE_SUBJECT = 'strimix_re2_probe'

interface IRegexProbeRow {
  field: string
  invalid: boolean
}

/**
 * Compiles every candidate in one query. Returns a field-level error for each
 * pattern RE2 rejects.
 */
export async function validateRegexCandidates(
  bigqueryApi: BigQueryApi,
  candidates: IRegexCandidate[],
): Promise<IValidationIssue[]> {
  if (candidates.length === 0) {
    return []
  }

  const fields = candidates.map((candidate) => candidate.field)
  const wrapped = candidates.map((candidate) => wrapPattern(candidate.pattern, candidate.wrapper))

  const query = `select
  @fields[offset(i)] as field,
  safe.regexp_contains(@probe, @wrapped[offset(i)]) is null as invalid
from unnest(generate_array(0, array_length(@fields) - 1)) as i`

  const { rows } = await bigqueryApi.queryWithParams<IRegexProbeRow>({
    query,
    params: { fields, wrapped, probe: PROBE_SUBJECT },
    types: { fields: ['STRING'], wrapped: ['STRING'], probe: 'STRING' },
  })

  const invalidFields = new Set(rows.filter((row) => row.invalid).map((row) => row.field))

  return candidates
    .filter((candidate) => invalidFields.has(candidate.field))
    .map((candidate) => ({
      field: candidate.field,
      code: 'INVALID_REGEX',
      message: 'Invalid RE2 expression. Lookbehind and backreferences are not supported',
    }))
}

/** Regex candidates of one excluded url param draft, in its real wrapper. */
export function collectExcludedUrlParamRegexCandidates(
  item: IExcludedUrlParamInput,
): IRegexCandidate[] {
  if (typeof item.param_key_regex !== 'string' || item.param_key_regex.trim() === '') {
    // Emptiness is reported by the domain validation; nothing to compile.
    return []
  }
  return [
    {
      field: 'param_key_regex',
      pattern: item.param_key_regex,
      wrapper: 'anchoredKeyCaseInsensitive',
    },
  ]
}

export function collectTrafficRuleRegexCandidates(item: ITrafficRuleInput): IRegexCandidate[] {
  const candidates: IRegexCandidate[] = []

  for (const column of TRAFFIC_RULE_REGEX_COLUMNS) {
    const pattern = item[column]
    if (typeof pattern === 'string') {
      // An explicitly empty pattern is a valid RE2 expression that matches
      // everything. It is preserved and compiled like any other.
      candidates.push({ field: column, pattern, wrapper: 'bare' })
    }
  }

  return candidates
}

export function collectMappingRegexCandidates(
  item: IAttributionSignalMappingInput,
): IRegexCandidate[] {
  const candidates: IRegexCandidate[] = []

  for (const column of MAPPING_MATCH_REGEX_COLUMNS) {
    const pattern = item[column]
    if (typeof pattern === 'string') {
      candidates.push({ field: column, pattern, wrapper: 'bare' })
    }
  }

  for (const column of MAPPING_BOUNDARY_REGEX_COLUMNS) {
    const pattern = item[column]
    if (typeof pattern === 'string') {
      candidates.push({ field: column, pattern, wrapper: 'caseInsensitivePrefix' })
    }
  }

  return candidates
}

/**
 * Validates the patterns that the URL preview is about to bind. Preview uses the
 * same array parameter as the job, so an invalid pattern must be reported rather
 * than crashing the preview query.
 */
export async function validateExcludedUrlParamPatterns(
  bigqueryApi: BigQueryApi,
  patterns: string[],
): Promise<IValidationIssue[]> {
  return validateRegexCandidates(
    bigqueryApi,
    patterns.map((pattern, index) => ({
      field: `${EXCLUDED_URL_PARAM_PATTERNS_PARAM}[${index}]`,
      pattern,
      wrapper: 'anchoredKeyCaseInsensitive' as const,
    })),
  )
}
