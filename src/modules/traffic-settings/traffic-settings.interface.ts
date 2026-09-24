import type { MultiRegionLocation } from '@modules/gcloud/bigquery'
import type {
  MappingEntity,
  MappingMode,
  MappingParamSource,
  TrafficRuleStage,
  TrafficRuleTarget,
  TrafficSettingsResource,
  TrafficSettingsResourceState,
} from './traffic-settings.constants'

/**
 * DTOs keep the BigQuery field names in snake_case: the wire format of this
 * feature is the schema of the four config tables. `null` always means "not
 * configured" — never an implicit default.
 */

export interface IExcludedUrlParam {
  param_id: string
  param_key_regex: string
  is_active: boolean
  is_system: boolean
  description: string | null
}

/** Mutable part of an excluded url param. IDs and is_system are never accepted. */
export interface IExcludedUrlParamInput {
  param_key_regex: string
  is_active: boolean
  description: string | null
}

export interface IExcludedReferrer {
  referrer_id: string
  /** Normalized hostname: lowercase, no scheme, no port, punycode for IDN. */
  host: string
  is_active: boolean
  description: string | null
}

/** Mutable part of an excluded referrer. The ID is never accepted from a client. */
export type IExcludedReferrerInput = Omit<IExcludedReferrer, 'referrer_id'>

export interface ITrafficRule {
  rule_id: string
  priority: number
  is_active: boolean
  is_system: boolean
  stage: TrafficRuleStage
  target: TrafficRuleTarget
  applies_to_web: boolean | null
  source_regex: string | null
  medium_regex: string | null
  campaign_regex: string | null
  content_regex: string | null
  term_regex: string | null
  strimix_refid_regex: string | null
  data_source_regex: string | null
  campaign_id_regex: string | null
  campaign_name_regex: string | null
  adgroup_id_regex: string | null
  adgroup_name_regex: string | null
  ad_id_regex: string | null
  ad_name_regex: string | null
  ad_destination_regex: string | null
  url_param_key: string | null
  url_param_value_regex: string | null
  traffic_origin_regex: string | null
  set_source: string | null
  set_medium: string | null
  set_campaign: string | null
  set_content: string | null
  set_term: string | null
  set_strimix_refid: string | null
  set_traffic_origin: string | null
  set_traffic_channel: string | null
  name: string | null
  description: string | null
}

export type ITrafficRuleInput = Omit<ITrafficRule, 'rule_id' | 'is_system'>

export interface IAttributionSignalMapping {
  mapping_id: string
  priority: number
  is_active: boolean
  entity: MappingEntity
  param_source: MappingParamSource
  source_param_key: string | null
  medium_param_key: string | null
  campaign_param_key: string | null
  content_param_key: string | null
  term_param_key: string | null
  strimix_refid_param_key: string | null
  campaign_id_param_key: string | null
  campaign_name_param_key: string | null
  adgroup_id_param_key: string | null
  adgroup_name_param_key: string | null
  ad_id_param_key: string | null
  ad_name_param_key: string | null
  match_source_regex: string | null
  match_medium_regex: string | null
  match_campaign_regex: string | null
  match_content_regex: string | null
  match_term_regex: string | null
  match_strimix_refid_regex: string | null
  match_campaign_id_regex: string | null
  match_campaign_name_regex: string | null
  match_adgroup_id_regex: string | null
  match_adgroup_name_regex: string | null
  match_ad_id_regex: string | null
  match_ad_name_regex: string | null
  ad_destination_regex: string | null
  data_source_regex: string | null
  event_name: string | null
  mode: MappingMode
  name: string | null
  description: string | null
}

export type IAttributionSignalMappingInput = Omit<IAttributionSignalMapping, 'mapping_id'>

export type TrafficSettingsItem =
  | IExcludedUrlParam
  | IExcludedReferrer
  | ITrafficRule
  | IAttributionSignalMapping

export type TrafficSettingsItemInput =
  | IExcludedUrlParamInput
  | IExcludedReferrerInput
  | ITrafficRuleInput
  | IAttributionSignalMappingInput

/**
 * Opaque decimal string for the client. It versions the WHOLE collection of one
 * resource inside one project, not a single row, and it is not a timestamp.
 * Kept as a string on the wire because BigQuery INTEGER exceeds the safe JSON
 * number range in principle.
 */
export type Revision = string

export interface ICollectionResult<TItem> {
  items: TItem[]
  revision: Revision
}

export interface IItemResult<TItem> {
  item: TItem
  revision: Revision
}

/** How a saved change reaches reports: after the next successful attribution run. */
export interface IApplicationInfo {
  mode: 'next_scheduled_run'
  scheduled_query_configured?: boolean
}

export interface IMutationResult<TItem> {
  item: TItem
  revision: Revision
  application: IApplicationInfo
}

/**
 * Result of adding several hosts in one call. Bulk add is the one place where a
 * client submits a list, because pasting a set of own domains is the normal way
 * this resource gets filled; everything else is one row at a time.
 */
export interface IBulkReferrerResult {
  items: IExcludedReferrer[]
  skipped_hosts: string[]
  revision: Revision
  application: IApplicationInfo
}

export interface IDeleteResult {
  deleted_id: string
  revision: Revision
  application: IApplicationInfo
}

export interface IValidationIssue {
  /** Domain field name, or a readable path such as `hosts[2]`. */
  field: string
  code: string
  message: string
}

export interface IValidationResult {
  valid: boolean
  errors: IValidationIssue[]
  warnings: IValidationIssue[]
}

export interface IUrlPreviewResult {
  normalized_landing_page: string | null
  excluded_keys: string[]
  retained_keys: string[]
  warnings: IValidationIssue[]
}

export interface IResourceReadiness {
  readable: boolean
  writable: boolean
  state: TrafficSettingsResourceState
  /** Stable machine-readable cause when the resource is not `ready`. */
  reason_code?: string
  /** Safe operator-facing explanation. Never carries SQL or GCP identifiers. */
  message?: string
}

export interface IMetaResult {
  project_id: number
  application: IApplicationInfo
  resources: Record<TrafficSettingsResource, IResourceReadiness>
}

/**
 * Resolved BigQuery placement of one project. Always comes from
 * ProjectResourcesRepository — never from a request and never guessed from a
 * dataset naming pattern.
 */
export interface IProjectBigQueryContext {
  projectId: number
  gcpProjectId: string
  datasetId: string
  datasetLocation: MultiRegionLocation
  /** Table ids actually registered for this project, keyed by resource slug. */
  tableIds: Record<TrafficSettingsResource, string | null>
  revisionsTableId: string
  scheduledQueryName: string | null
}

/** Trusted actor forwarded by the gateway; never taken from a browser header. */
export interface ITrafficSettingsActor {
  actorId: string | null
  requestId: string | null
}
