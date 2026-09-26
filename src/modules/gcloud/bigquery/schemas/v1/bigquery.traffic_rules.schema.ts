export const TRAFFIC_RULES_TABLE_ID = 'traffic_rules'

/**
 * Data-driven traffic classification rules.
 *
 * Resolution is done in three stages:
 *  - stage = 'utm': rewrites the canonical labels (source, medium, campaign,
 *    content, term, strimix_refid) via the `set_*` output columns. Applies to
 *    SYNTHETIC visits and to ad_costs rows; a rule with applies_to_web = true
 *    additionally applies to WEB visits (utm aliasing). Runs before
 *    origin/channel classification, so the rewritten labels participate both
 *    in classification and in visit-to-cost matching.
 *    PER-FIELD SEMANTICS: within the stage every `set_*` field is taken from
 *    the FIRST rule by `priority` that defines it (non-null) among all
 *    matching rules — different rules may fill different fields of the same
 *    row. A rule output OVERWRITES the extracted/parsed label; an extracted
 *    value survives only when no matching rule sets that field.
 *    PLACEHOLDERS: `set_*` values may reference the resolved ad identity —
 *    {data_source}, {campaign_id}, {campaign_name}, {adgroup_id},
 *    {adgroup_name}, {ad_id}, {ad_name}. Substitution is PER-ROW TRUTH: an
 *    ad_costs row expands placeholders from its OWN network columns (every
 *    namesake row keeps its own real campaign/adgroup name); a synthetic
 *    visit expands them from the UNAMBIGUOUS values of its resolved group —
 *    a field that diverges within the group yields null. The '(combined)'
 *    marker is never written into persisted labels; bucket ambiguity is
 *    computed by the reporting engine at read time, and visit-to-cost
 *    matching relies on attributed_ad (id/name tiers), not on byte-equal
 *    labels. Placeholder rules follow the ALL-OR-NOTHING projection: they
 *    fire only when all five canonical labels (source, medium, campaign,
 *    content, term) of the row are still empty, so partial real utm sets
 *    are never mixed with projected ones.
 *  - stage = 'origin':  resolves `traffic_origin` (a concrete traffic source,
 *    e.g. "Meta Ads", "Google", "Telegram"). First matching rule by
 *    `priority` wins.
 *  - stage = 'channel': resolves `traffic_channel` (a high-level category,
 *    e.g. "Paid Social", "Organic Search"). First matching rule wins.
 *    Channel-stage rules may match on the already-resolved `traffic_origin`
 *    via `traffic_origin_regex`, or directly on utm/ad fields.
 *
 * All non-null condition columns are ANDed. Regex conditions are evaluated
 * CASE-SENSITIVELY as written; for case-insensitive matching the rule author
 * puts `(?i)` into the regex itself (e.g. `(?i)^(facebook|fb)$`). System
 * seed rules that intentionally normalize across casing include `(?i)` in
 * their patterns. AD-DERIVED CONDITIONS (data_source_regex,
 * ad_destination_regex, campaign/adgroup/ad id and name regexes) are checked
 * on the ad_costs row itself; for a synthetic visit they are checked on the
 * UNIFIED value of its resolved group (a value ambiguous within the group —
 * e.g. namesakes in different networks — does not satisfy a concrete-value
 * condition); a rule using them never matches web visits or visits without
 * a resolved group.
 *
 * System default rules (is_system = true) are seeded ONCE at project deploy,
 * right after the table is created (see buildTrafficRulesSeedQuery). The
 * attribution scheduled query never re-inserts them, so every rule — system
 * or custom — is freely editable and deletable per project. New system
 * defaults do NOT propagate to already-deployed projects automatically
 * (deliver them via a data-mapping sync job or a "restore defaults" CRUD
 * action). Client custom rules should use is_system = false and
 * priority < 1000 to win over system defaults.
 */
