import {
  ATTRIBUTION_SIGNAL_MAPPINGS_TABLE_ID,
  EXCLUDED_REFERRERS_TABLE_ID,
  EXCLUDED_URL_PARAMS_TABLE_ID,
  TRAFFIC_RULES_TABLE_ID,
} from '@modules/gcloud/bigquery'

/**
 * Public resource slugs of the feature. The set is closed: a request may only
 * address one of these four, and each maps to a fixed BigQuery table through
 * RESOURCE_TABLE_IDS below. Nothing derived from request input ever reaches a
 * table identifier.
 */
export const TRAFFIC_SETTINGS_RESOURCES = [
  'excluded-url-params',
  'excluded-referrers',
  'traffic-rules',
  'attribution-signal-mappings',
] as const

export type TrafficSettingsResource = (typeof TRAFFIC_SETTINGS_RESOURCES)[number]

/**
 * Every resource is addressed by a row ID. The list is kept separate from
 * TRAFFIC_SETTINGS_RESOURCES because the readiness report covers resources that
 * have no rows of their own (the revisions table), and because a future
 * whole-collection resource would not belong here.
 */
export const TRAFFIC_SETTINGS_ITEM_RESOURCES = [
  'excluded-url-params',
  'excluded-referrers',
  'traffic-rules',
  'attribution-signal-mappings',
] as const

export type TrafficSettingsItemResource = (typeof TRAFFIC_SETTINGS_ITEM_RESOURCES)[number]

/** Fixed allowlist slug -> BigQuery table id. The only source of table names. */
export const RESOURCE_TABLE_IDS: Record<TrafficSettingsResource, string> = {
  'excluded-url-params': EXCLUDED_URL_PARAMS_TABLE_ID,
  'excluded-referrers': EXCLUDED_REFERRERS_TABLE_ID,
  'traffic-rules': TRAFFIC_RULES_TABLE_ID,
  'attribution-signal-mappings': ATTRIBUTION_SIGNAL_MAPPINGS_TABLE_ID,
}

/**
 * `resource` values stored in traffic_settings_revisions: the canonical table
 * names with underscores, as required by the revision table contract.
 */
export const RESOURCE_REVISION_KEYS: Record<TrafficSettingsResource, string> = RESOURCE_TABLE_IDS

/** Key of the immutable ID column of each row-addressed resource. */
export const RESOURCE_ID_COLUMNS: Record<TrafficSettingsItemResource, string> = {
  'excluded-url-params': 'param_id',
  'excluded-referrers': 'referrer_id',
  'traffic-rules': 'rule_id',
  'attribution-signal-mappings': 'mapping_id',
}

/** Prefix of every server-generated ID; system seed rows use `sys_`. */
export const CUSTOM_ID_PREFIX = 'custom_'

export const TRAFFIC_RULE_STAGES = ['utm', 'origin', 'channel'] as const
export type TrafficRuleStage = (typeof TRAFFIC_RULE_STAGES)[number]

export const TRAFFIC_RULE_TARGETS = ['visit', 'ad_cost', 'both'] as const
export type TrafficRuleTarget = (typeof TRAFFIC_RULE_TARGETS)[number]

export const MAPPING_ENTITIES = ['order', 'deal', 'event'] as const
export type MappingEntity = (typeof MAPPING_ENTITIES)[number]

export const MAPPING_PARAM_SOURCES = ['custom_params', 'event_params'] as const
export type MappingParamSource = (typeof MAPPING_PARAM_SOURCES)[number]

export const MAPPING_MODES = ['fallback', 'override'] as const
export type MappingMode = (typeof MAPPING_MODES)[number]

/** entity -> the only param container allowed for it (section 6.5.1). */
export const MAPPING_ENTITY_PARAM_SOURCE: Record<MappingEntity, MappingParamSource> = {
  order: 'custom_params',
  deal: 'custom_params',
  event: 'event_params',
}

/**
 * Writable columns per resource, in schema order. Used to build parameterized
 * INSERT/UPDATE statements: the column list never comes from request keys.
 */
export const EXCLUDED_URL_PARAM_WRITABLE_COLUMNS = [
  'param_key_regex',
  'is_active',
  'description',
] as const

export const EXCLUDED_REFERRER_WRITABLE_COLUMNS = ['host', 'is_active', 'description'] as const

