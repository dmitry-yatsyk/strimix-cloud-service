import { z } from 'zod'
import {
  EXCLUDED_REFERRER_WRITABLE_COLUMNS,
  EXCLUDED_URL_PARAM_WRITABLE_COLUMNS,
  MAPPING_ENTITIES,
  MAPPING_MODES,
  MAPPING_PARAM_SOURCES,
  MAPPING_WRITABLE_COLUMNS,
  TRAFFIC_RULE_STAGES,
  TRAFFIC_RULE_TARGETS,
  TRAFFIC_RULE_WRITABLE_COLUMNS,
  TRAFFIC_SETTINGS_ITEM_RESOURCES,
  TRAFFIC_SETTINGS_LIMITS,
  TRAFFIC_SETTINGS_RESOURCES,
  type TrafficSettingsItemResource,
} from '@modules/traffic-settings'

/**
 * Request schemas of the traffic settings API.
 *
 * Three properties are enforced here rather than in the domain layer, because
 * they are about the message and not about the configuration:
 *  - every write envelope is STRICT, so an unknown key is rejected instead of
 *    silently ignored. A client that sends `paramKeyRegex` must be told, not left
 *    believing it saved something;
 *  - read-only fields (`param_id`, `rule_id`, `mapping_id`, `is_system`) are
 *    absent from the write schemas, so strictness alone rejects them;
 *  - an omitted optional field becomes an explicit `null`. PUT is a full
 *    replacement of the mutable fields, and `null` is the stored value for "not
 *    configured", so defaulting keeps the write path free of `undefined`, which
 *    the domain checks would otherwise have to special-case.
 */

const { REGEX_MAX_LENGTH, DESCRIPTION_MAX_LENGTH, STRING_OUTPUT_MAX_LENGTH, PARAM_KEY_MAX_LENGTH } =
  TRAFFIC_SETTINGS_LIMITS

/** Opaque decimal revision string. Not a number: it versions, it does not count. */
const expectedRevisionSchema = z
  .string({ message: '"expected_revision" must be a string' })
  .regex(/^\d+$/, '"expected_revision" must be a decimal string')

const idSchema = z
  .string({ message: 'Resource id must be a string' })
  .min(1, 'Resource id must not be empty')
  .max(256, 'Resource id is too long')
  .regex(/^[A-Za-z0-9_-]+$/, 'Resource id contains unsupported characters')

const nullableString = (maxLength: number, label: string) =>
  z
    .string({ message: `"${label}" must be a string` })
    .max(maxLength, `"${label}" must be at most ${maxLength} characters`)
    .nullable()
    .default(null)

const regexColumn = (label: string) => nullableString(REGEX_MAX_LENGTH, label)
const outputColumn = (label: string) => nullableString(STRING_OUTPUT_MAX_LENGTH, label)
const paramKeyColumn = (label: string) => nullableString(PARAM_KEY_MAX_LENGTH, label)

/**
 * A whole number that survives a JSON round trip. Fractions, `NaN` and numeric
 * strings are rejected; a negative value is not, because the ordering is
 * "lower runs earlier" and no lower bound is part of the domain.
 */
const prioritySchema = z
  .number({ message: '"priority" must be a number' })
  .int('"priority" must be a whole number')
  .refine((value) => Number.isSafeInteger(value), {
    message: '"priority" must be representable without loss of precision',
  })

const excludedUrlParamItemSchema = z.strictObject({
  param_key_regex: z
    .string({ message: '"param_key_regex" must be a string' })
    .max(REGEX_MAX_LENGTH, `"param_key_regex" must be at most ${REGEX_MAX_LENGTH} characters`),
  is_active: z.boolean({ message: '"is_active" must be a boolean' }),
  description: nullableString(DESCRIPTION_MAX_LENGTH, 'description'),
})

/**
 * The host is only length-checked here. Its real shape — scheme, path, port,
 * punycode, trailing dot — is decided by the domain normalizer, so that the
 * message a user sees is the same one `POST /validate` previewed.
 */
const excludedReferrerItemSchema = z.strictObject({
  host: z
    .string({ message: '"host" must be a string' })
    .max(
      TRAFFIC_SETTINGS_LIMITS.HOSTNAME_MAX_LENGTH,
      `"host" must be at most ${TRAFFIC_SETTINGS_LIMITS.HOSTNAME_MAX_LENGTH} characters`,
    ),
  is_active: z.boolean({ message: '"is_active" must be a boolean' }),
  description: nullableString(DESCRIPTION_MAX_LENGTH, 'description'),
})

