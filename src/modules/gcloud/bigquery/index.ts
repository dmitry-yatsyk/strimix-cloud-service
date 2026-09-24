export { BigQueryApi } from './api/bigquery.api'
export type {
  ICreateDatasetParams,
  ICreateTableParams,
  ICreateViewParams,
  ICreateScheduledQueryParams,
  IDatasetInfo,
  ITableInfo,
  IScheduledQueryInfo,
  IParameterizedQueryParams,
  IQueryResult,
  ITableMetadata,
  QueryParameterTypes,
  QueryParameterValues,
  MultiRegionLocation,
} from './bigquery.interface'
export {
  processScheduledQueryTemplate,
  UPDATE_COSTS_AND_CALCULATE_ATTRIBUTION_TEMPLATE,
  SCHEDULED_QUERY_CONFIGS,
  LEGACY_SCHEDULED_QUERY_DISPLAY_NAME_PREFIXES,
} from './scheduled-queries/index'
export type {
  IScheduledQueryTemplateVariables,
  IScheduledQueryConfig,
} from './scheduled-queries/index'
export { RAW_EVENTS_TABLE_ID } from './schemas/v1/bigquery.raw_events.schema'
export { RAW_EVENTS_TABLE_SCHEMA } from './schemas/v1/bigquery.raw_events.schema'
export { IDENTIFIED_EVENTS_TABLE_ID } from './schemas/v1/bigquery.identified_events.schema'
export { IDENTIFIED_EVENTS_TABLE_SCHEMA } from './schemas/v1/bigquery.identified_events.schema'
export { EXCLUDED_REFERRERS_TABLE_ID } from './schemas/v1/bigquery.excluded_referrers.schema'
export { EXCLUDED_REFERRERS_TABLE_SCHEMA } from './schemas/v1/bigquery.excluded_referrers.schema'
export { EXCLUDED_REFERRERS_LEGACY_COLUMN } from './schemas/v1/bigquery.excluded_referrers.schema'
export { AD_COSTS_TABLE_ID } from './schemas/v1/bigquery.ad_costs.schema'
export { AD_COSTS_TABLE_SCHEMA } from './schemas/v1/bigquery.ad_costs.schema'
export { FACEBOOK_ADS_AD_COSTS_TABLE_ID } from './schemas/v1/bigquery.facebook_ads_ad_costs.schema'
export { FACEBOOK_ADS_AD_COSTS_TABLE_SCHEMA } from './schemas/v1/bigquery.facebook_ads_ad_costs.schema'
export { GOOGLE_ADS_AD_COSTS_TABLE_ID } from './schemas/v1/bigquery.google_ads_ad_costs.schema'
export { GOOGLE_ADS_AD_COSTS_TABLE_SCHEMA } from './schemas/v1/bigquery.google_ads_ad_costs.schema'
export { TIKTOK_ADS_AD_COSTS_TABLE_ID } from './schemas/v1/bigquery.tiktok_ads_ad_costs.schema'
export { TIKTOK_ADS_AD_COSTS_TABLE_SCHEMA } from './schemas/v1/bigquery.tiktok_ads_ad_costs.schema'
export { PROFILE_MERGE_EVENTS_TABLE_ID } from './schemas/v1/bigquery.profile_merge_events.schema'
export { PROFILE_MERGE_EVENTS_TABLE_SCHEMA } from './schemas/v1/bigquery.profile_merge_events.schema'
export { TRAFFIC_RULES_TABLE_ID } from './schemas/v1/bigquery.traffic_rules.schema'
export { TRAFFIC_RULES_TABLE_SCHEMA } from './schemas/v1/bigquery.traffic_rules.schema'
export { SYSTEM_TRAFFIC_RULE_NAMES } from './schemas/v1/bigquery.traffic_rules.schema'
export { buildTrafficRulesSeedQuery } from './schemas/v1/bigquery.traffic_rules.schema'
export { buildSystemTrafficRuleNamesBackfillQuery } from './schemas/v1/bigquery.traffic_rules.schema'
export { systemTrafficRuleNamesBackfillPendingPredicate } from './schemas/v1/bigquery.traffic_rules.schema'
export { ATTRIBUTION_SIGNAL_MAPPINGS_TABLE_ID } from './schemas/v1/bigquery.attribution_signal_mappings.schema'
export { ATTRIBUTION_SIGNAL_MAPPINGS_TABLE_SCHEMA } from './schemas/v1/bigquery.attribution_signal_mappings.schema'
export { EXCLUDED_URL_PARAMS_TABLE_ID } from './schemas/v1/bigquery.excluded_url_params.schema'
export { EXCLUDED_URL_PARAMS_TABLE_SCHEMA } from './schemas/v1/bigquery.excluded_url_params.schema'
export { buildExcludedUrlParamsSeedQuery } from './schemas/v1/bigquery.excluded_url_params.schema'
export { TRAFFIC_SETTINGS_REVISIONS_TABLE_ID } from './schemas/v1/bigquery.traffic_settings_revisions.schema'
export { TRAFFIC_SETTINGS_REVISIONS_TABLE_SCHEMA } from './schemas/v1/bigquery.traffic_settings_revisions.schema'
export { TRAFFIC_SETTINGS_REVISION_RESOURCES } from './schemas/v1/bigquery.traffic_settings_revisions.schema'
export { buildTrafficSettingsRevisionsSeedQuery } from './schemas/v1/bigquery.traffic_settings_revisions.schema'
