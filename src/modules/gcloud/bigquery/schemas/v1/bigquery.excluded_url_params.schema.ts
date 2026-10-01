export const EXCLUDED_URL_PARAMS_TABLE_ID = 'excluded_url_params'

/**
 * Config table with URL query params excluded from the normalized
 * `landing_page` column of `visits` and `ad_costs` (tracking params like
 * utm_*, click ids etc). Functional query params (product category, city...)
 * are NOT listed here and are kept in `landing_page`.
 *
 * `param_key_regex` is a regex matched case-insensitively against the whole
 * query param key (the job anchors it as `^(?:<regex>)$`), so one row can
 * cover a family of params, e.g. `utm_[a-z]+` or `gclid|gclsrc|dclid`.
 *
 * System default rows (is_system = true) are seeded ONCE at project deploy,
 * right after the table is created (see buildExcludedUrlParamsSeedQuery).
 * The attribution scheduled query never re-inserts them, so the exclusion
 * list is freely editable and deletable per project. New system defaults do
 * NOT propagate to already-deployed projects automatically (deliver them via
 * a data-mapping sync job or a "restore defaults" CRUD action). Client custom
 * rows should use is_system = false.
 */
export const EXCLUDED_URL_PARAMS_TABLE_SCHEMA = [
  { name: 'param_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'param_key_regex', type: 'STRING', mode: 'REQUIRED' },
  { name: 'is_active', type: 'BOOLEAN', mode: 'REQUIRED' },
  { name: 'is_system', type: 'BOOLEAN', mode: 'REQUIRED' },
  { name: 'description', type: 'STRING' },
]

/**
 * Builds the one-time seed of system default excluded url params. Executed
 * at project deploy right after the excluded_url_params table is created.
 * strimix_refid is excluded too: it is a tracking param for ad matching via
 * the dedicated column, not a content-routing query param, so it must not
 * pollute the normalized landing_page.
 */
export function buildExcludedUrlParamsSeedQuery(projectId: string, datasetId: string): string {
  return `insert into \`${projectId}.${datasetId}.${EXCLUDED_URL_PARAMS_TABLE_ID}\`
(param_id, param_key_regex, is_active, is_system, description)
values
('sys_utm', 'utm_[a-z]+', true, true, 'Standard UTM tracking params (utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_id...)'),
('sys_strimix_refid', 'strimix_refid', true, true, 'Strimix ad-matching tracking param (matched via the strimix_refid column, not via landing_page)'),
('sys_google_ads', 'gclid|gclsrc|dclid|gbraid|wbraid|gad_campaignid|gad_source', true, true, 'Google Ads click ids'),
('sys_google_merchant', 'srsltid', true, true, 'Google Merchant Center auto-tagging id (appended in Search/Shopping results for conversion tracking)'),
('sys_google_tag_manager', 'gtm_latency|gtm_debug', true, true, 'Google Tag Manager diagnostic/debug params (appended by GTM tooling / GoogleOther crawler, not content-routing)'),
('sys_google_analytics', '_ga|_gl', true, true, 'Google Analytics cross-domain linker params'),
('sys_meta', 'fbclid', true, true, 'Meta (Facebook/Instagram) click id'),
('sys_instagram', 'igshid', true, true, 'Instagram share id'),
('sys_tiktok', 'ttclid', true, true, 'TikTok click id'),
('sys_twitter', 'twclid', true, true, 'Twitter/X click id'),
('sys_microsoft', 'msclkid', true, true, 'Microsoft (Bing) Ads click id'),
('sys_yandex', 'yclid', true, true, 'Yandex Direct click id'),
('sys_linkedin', 'li_fat_id', true, true, 'LinkedIn first-party ad tracking id'),
('sys_mailchimp', 'mc_cid|mc_eid', true, true, 'Mailchimp campaign and email ids'),
('sys_pinterest', 'epik', true, true, 'Pinterest click id')`
}
