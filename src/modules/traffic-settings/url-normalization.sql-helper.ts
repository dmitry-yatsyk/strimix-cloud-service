/**
 * Single source of truth for the `landing_page` normalization that the
 * attribution scheduled query and the server-side URL preview must agree on.
 *
 * The fragments below are emitted as text and embedded verbatim in three
 * places: the visits branch and the ad_costs branch of
 * `update-costs-and-calculate-attribution.sql`, and the preview query of this
 * service. `url-normalization.parity.test.ts` asserts byte-identical presence
 * in the SQL template, so the three can never drift apart.
 *
 * Why the previous approach had to change (section 9 of the spec):
 *  - it inlined `string_agg(replace(param_key_regex, "'", ''), '|')` into the
 *    dynamic SQL text, so a quote in a user pattern was silently dropped and a
 *    backslash was at the mercy of SQL escaping;
 *  - it wrapped the patterns as `^(?i)(?:<p1>|<p2>|...)=` and matched that
 *    against the whole `key=value` pair, so an anchored pattern such as
 *    `^fbclid$` could never match (verified against BigQuery: the legacy
 *    wrapper returns false for `fbclid=123`);
 *  - a single alternation shares one flag context, so `(?i)` written by one
 *    author changed the case-sensitivity of every following pattern (verified:
 *    `regexp_contains('BAR', '^(?:(?i)foo|bar)$')` is true).
 *
 * The replacement extracts the key name (everything before the first `=`) and
 * tests every active pattern INDEPENDENTLY, each in its own flag context, as a
 * full case-insensitive match. Patterns travel as an array query parameter, so
 * quotes and backslashes keep their meaning and nothing user-supplied is ever
 * concatenated into SQL text.
 */

/**
 * Name of the `ARRAY<STRING>` query parameter carrying the active patterns.
 * In the scheduled query it is bound with `EXECUTE IMMEDIATE ... USING`; in
 * the preview it is an ordinary named query parameter.
 */
export const EXCLUDED_URL_PARAM_PATTERNS_PARAM = 'excluded_url_param_patterns'

/** Alias of the `key=value` pair produced by splitting the query string. */
const KV_ALIAS = 'kv'

/**
 * Regex extracting the param KEY from a `key=value` pair: everything up to the
 * first `=`. A pair without `=` yields the whole token, so a bare `?flag` is
 * treated as the key `flag` — the same in both SQL branches and in preview.
 *
 * No percent-decoding happens here. The existing query parsing for
 * `landing_page` works on the raw query string, and preview keeps exactly that
 * semantics: a percent-encoded key is matched as written.
 */
export const EXCLUDED_URL_PARAM_KEY_EXPRESSION = `regexp_extract(${KV_ALIAS}, r'^[^=]*')`

/**
 * Predicate selecting the query params that must be KEPT in `landing_page`.
 *
 * Each active pattern is applied on its own as `(?i)^(?:<pattern>)$`:
 *  - `^...$` makes it a full match of the key, so `utm_[a-z]+` covers
 *    `utm_source` but not `custom_utm_source`, and an already anchored
 *    `^fbclid$` still works;
 *  - `(?i)` makes key matching case-insensitive, so `UTM_MEDIUM` is excluded;
 *  - the per-pattern wrapper is a separate regex evaluation, so an inline flag
 *    or an alternation inside one pattern cannot affect another.
 *
 * An empty configuration excludes nothing: BigQuery binds an empty array
 * parameter as NULL, `unnest(NULL)` yields no rows, so `not exists` holds for
 * every key and all query params are retained.
 */
export const EXCLUDED_URL_PARAM_RETAIN_PREDICATE = `not exists (
          select 1
          from unnest(@${EXCLUDED_URL_PARAM_PATTERNS_PARAM}) as excluded_url_param_pattern
          where regexp_contains(
            ${EXCLUDED_URL_PARAM_KEY_EXPRESSION},
            concat('(?i)^(?:', excluded_url_param_pattern, r')$')
          )
        )`

/**
 * Normalized query-string suffix of `landing_page`: `?a=1&b=2` with tracking
 * params removed, remaining params sorted by the raw pair so that parameter
 * order never splits report rows. Empty result yields an empty string.
 *
 * @param urlExpression SQL expression holding the full page URL
 */