export const TRAFFIC_RULES_TABLE_SCHEMA = [
  // Short display label for the UI. Optional for custom rules; system seeds
  // always carry one. The attribution job never reads it.
  { name: 'name', type: 'STRING' },
  // Operator note. The attribution job never reads it.
  { name: 'description', type: 'STRING' },
  { name: 'rule_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'priority', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'is_active', type: 'BOOLEAN', mode: 'REQUIRED' },
  { name: 'is_system', type: 'BOOLEAN', mode: 'REQUIRED' },
  { name: 'stage', type: 'STRING', mode: 'REQUIRED' }, // 'utm' | 'origin' | 'channel'
  { name: 'target', type: 'STRING', mode: 'REQUIRED' }, // 'visit' | 'ad_cost' | 'both'
  // When true, a visit-targeting utm/origin/channel rule also matches WEB
  // visits. Null is treated as false (synthetic visits only).
  { name: 'applies_to_web', type: 'BOOLEAN' },
  // Conditions (all nullable, non-null conditions are ANDed)
  { name: 'source_regex', type: 'STRING' },
  { name: 'medium_regex', type: 'STRING' },
  { name: 'campaign_regex', type: 'STRING' },
  { name: 'content_regex', type: 'STRING' },
  { name: 'term_regex', type: 'STRING' },
  { name: 'strimix_refid_regex', type: 'STRING' },
  // Ad-derived condition fields: compared with the ad_costs row itself, or
  // with the resolved group of a synthetic visit (the group's unified value
  // must satisfy them). Rules using them never match web visits
  { name: 'data_source_regex', type: 'STRING' },
  { name: 'campaign_id_regex', type: 'STRING' },
  { name: 'campaign_name_regex', type: 'STRING' },
  { name: 'adgroup_id_regex', type: 'STRING' },
  { name: 'adgroup_name_regex', type: 'STRING' },
  { name: 'ad_id_regex', type: 'STRING' },
  { name: 'ad_name_regex', type: 'STRING' },
  { name: 'ad_destination_regex', type: 'STRING' },
  // Matches a url_params entry (actual query params parsed from
  // page_location, incl. custom utm labels like placement): key equality +
  // optional value regex. Synthetic visits have empty url_params — rules
  // targeting them match on the label columns (source_regex etc.)
  { name: 'url_param_key', type: 'STRING' },
  { name: 'url_param_value_regex', type: 'STRING' },
  // Channel-stage-only condition: matches the resolved traffic_origin
  { name: 'traffic_origin_regex', type: 'STRING' },
  // Outputs (set_* fields write values into visits/ad_costs columns):
  // 'utm' stage rules rewrite the canonical labels (null = the rule does not
  // touch the field; values may contain the placeholders listed above)
  { name: 'set_source', type: 'STRING' },
  { name: 'set_medium', type: 'STRING' },
  { name: 'set_campaign', type: 'STRING' },
  { name: 'set_content', type: 'STRING' },
  { name: 'set_term', type: 'STRING' },
  { name: 'set_strimix_refid', type: 'STRING' },
  // 'origin' / 'channel' stage rules fill the classification columns
  { name: 'set_traffic_origin', type: 'STRING' },
  { name: 'set_traffic_channel', type: 'STRING' },
]

/**
 * Short English display names for system seed rules. Shared by the deploy
 * seed and the traffic-settings migration backfill so every provisioned
 * project shows the same labels.
 */
export const SYSTEM_TRAFFIC_RULE_NAMES: Readonly<Record<string, string>> = {
  sys_utm_projection_ad_costs: 'UTM projection to ad costs',
  sys_utm_projection_visits: 'UTM projection to visits',
  sys_origin_google_ads: 'Google Ads',
  sys_origin_bing_ads: 'Bing Ads',
  sys_origin_meta_ads: 'Meta Ads',
  sys_origin_tiktok_ads: 'TikTok Ads',
  sys_origin_linkedin_ads: 'LinkedIn Ads',
  sys_origin_referral: 'Referral',
  sys_origin_meta_ads_network: 'Meta Ads from network',
  sys_origin_google_ads_network: 'Google Ads from network',
  sys_origin_tiktok_ads_network: 'TikTok Ads from network',
  sys_origin_meta_ads_unlabeled: 'Meta Ads without UTM marks',
  sys_origin_google_ads_unlabeled: 'Google Ads without UTM marks',
  sys_origin_tiktok_ads_unlabeled: 'TikTok Ads without UTM marks',
  sys_origin_google: 'Google',
  sys_origin_bing: 'Bing',
  sys_origin_yandex: 'Yandex',
  sys_origin_duckduckgo: 'DuckDuckGo',
  sys_origin_chatgpt: 'ChatGPT',
  sys_origin_telegram: 'Telegram',
  sys_origin_whatsapp: 'WhatsApp',
  sys_origin_viber: 'Viber',
  sys_origin_youtube: 'YouTube',
  sys_origin_instagram: 'Instagram',
  sys_origin_facebook: 'Facebook',
  sys_origin_threads: 'Threads',
  sys_origin_direct: 'Direct visit',
  sys_origin_unknown: 'Unknown origin',
  sys_channel_paid_social: 'Paid social',
  sys_channel_paid_search: 'Paid search',
  sys_channel_ai_assistants: 'AI assistants',
  sys_channel_organic_search: 'Organic search',
  sys_channel_messenger: 'Messengers',
  sys_channel_email: 'Email',
  sys_channel_organic_social_medium: 'Organic social (medium)',
  sys_channel_organic_social_origin: 'Organic social (origin)',
  sys_channel_organic_social_threads: 'Organic social (Threads)',
  sys_channel_referral: 'Referral',
  sys_channel_direct: 'Direct',
}

/**
 * Prior Ukrainian labels that the backfill still rewrites to English. Kept so
 * a one-time rename does not require clearing operator-visible names first.
 * Operator edits to anything else are left alone.
 */
const LEGACY_UKRAINIAN_TRAFFIC_RULE_NAMES: readonly string[] = [
  'Проєкція UTM на витрати',
  'Проєкція UTM на візити',
  'Meta Ads з мережі',
  'Google Ads з мережі',
  'TikTok Ads з мережі',
  'Прямий захід',
  'Невідоме походження',
  'Платна соцмережа',
  'Платний пошук',
  'ШІ-асистенти',
  'Органічний пошук',
  'Месенджери',
  'Органічна соцмережа medium',
  'Органічна соцмережа origin',
  'Органічна соцмережа Threads',
  'Реферальний трафік',
  'Прямий канал',
]

/** Escapes a string literal for embedding in a BigQuery SQL statement. */
function sqlStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * Fills empty `name` on known system rules, and rewrites the prior Ukrainian
 * labels to English. Idempotent for anything else: operator edits are left alone.
 */
export function buildSystemTrafficRuleNamesBackfillQuery(
  projectId: string,
  datasetId: string,
): string {
  const cases = Object.entries(SYSTEM_TRAFFIC_RULE_NAMES)
    .map(([ruleId, name]) => `when ${sqlStringLiteral(ruleId)} then ${sqlStringLiteral(name)}`)
    .join('\n    ')
  const legacyNames = LEGACY_UKRAINIAN_TRAFFIC_RULE_NAMES.map(sqlStringLiteral).join(', ')

  return `update \`${projectId}.${datasetId}.${TRAFFIC_RULES_TABLE_ID}\`
set name = case rule_id
    ${cases}
    else name
  end
where is_system = true
  and (name is null or name = '' or name in (${legacyNames}))
  and rule_id in (${Object.keys(SYSTEM_TRAFFIC_RULE_NAMES).map(sqlStringLiteral).join(', ')})`
}

/** WHERE predicate shared by the backfill UPDATE and its pending-row count. */
export function systemTrafficRuleNamesBackfillPendingPredicate(): string {
  const legacyNames = LEGACY_UKRAINIAN_TRAFFIC_RULE_NAMES.map(sqlStringLiteral).join(', ')
  return `is_system = true
  and (name is null or name = '' or name in (${legacyNames}))
  and rule_id in (${Object.keys(SYSTEM_TRAFFIC_RULE_NAMES).map(sqlStringLiteral).join(', ')})`
}

/**
 * Builds the one-time seed of system default classification rules. Executed
 * at project deploy right after the traffic_rules table is created.
 *
 * Seed groups:
 *  - utm projection pair: fills empty canonical labels of NON-WEB ad_costs
 *    rows and synthetic visits from the ad identity (all-or-nothing;
 *    per-row values on cost rows, unambiguous-or-null group values on
 *    visits). Delivered as a pair (target='ad_cost' + target='visit') so
 *    both pipelines produce labels by the same convention.
 *  - origin by network name: catches labels produced by the projection pair
 *    (source = '{data_source}' -> 'FACEBOOK_ADS' etc.)
 *  - origin referral: medium = referral on any visit (web and synthetic)
 *    sets traffic_origin to Referral. Ad costs are not targeted. Priority
 *    is after the named referrer origins (Google, Instagram, Telegram, …),
 *    so those keep their own origin and only an unrecognized referring
 *    site falls through to Referral.
 *  - origin of unlabeled ad costs: when all five canonical labels are empty,
 *    an ad_cost row is still classified by its data_source (FACEBOOK_ADS,
 *    GOOGLE_ADS, TIKTOK_ADS). Visits are not targeted: an empty visit does
 *    not say which network it came from. These rules exist so spend with
 *    no site visits still shows a network in reports instead of Unknown.
 *  - AI assistants (official UTM only): ChatGPT — OpenAI documents
 *    utm_source=chatgpt.com on citation links → origin ChatGPT, channel
 *    AI Assistants. Other AI platforms omitted until vendor documents UTM.
 *
 * Origin/channel seeds set applies_to_web=true so new projects classify web
 * visits the same way the job did before the flag was honored on those stages.
 * Existing projects need the backfill script
 * (backfill-applies-to-web-origin-channel.ts); re-deploy never rewrites seeds.
 *
 * Regex conditions are case-sensitive by default. Seeds that intentionally
 * match labels across casing embed `(?i)` in the pattern; the exact
 * `(direct)` marker and the lowercase ad_destination taxonomy stay
 * case-sensitive.
 */
export function buildTrafficRulesSeedQuery(projectId: string, datasetId: string): string {
  const n = SYSTEM_TRAFFIC_RULE_NAMES
  return `insert into \`${projectId}.${datasetId}.${TRAFFIC_RULES_TABLE_ID}\`
(rule_id, priority, is_active, is_system, stage, target, applies_to_web, source_regex, medium_regex, ad_destination_regex, data_source_regex, traffic_origin_regex, set_source, set_medium, set_campaign, set_content, set_term, set_traffic_origin, set_traffic_channel, name)
values
-- Utm stage: projection pair for non-web ads (all-or-nothing, per-row truth)
-- ad_destination taxonomy is always lowercase from connectors — no (?i)
('sys_utm_projection_ad_costs', 1000, false, true, 'utm', 'ad_cost', false, null, null, '^(call|chat|app|lead_form|engagement|catalog|multi_destination|unknown)$', null, null, '{data_source}', '(not set)', '{campaign_name}', '{adgroup_name}', '{ad_name}', null, null, ${sqlStringLiteral(n.sys_utm_projection_ad_costs)}),
('sys_utm_projection_visits', 1001, false, true, 'utm', 'visit', false, null, null, '^(call|chat|app|lead_form|engagement|catalog|multi_destination|unknown)$', null, null, '{data_source}', '(not set)', '{campaign_name}', '{adgroup_name}', '{ad_name}', null, null, ${sqlStringLiteral(n.sys_utm_projection_visits)}),
-- Origin stage: paid sources by utm labels ((?i) — catch Facebook/FACEBOOK/…)
('sys_origin_google_ads', 1000, true, true, 'origin', 'both', true, '(?i)^(google|adwords|google[ _-]?ads)$', '(?i)^(cpc|ppc|paid|paid_search|paidsearch)$', null, null, null, null, null, null, null, null, 'Google Ads', null, ${sqlStringLiteral(n.sys_origin_google_ads)}),
('sys_origin_bing_ads', 1010, true, true, 'origin', 'both', true, '(?i)^(bing|bing[ _-]?ads)$', '(?i)^(cpc|ppc|paid|paid_search|paidsearch)$', null, null, null, null, null, null, null, null, 'Bing Ads', null, ${sqlStringLiteral(n.sys_origin_bing_ads)}),
('sys_origin_meta_ads', 1020, true, true, 'origin', 'both', true, '(?i)^(fb|facebook|meta|ig|th|instagram|facebook[ _-]?ads|meta[ _-]?ads|an|msg)$', '(?i)^(cpc|ppc|paid|paid_social|paidsocial|social_paid)$', null, null, null, null, null, null, null, null, 'Meta Ads', null, ${sqlStringLiteral(n.sys_origin_meta_ads)}),
('sys_origin_tiktok_ads', 1030, true, true, 'origin', 'both', true, '(?i)^(tiktok|tt|tiktok[ _-]?ads)$', '(?i)^(cpc|ppc|paid|paid_social|paidsocial|social_paid)$', null, null, null, null, null, null, null, null, 'TikTok Ads', null, ${sqlStringLiteral(n.sys_origin_tiktok_ads)}),
('sys_origin_linkedin_ads', 1040, true, true, 'origin', 'both', true, '(?i)^(linkedin|li|linkedin[ _-]?ads)$', '(?i)^(cpc|ppc|paid|paid_social|paidsocial|social_paid)$', null, null, null, null, null, null, null, null, 'LinkedIn Ads', null, ${sqlStringLiteral(n.sys_origin_linkedin_ads)}),
-- Origin stage: paid sources by network name in source (labels produced by
-- the projection pair: source = data_source, e.g. FACEBOOK_ADS)
('sys_origin_meta_ads_network', 1060, true, true, 'origin', 'both', true, '(?i)^(facebook[ _-]?ads|meta[ _-]?ads)$', null, null, null, null, null, null, null, null, null, 'Meta Ads', null, ${sqlStringLiteral(n.sys_origin_meta_ads_network)}),
('sys_origin_google_ads_network', 1070, true, true, 'origin', 'both', true, '(?i)^google[ _-]?ads$', null, null, null, null, null, null, null, null, null, 'Google Ads', null, ${sqlStringLiteral(n.sys_origin_google_ads_network)}),
('sys_origin_tiktok_ads_network', 1080, true, true, 'origin', 'both', true, '(?i)^tiktok[ _-]?ads$', null, null, null, null, null, null, null, null, null, 'TikTok Ads', null, ${sqlStringLiteral(n.sys_origin_tiktok_ads_network)}),
-- Origin stage: search engines
('sys_origin_google', 1100, true, true, 'origin', 'both', true, '(?i)^(google|www[.]google[.][a-z.]+|google[.][a-z.]+)$', null, null, null, null, null, null, null, null, null, 'Google', null, ${sqlStringLiteral(n.sys_origin_google)}),
('sys_origin_bing', 1110, true, true, 'origin', 'both', true, '(?i)^(bing|www[.]bing[.]com|bing[.]com)$', null, null, null, null, null, null, null, null, null, 'Bing', null, ${sqlStringLiteral(n.sys_origin_bing)}),
('sys_origin_yandex', 1120, true, true, 'origin', 'both', true, '(?i)^(yandex|yandex[.][a-z.]+|www[.]yandex[.][a-z.]+)$', null, null, null, null, null, null, null, null, null, 'Yandex', null, ${sqlStringLiteral(n.sys_origin_yandex)}),
('sys_origin_duckduckgo', 1130, true, true, 'origin', 'both', true, '(?i)^(duckduckgo|duckduckgo[.]com)$', null, null, null, null, null, null, null, null, null, 'DuckDuckGo', null, ${sqlStringLiteral(n.sys_origin_duckduckgo)}),
-- Origin stage: AI assistants (official UTM only — OpenAI documents
-- utm_source=chatgpt.com on ChatGPT citation / search referral links)
('sys_origin_chatgpt', 1180, true, true, 'origin', 'both', true, '(?i)^chatgpt[.]com$', null, null, null, null, null, null, null, null, null, 'ChatGPT', null, ${sqlStringLiteral(n.sys_origin_chatgpt)}),
-- Origin stage: messengers and social referrers
('sys_origin_telegram', 1200, true, true, 'origin', 'both', true, '(?i)^(telegram|t[.]me|telegram[.]me|web[.]telegram[.]org|org[.]telegram[.]messenger)$', null, null, null, null, null, null, null, null, null, 'Telegram', null, ${sqlStringLiteral(n.sys_origin_telegram)}),
('sys_origin_whatsapp', 1210, true, true, 'origin', 'both', true, '(?i)^(whatsapp|wa|api[.]whatsapp[.]com|chat[.]whatsapp[.]com|com[.]whatsapp)$', null, null, null, null, null, null, null, null, null, 'WhatsApp', null, ${sqlStringLiteral(n.sys_origin_whatsapp)}),
('sys_origin_viber', 1220, true, true, 'origin', 'both', true, '(?i)^(viber|com[.]viber[.]voip)$', null, null, null, null, null, null, null, null, null, 'Viber', null, ${sqlStringLiteral(n.sys_origin_viber)}),
('sys_origin_youtube', 1230, true, true, 'origin', 'both', true, '(?i)^(youtube|youtube[.]com|www[.]youtube[.]com|m[.]youtube[.]com)$', null, null, null, null, null, null, null, null, null, 'YouTube', null, ${sqlStringLiteral(n.sys_origin_youtube)}),
('sys_origin_instagram', 1240, true, true, 'origin', 'both', true, '(?i)^(instagram[.]com|l[.]instagram[.]com|www[.]instagram[.]com|com[.]instagram[.]android)$', null, null, null, null, null, null, null, null, null, 'Instagram', null, ${sqlStringLiteral(n.sys_origin_instagram)}),
('sys_origin_facebook', 1250, true, true, 'origin', 'both', true, '(?i)^(facebook[.]com|m[.]facebook[.]com|l[.]facebook[.]com|lm[.]facebook[.]com|www[.]facebook[.]com)$', null, null, null, null, null, null, null, null, null, 'Facebook', null, ${sqlStringLiteral(n.sys_origin_facebook)}),
('sys_origin_threads', 1255, true, true, 'origin', 'both', true, '(?i)^l[.]threads[.]com$', null, null, null, null, null, null, null, null, null, 'Threads', null, ${sqlStringLiteral(n.sys_origin_threads)}),
-- Origin stage: referral medium on visits only (web and synthetic).
-- After the named referrer origins above, so Instagram / Facebook /
-- Telegram / Google keep their own origin. An unrecognized referring
-- site falls through to Referral, before Direct and Unknown.
('sys_origin_referral', 1260, true, true, 'origin', 'visit', true, null, '(?i)^referral$', null, null, null, null, null, null, null, null, 'Referral', null, ${sqlStringLiteral(n.sys_origin_referral)}),
-- Origin stage: direct (exact marker)
('sys_origin_direct', 1300, true, true, 'origin', 'both', true, '^[(]direct[)]$', null, null, null, null, null, null, null, null, null, 'Direct', null, ${sqlStringLiteral(n.sys_origin_direct)}),
-- Origin stage: empty/null source → Unknown. Job conditions match via
-- ifnull(source, ''), so '^$' covers both null and empty string. Localizable
-- by changing set_traffic_origin; the job still keeps a hardcoded 'Unknown'
-- fallback if this rule is missing.
('sys_origin_unknown', 1310, true, true, 'origin', 'both', true, '^$', null, null, null, null, null, null, null, null, null, 'Unknown', null, ${sqlStringLiteral(n.sys_origin_unknown)}),
-- Channel stage: resolved from traffic_origin ((?i) — origins are Title Case)
('sys_channel_paid_social', 2000, true, true, 'channel', 'both', true, null, null, null, null, '(?i)^(meta ads|tiktok ads|linkedin ads|instagram direct)$', null, null, null, null, null, null, 'Paid Social', ${sqlStringLiteral(n.sys_channel_paid_social)}),
('sys_channel_paid_search', 2010, true, true, 'channel', 'both', true, null, null, null, null, '(?i)^(google ads|bing ads)$', null, null, null, null, null, null, 'Paid Search', ${sqlStringLiteral(n.sys_channel_paid_search)}),
('sys_channel_ai_assistants', 2015, true, true, 'channel', 'both', true, null, null, null, null, '(?i)^chatgpt$', null, null, null, null, null, null, 'AI Assistants', ${sqlStringLiteral(n.sys_channel_ai_assistants)}),
('sys_channel_organic_search', 2020, true, true, 'channel', 'both', true, null, null, null, null, '(?i)^(google|bing|yandex|duckduckgo)$', null, null, null, null, null, null, 'Organic Search', ${sqlStringLiteral(n.sys_channel_organic_search)}),
('sys_channel_messenger', 2030, true, true, 'channel', 'both', true, null, null, null, null, '(?i)^(telegram|whatsapp|viber)$', null, null, null, null, null, null, 'Messenger', ${sqlStringLiteral(n.sys_channel_messenger)}),
('sys_channel_email', 2040, true, true, 'channel', 'both', true, null, '(?i)^(email|e-mail|e_mail|newsletter)$', null, null, null, null, null, null, null, null, null, 'Email', ${sqlStringLiteral(n.sys_channel_email)}),
('sys_channel_organic_social_medium', 2050, true, true, 'channel', 'both', true, null, '(?i)^(social|organic_social|social_organic|organicsocial)$', null, null, null, null, null, null, null, null, null, 'Organic Social', ${sqlStringLiteral(n.sys_channel_organic_social_medium)}),
('sys_channel_organic_social_origin', 2060, true, true, 'channel', 'both', true, null, null, null, null, '(?i)^(instagram|facebook|youtube)$', null, null, null, null, null, null, 'Organic Social', ${sqlStringLiteral(n.sys_channel_organic_social_origin)}),
('sys_channel_organic_social_threads', 2065, true, true, 'channel', 'both', true, null, null, null, null, '(?i)^threads$', null, null, null, null, null, null, 'Organic Social', ${sqlStringLiteral(n.sys_channel_organic_social_threads)}),
('sys_channel_referral', 2070, true, true, 'channel', 'both', true, null, '(?i)^referral$', null, null, null, null, null, null, null, null, null, 'Referral', ${sqlStringLiteral(n.sys_channel_referral)}),
('sys_channel_direct', 2080, true, true, 'channel', 'both', true, null, null, null, null, '(?i)^direct$', null, null, null, null, null, null, 'Direct', ${sqlStringLiteral(n.sys_channel_direct)});

-- Origin of ad costs whose five canonical labels are still empty. Priority
-- sits before sys_origin_unknown (1310) so a known network wins over Unknown.
-- target='ad_cost' only: a visit with empty labels does not identify a network.
-- data_source_regex is the exact connector literal; the job matches it with
-- regexp_contains, and the API allowlist stores the same literal.
insert into \`${projectId}.${datasetId}.${TRAFFIC_RULES_TABLE_ID}\`
(rule_id, priority, is_active, is_system, stage, target, applies_to_web, source_regex, medium_regex, campaign_regex, content_regex, term_regex, data_source_regex, set_traffic_origin, name)
values
('sys_origin_meta_ads_unlabeled', 1290, true, true, 'origin', 'ad_cost', false, '^$', '^$', '^$', '^$', '^$', 'FACEBOOK_ADS', 'Meta Ads', ${sqlStringLiteral(n.sys_origin_meta_ads_unlabeled)}),
('sys_origin_google_ads_unlabeled', 1292, true, true, 'origin', 'ad_cost', false, '^$', '^$', '^$', '^$', '^$', 'GOOGLE_ADS', 'Google Ads', ${sqlStringLiteral(n.sys_origin_google_ads_unlabeled)}),
('sys_origin_tiktok_ads_unlabeled', 1294, true, true, 'origin', 'ad_cost', false, '^$', '^$', '^$', '^$', '^$', 'TIKTOK_ADS', 'TikTok Ads', ${sqlStringLiteral(n.sys_origin_tiktok_ads_unlabeled)})`
}