const trafficRuleItemSchema = z.strictObject({
  priority: prioritySchema,
  is_active: z.boolean({ message: '"is_active" must be a boolean' }),
  stage: z.enum(TRAFFIC_RULE_STAGES, {
    message: `"stage" must be one of: ${TRAFFIC_RULE_STAGES.join(', ')}`,
  }),
  target: z.enum(TRAFFIC_RULE_TARGETS, {
    message: `"target" must be one of: ${TRAFFIC_RULE_TARGETS.join(', ')}`,
  }),
  applies_to_web: z
    .boolean({ message: '"applies_to_web" must be a boolean' })
    .nullable()
    .default(null),
  source_regex: regexColumn('source_regex'),
  medium_regex: regexColumn('medium_regex'),
  campaign_regex: regexColumn('campaign_regex'),
  content_regex: regexColumn('content_regex'),
  term_regex: regexColumn('term_regex'),
  strimix_refid_regex: regexColumn('strimix_refid_regex'),
  data_source_regex: regexColumn('data_source_regex'),
  campaign_id_regex: regexColumn('campaign_id_regex'),
  campaign_name_regex: regexColumn('campaign_name_regex'),
  adgroup_id_regex: regexColumn('adgroup_id_regex'),
  adgroup_name_regex: regexColumn('adgroup_name_regex'),
  ad_id_regex: regexColumn('ad_id_regex'),
  ad_name_regex: regexColumn('ad_name_regex'),
  ad_destination_regex: regexColumn('ad_destination_regex'),
  url_param_key: paramKeyColumn('url_param_key'),
  url_param_value_regex: regexColumn('url_param_value_regex'),
  traffic_origin_regex: regexColumn('traffic_origin_regex'),
  set_source: outputColumn('set_source'),
  set_medium: outputColumn('set_medium'),
  set_campaign: outputColumn('set_campaign'),
  set_content: outputColumn('set_content'),
  set_term: outputColumn('set_term'),
  set_strimix_refid: outputColumn('set_strimix_refid'),
  set_traffic_origin: outputColumn('set_traffic_origin'),
  set_traffic_channel: outputColumn('set_traffic_channel'),
  name: nullableString(DESCRIPTION_MAX_LENGTH, 'name'),
  description: nullableString(DESCRIPTION_MAX_LENGTH, 'description'),
})

const attributionSignalMappingItemSchema = z.strictObject({
  priority: prioritySchema,
  is_active: z.boolean({ message: '"is_active" must be a boolean' }),
  entity: z.enum(MAPPING_ENTITIES, {
    message: `"entity" must be one of: ${MAPPING_ENTITIES.join(', ')}`,
  }),
  param_source: z.enum(MAPPING_PARAM_SOURCES, {
    message: `"param_source" must be one of: ${MAPPING_PARAM_SOURCES.join(', ')}`,
  }),
  source_param_key: paramKeyColumn('source_param_key'),
  medium_param_key: paramKeyColumn('medium_param_key'),
  campaign_param_key: paramKeyColumn('campaign_param_key'),
  content_param_key: paramKeyColumn('content_param_key'),
  term_param_key: paramKeyColumn('term_param_key'),
  strimix_refid_param_key: paramKeyColumn('strimix_refid_param_key'),
  campaign_id_param_key: paramKeyColumn('campaign_id_param_key'),
  campaign_name_param_key: paramKeyColumn('campaign_name_param_key'),
  adgroup_id_param_key: paramKeyColumn('adgroup_id_param_key'),
  adgroup_name_param_key: paramKeyColumn('adgroup_name_param_key'),
  ad_id_param_key: paramKeyColumn('ad_id_param_key'),
  ad_name_param_key: paramKeyColumn('ad_name_param_key'),
  match_source_regex: regexColumn('match_source_regex'),
  match_medium_regex: regexColumn('match_medium_regex'),
  match_campaign_regex: regexColumn('match_campaign_regex'),
  match_content_regex: regexColumn('match_content_regex'),
  match_term_regex: regexColumn('match_term_regex'),
  match_strimix_refid_regex: regexColumn('match_strimix_refid_regex'),
  match_campaign_id_regex: regexColumn('match_campaign_id_regex'),
  match_campaign_name_regex: regexColumn('match_campaign_name_regex'),
  match_adgroup_id_regex: regexColumn('match_adgroup_id_regex'),
  match_adgroup_name_regex: regexColumn('match_adgroup_name_regex'),
  match_ad_id_regex: regexColumn('match_ad_id_regex'),
  match_ad_name_regex: regexColumn('match_ad_name_regex'),
  ad_destination_regex: regexColumn('ad_destination_regex'),
  data_source_regex: regexColumn('data_source_regex'),
  event_name: nullableString(TRAFFIC_SETTINGS_LIMITS.EVENT_NAME_MAX_LENGTH, 'event_name'),
  mode: z.enum(MAPPING_MODES, {
    message: `"mode" must be one of: ${MAPPING_MODES.join(', ')}`,
  }),
  name: nullableString(DESCRIPTION_MAX_LENGTH, 'name'),
  description: nullableString(DESCRIPTION_MAX_LENGTH, 'description'),
})

const ITEM_SCHEMAS: Record<TrafficSettingsItemResource, z.ZodObject> = {
  'excluded-url-params': excludedUrlParamItemSchema,
  'excluded-referrers': excludedReferrerItemSchema,
  'traffic-rules': trafficRuleItemSchema,
  'attribution-signal-mappings': attributionSignalMappingItemSchema,
}

/**
 * Fails at startup if a schema and its writable-column allowlist disagree.
 *
 * Without this, adding a column to the BigQuery schema and the allowlist while
 * forgetting the request schema would produce a write that stores NULL for the new
 * field and reports success — the quietest possible kind of data loss.
 */