export function buildLandingPageQueryStringExpression(urlExpression: string): string {
  return `ifnull((
        select concat('?', string_agg(${KV_ALIAS}, '&' order by ${KV_ALIAS}))
        from unnest(split(regexp_extract(lower(${urlExpression}), '[?]([^#]*)'), '&')) as ${KV_ALIAS}
        where ${KV_ALIAS} != ''
        and ${EXCLUDED_URL_PARAM_RETAIN_PREDICATE}
      ), '')`
}

/**
 * Full normalized `landing_page`: `host/path?query` in lower case, without
 * protocol, without a leading `www.` and without a trailing slash. A fragment
 * (`#...`) is dropped because the query is extracted as `[?]([^#]*)`.
 *
 * `hostExpression` / `pathExpression` are passed in because the two SQL
 * branches reach them differently: visits carry them as separate columns of
 * the opening page view, while ad_costs and preview derive them from the URL.
 * The query-string handling — the only part that depends on user
 * configuration — is shared verbatim.
 */
export function buildNormalizedLandingPageExpression(params: {
  hostExpression: string
  pathExpression: string
  urlExpression: string
}): string {
  const { hostExpression, pathExpression, urlExpression } = params
  return `nullif(concat(
      regexp_replace(concat(
        regexp_replace(ifnull(${hostExpression}, ''), '^www[.]', ''),
        '/',
        ifnull(${pathExpression}, '')
      ), '/+$', ''),
      ${buildLandingPageQueryStringExpression(urlExpression)}
    ), '')`
}

/**
 * Host/path expressions used when only a full URL is available (the ad_costs
 * branch and the preview). Kept here so preview cannot diverge from the job.
 */
export function buildHostExpressionFromUrl(urlExpression: string): string {
  return `regexp_extract(lower(${urlExpression}), '^(?:[a-z]+://)?([^/?#]+)')`
}

export function buildPathExpressionFromUrl(urlExpression: string): string {
  return `regexp_extract(lower(${urlExpression}), '^(?:[a-z]+://)?[^/?#]+/([^?#]*)')`
}

/**
 * Preview query: normalizes ONE caller-supplied URL under ONE draft exclusion.
 * It reads no event data — the URL travels as a query parameter — and it never
 * fetches or opens the address.
 *
 * `excluded_keys` / `retained_keys` report the decision per query param key so
 * the UI can explain what the exclusion did; `normalized_landing_page` is the
 * value that would be written to `visits.landing_page` / `ad_costs.landing_page`.
 */
export function buildUrlPreviewQuery(): string {
  const urlExpression = '@url'
  const hostExpression = buildHostExpressionFromUrl(urlExpression)
  const pathExpression = buildPathExpressionFromUrl(urlExpression)

  return `with query_pairs as (
  select ${KV_ALIAS}
  from unnest(split(regexp_extract(lower(${urlExpression}), '[?]([^#]*)'), '&')) as ${KV_ALIAS}
  where ${KV_ALIAS} != ''
),
classified as (
  select
    ${EXCLUDED_URL_PARAM_KEY_EXPRESSION} as param_key,
    ${EXCLUDED_URL_PARAM_RETAIN_PREDICATE} as retained
  from query_pairs
)
select
  ${buildNormalizedLandingPageExpression({ hostExpression, pathExpression, urlExpression })}
    as normalized_landing_page,
  ifnull((select array_agg(distinct param_key order by param_key) from classified where not retained), [])
    as excluded_keys,
  ifnull((select array_agg(distinct param_key order by param_key) from classified where retained), [])
    as retained_keys`
}

/**
 * Active patterns of a project, as an `ARRAY<STRING>` in a deterministic order.
 * Used by the preview and by the migration preflight. The scheduled query loads
 * the same set with the same filter inside its own script.
 *
 * Rows with a null or blank pattern are skipped: they cannot express a key and
 * would otherwise turn into `(?i)^(?:)$`, which matches an empty key name.
 */
export function buildActiveExcludedUrlParamPatternsQuery(
  gcpProjectId: string,
  datasetId: string,
  tableId: string,
): string {
  return `select ifnull(array_agg(param_key_regex order by param_id), []) as patterns
from \`${gcpProjectId}.${datasetId}.${tableId}\`
where is_active = true
and param_key_regex is not null
and trim(param_key_regex) != ''`
}
