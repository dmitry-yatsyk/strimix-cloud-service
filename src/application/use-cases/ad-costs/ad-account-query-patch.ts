/**
 * Adds ad account columns to the cost branches of a deployed attribution query.
 *
 * Deployed queries may carry manual per-project customizations (marked
 * `-- CUSTOMIZATION`), so the migration does not re-render the template: it
 * applies to the deployed text the same edits the template got, and touches
 * nothing else. Every anchor must be found exactly once in its branch,
 * otherwise the query is left alone and the reason is reported.
 */

const BRANCHES = [
  { table: 'facebook_ads_ad_costs', dataSource: 'FACEBOOK_ADS' },
  { table: 'google_ads_ad_costs', dataSource: 'GOOGLE_ADS' },
  { table: 'tiktok_ads_ad_costs', dataSource: 'TIKTOK_ADS' },
] as const

/** Marker of a patched query: the CTE exists only after the patch. */
export const AD_ACCOUNT_PATCH_MARKER = 'account_names as ('

const accountNamesCte = (
  tableRef: string,
): string => `-- Последнее известное название каждого рекламного аккаунта: одно на все даты,
-- чтобы после переименования аккаунт не распадался на две строки в отчётах.
account_names as (
  select
    ad_account_id,
    array_agg(ad_account_name ignore nulls order by inserted_at desc limit 1)[safe_offset(0)] ad_account_name
  from ${tableRef}
  group by ad_account_id
),

`

const replaceOnce = (
  text: string,
  search: string | RegExp,
  replacement: string,
  label: string,
): string => {
  const count =
    typeof search === 'string'
      ? text.split(search).length - 1
      : (text.match(new RegExp(search.source, `${search.flags.replace('g', '')}g`)) ?? []).length
  if (count !== 1) {
    throw new Error(`${label}: found ${count} time(s), expected 1`)
  }
  return text.replace(search, replacement)
}

const patchBranch = (segment: string, tableRef: string, label: string): string => {
  let result = segment
  result = replaceOnce(
    result,
    '* except(row_number, inserted_at, timezone,',
    '* except(row_number, inserted_at, timezone, ad_account_name,',
    `${label}: latest_matched_rows except list`,
  )
  // The Facebook branch has a trailing space after "c.date,"
  result = replaceOnce(
    result,
    /\n {4}c\.date, ?\n/,
    '$&    c.ad_account_id,\n',
    `${label}: rows_with_actual_utms`,
  )
  result = replaceOnce(
    result,
    '-- Приводим строку расходов к итоговому набору колонок ad_costs.\nad_costs as (',
    `${accountNamesCte(tableRef)}-- Приводим строку расходов к итоговому набору колонок ad_costs.\nad_costs as (`,
    `${label}: ad_costs CTE`,
  )
  result = replaceOnce(
    result,
    '    d.ad_name\n  from rows_with_actual_utms d',
    '    d.ad_name,\n    d.ad_account_id,\n    n.ad_account_name\n  from rows_with_actual_utms d\n  left join account_names n\n  on n.ad_account_id = d.ad_account_id',
    `${label}: ad_costs select`,
  )
  result = replaceOnce(
    result,
    '  ad_id,\n  ad_name\n) values (',
    '  ad_id,\n  ad_name,\n  ad_account_id,\n  ad_account_name\n) values (',
    `${label}: insert columns`,
  )
  result = replaceOnce(
    result,
    '  s.ad_name\n)',
    '  s.ad_name,\n  s.ad_account_id,\n  s.ad_account_name\n)',
    `${label}: insert values`,
  )
  return result
}

/**
 * Returns the patched query. Throws with the failing anchor if the query does not
 * have the expected shape; callers check AD_ACCOUNT_PATCH_MARKER first.
 */
export const addAdAccountColumnsToQuery = (query: string): string => {
  let result = query
  for (const { table, dataSource } of BRANCHES) {
    // `project.dataset.table` (rendered) or `<project_name>.<dataset_name>.table` (template)
    const tableRef = result.match(new RegExp('`[^`\\s]+\\.' + table + '`'))?.[0]
    if (!tableRef) throw new Error(`${table}: table reference not found`)

    const start = result.indexOf(`from ${tableRef}`)
    const endMarker = `t.data_source = '${dataSource}' then delete`
    const end = result.indexOf(endMarker, start)
    if (start === -1 || end === -1) throw new Error(`${table}: cost branch not found`)

    result =
      result.slice(0, start) +
      patchBranch(result.slice(start, end), tableRef, table) +
      result.slice(end)
  }
  return result
}