export const TRAFFIC_RULE_CONDITION_COLUMNS = [
  'source_regex',
  'medium_regex',
  'campaign_regex',
  'content_regex',
  'term_regex',
  'strimix_refid_regex',
  'data_source_regex',
  'campaign_id_regex',
  'campaign_name_regex',
  'adgroup_id_regex',
  'adgroup_name_regex',
  'ad_id_regex',
  'ad_name_regex',
  'ad_destination_regex',
  'url_param_key',
  'url_param_value_regex',
  'traffic_origin_regex',
] as const

/** Ad-derived conditions: never match web visits, only cost rows / resolved groups. */
export const TRAFFIC_RULE_AD_DERIVED_CONDITION_COLUMNS = [
  'data_source_regex',
  'campaign_id_regex',
  'campaign_name_regex',
  'adgroup_id_regex',
  'adgroup_name_regex',
  'ad_id_regex',
  'ad_name_regex',
  'ad_destination_regex',
] as const

export const TRAFFIC_RULE_UTM_OUTPUT_COLUMNS = [
  'set_source',
  'set_medium',
  'set_campaign',
  'set_content',
  'set_term',
  'set_strimix_refid',
] as const

export const TRAFFIC_RULE_CLASSIFICATION_OUTPUT_COLUMNS = [
  'set_traffic_origin',
  'set_traffic_channel',
] as const

export const TRAFFIC_RULE_WRITABLE_COLUMNS = [
  'priority',
  'is_active',
  'stage',
  'target',
  'applies_to_web',
  ...TRAFFIC_RULE_CONDITION_COLUMNS,
  ...TRAFFIC_RULE_UTM_OUTPUT_COLUMNS,
  ...TRAFFIC_RULE_CLASSIFICATION_OUTPUT_COLUMNS,
  'name',
  'description',
] as const

/** Regex-valued traffic rule columns, validated with BigQuery RE2 semantics. */
export const TRAFFIC_RULE_REGEX_COLUMNS = [
  'source_regex',
  'medium_regex',
  'campaign_regex',
  'content_regex',
  'term_regex',
  'strimix_refid_regex',
  'data_source_regex',
  'campaign_id_regex',
  'campaign_name_regex',
  'adgroup_id_regex',
  'adgroup_name_regex',
  'ad_id_regex',
  'ad_name_regex',
  'ad_destination_regex',
  'url_param_value_regex',
  'traffic_origin_regex',
] as const

export const MAPPING_LABEL_PARAM_KEY_COLUMNS = [
  'source_param_key',
  'medium_param_key',
  'campaign_param_key',
  'content_param_key',
  'term_param_key',
  'strimix_refid_param_key',
] as const

export const MAPPING_AD_PARAM_KEY_COLUMNS = [
  'campaign_id_param_key',
  'campaign_name_param_key',
  'adgroup_id_param_key',
  'adgroup_name_param_key',
  'ad_id_param_key',
  'ad_name_param_key',
] as const

export const MAPPING_PARAM_KEY_COLUMNS = [
  ...MAPPING_LABEL_PARAM_KEY_COLUMNS,
  ...MAPPING_AD_PARAM_KEY_COLUMNS,
] as const

export const MAPPING_MATCH_REGEX_COLUMNS = [
  'match_source_regex',
  'match_medium_regex',
  'match_campaign_regex',
  'match_content_regex',
  'match_term_regex',
  'match_strimix_refid_regex',
  'match_campaign_id_regex',
  'match_campaign_name_regex',
  'match_adgroup_id_regex',
  'match_adgroup_name_regex',
  'match_ad_id_regex',
  'match_ad_name_regex',
] as const

/** Resolution boundaries: they scope the ad_costs lookup, they are not match_* filters. */
export const MAPPING_BOUNDARY_REGEX_COLUMNS = ['ad_destination_regex', 'data_source_regex'] as const

/**
 * Exact `data_source` literals written into `ad_costs` by the unified attribution
 * job (Facebook / Google Ads / TikTok stages). Custom rules and signal mappings
 * may only store one of these as `data_source_regex` — free text and regex
 * wrappers are rejected. Null / blank = unrestricted.
 */
export const ALLOWED_DATA_SOURCES = [
  'FACEBOOK_ADS',
  'GOOGLE_ADS',
  'TIKTOK_ADS',
] as const