function assertItemSchemasCoverWritableColumns(): void {
  const expected: Record<TrafficSettingsItemResource, readonly string[]> = {
    'excluded-url-params': EXCLUDED_URL_PARAM_WRITABLE_COLUMNS,
    'excluded-referrers': EXCLUDED_REFERRER_WRITABLE_COLUMNS,
    'traffic-rules': TRAFFIC_RULE_WRITABLE_COLUMNS,
    'attribution-signal-mappings': MAPPING_WRITABLE_COLUMNS,
  }

  for (const resource of TRAFFIC_SETTINGS_ITEM_RESOURCES) {
    const schemaKeys = new Set(Object.keys(ITEM_SCHEMAS[resource].shape))
    const allowlist = expected[resource]

    for (const column of allowlist) {
      if (!schemaKeys.has(column)) {
        throw new Error(
          `Traffic settings request schema for "${resource}" is missing writable column "${column}"`,
        )
      }
    }
    for (const key of schemaKeys) {
      if (!(allowlist as readonly string[]).includes(key)) {
        throw new Error(
          `Traffic settings request schema for "${resource}" accepts "${key}", which is not a writable column`,
        )
      }
    }
  }
}

assertItemSchemasCoverWritableColumns()

const trafficSettingsProjectParamsSchema = z.object({
  projectId: z.coerce.number().int().positive(),
})

const trafficSettingsResourceParamsSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  resource: z.enum(TRAFFIC_SETTINGS_ITEM_RESOURCES, {
    message: `"resource" must be one of: ${TRAFFIC_SETTINGS_ITEM_RESOURCES.join(', ')}`,
  }),
})

const trafficSettingsItemParamsSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  resource: z.enum(TRAFFIC_SETTINGS_ITEM_RESOURCES, {
    message: `"resource" must be one of: ${TRAFFIC_SETTINGS_ITEM_RESOURCES.join(', ')}`,
  }),
  id: idSchema,
})

/** `POST` / `PUT` of an id-addressed resource. */
const itemMutationBodySchema = (resource: TrafficSettingsItemResource) =>
  z.strictObject({
    expected_revision: expectedRevisionSchema,
    item: ITEM_SCHEMAS[resource],
  })

const setActiveBodySchema = z.strictObject({
  expected_revision: expectedRevisionSchema,
  is_active: z.boolean({ message: '"is_active" must be a boolean' }),
})

/** DELETE carries a body: the revision guard applies to it like any other write. */
const deleteBodySchema = z.strictObject({
  expected_revision: expectedRevisionSchema,
})

/**
 * Bulk add of referrer hosts. One call is capped here; the total row count is
 * capped inside the write transaction, where repeated calls are also covered.
 */
const addReferrerHostsBodySchema = z.strictObject({
  expected_revision: expectedRevisionSchema,
  hosts: z
    .array(z.string({ message: 'Each host must be a string' }), {
      message: '"hosts" must be an array',
    })
    .min(1, '"hosts" must not be empty')
    .max(
      TRAFFIC_SETTINGS_LIMITS.HOSTS_MAX_COUNT,
      `At most ${TRAFFIC_SETTINGS_LIMITS.HOSTS_MAX_COUNT} hosts are supported`,
    ),
})

/**
 * `POST /validate` keeps `item` loose on purpose: its job is to REPORT problems
 * per field, so a shape problem inside the draft must come back as a validation
 * result, not as a rejected request. Only the envelope is strict.
 */
const validateBodySchema = z.strictObject({
  resource: z.enum(TRAFFIC_SETTINGS_RESOURCES, {
    message: `"resource" must be one of: ${TRAFFIC_SETTINGS_RESOURCES.join(', ')}`,
  }),
  item: z.record(z.string(), z.unknown(), { message: '"item" must be an object' }),
  id: idSchema.nullable().default(null),
})

const previewExcludedUrlParamBodySchema = z.strictObject({
  url: z
    .string({ message: '"url" must be a string' })
    .min(1, '"url" must not be empty')
    .max(REGEX_MAX_LENGTH, `"url" must be at most ${REGEX_MAX_LENGTH} characters`),
  item: excludedUrlParamItemSchema,
})

/** PATCH identification-job/status — operator may set ACTIVE or PAUSED only. */
const updateIdentificationJobStatusBodySchema = z.strictObject({
  status: z.enum(['ACTIVE', 'PAUSED'], {
    message: '"status" must be ACTIVE or PAUSED',
  }),
})

export {
  ITEM_SCHEMAS,
  addReferrerHostsBodySchema,
  attributionSignalMappingItemSchema,
  deleteBodySchema,
  excludedReferrerItemSchema,
  excludedUrlParamItemSchema,
  expectedRevisionSchema,
  itemMutationBodySchema,
  previewExcludedUrlParamBodySchema,
  setActiveBodySchema,
  trafficRuleItemSchema,
  trafficSettingsItemParamsSchema,
  trafficSettingsProjectParamsSchema,
  trafficSettingsResourceParamsSchema,
  updateIdentificationJobStatusBodySchema,
  validateBodySchema,
}