/**
 * Lowercase `ad_destination` taxonomy emitted by ad-network connectors and
 * forwarded into `ad_costs` (empty connector values normalize to `unknown`).
 * Includes `web` (documented connector value; outside the non-web projection
 * seed regex). Null / blank = unrestricted.
 */
export const ALLOWED_AD_DESTINATIONS = [
  'call',
  'chat',
  'app',
  'lead_form',
  'engagement',
  'catalog',
  'multi_destination',
  'web',
  'unknown',
] as const

export const MAPPING_REGEX_COLUMNS = [
  ...MAPPING_MATCH_REGEX_COLUMNS,
  ...MAPPING_BOUNDARY_REGEX_COLUMNS,
] as const

export const MAPPING_WRITABLE_COLUMNS = [
  'priority',
  'is_active',
  'entity',
  'param_source',
  ...MAPPING_PARAM_KEY_COLUMNS,
  ...MAPPING_MATCH_REGEX_COLUMNS,
  ...MAPPING_BOUNDARY_REGEX_COLUMNS,
  'event_name',
  'mode',
  'name',
  'description',
] as const

/**
 * `match_*_regex` filter -> the `*_param_key` that must be configured for it.
 * A filter without its mapped key can never pass (strict emptiness), so a new
 * or edited config is rejected instead of silently never matching.
 */
export const MAPPING_MATCH_REGEX_REQUIRED_PARAM_KEY: Record<string, string> = {
  match_source_regex: 'source_param_key',
  match_medium_regex: 'medium_param_key',
  match_campaign_regex: 'campaign_param_key',
  match_content_regex: 'content_param_key',
  match_term_regex: 'term_param_key',
  match_strimix_refid_regex: 'strimix_refid_param_key',
  match_campaign_id_regex: 'campaign_id_param_key',
  match_campaign_name_regex: 'campaign_name_param_key',
  match_adgroup_id_regex: 'adgroup_id_param_key',
  match_adgroup_name_regex: 'adgroup_name_param_key',
  match_ad_id_regex: 'ad_id_param_key',
  match_ad_name_regex: 'ad_name_param_key',
}

/**
 * The only placeholders allowed in utm `set_*` outputs. The attribution job
 * substitutes them from the resolved ad identity; no other macros exist and no
 * expression evaluation is supported.
 */
export const TRAFFIC_RULE_OUTPUT_PLACEHOLDERS = [
  'data_source',
  'campaign_id',
  'campaign_name',
  'adgroup_id',
  'adgroup_name',
  'ad_id',
  'ad_name',
] as const

/**
 * Application limits of the first version. Existing values outside them are
 * never truncated: preflight reports them so an operator can decide.
 */
export const TRAFFIC_SETTINGS_LIMITS = {
  REGEX_MAX_LENGTH: 4096,
  DESCRIPTION_MAX_LENGTH: 4096,
  STRING_OUTPUT_MAX_LENGTH: 2048,
  PARAM_KEY_MAX_LENGTH: 256,
  EVENT_NAME_MAX_LENGTH: 256,
  /** Rows in excluded_referrers, and hosts accepted in one bulk add. */
  HOSTS_MAX_COUNT: 1000,
  HOSTNAME_MAX_LENGTH: 253,
  HOSTNAME_LABEL_MAX_LENGTH: 63,
  /** Priority must round-trip losslessly through JSON. */
  PRIORITY_MAX_ABS: Number.MAX_SAFE_INTEGER,
  /** Suggested default for a new custom rule: wins over the system seeds. */
  SUGGESTED_CUSTOM_RULE_PRIORITY_CEILING: 1000,
} as const

/** Deterministic sort order per resource (section 7.2). */
export const TRAFFIC_RULE_STAGE_SORT_ORDER: Record<TrafficRuleStage, number> = {
  utm: 0,
  origin: 1,
  channel: 2,
}

/** Readiness states reported by /meta per resource. */
export const TRAFFIC_SETTINGS_RESOURCE_STATES = [
  'ready',
  'not_provisioned',
  'migration_required',
  'invalid_configuration',
] as const

export type TrafficSettingsResourceState = (typeof TRAFFIC_SETTINGS_RESOURCE_STATES)[number]

/** How a saved change reaches reports. No invented applied_at / next_run_at. */
export const TRAFFIC_SETTINGS_APPLICATION_MODE = 'next_scheduled_run' as const
