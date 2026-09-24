import {
  ALLOWED_AD_DESTINATIONS,
  ALLOWED_DATA_SOURCES,
  MAPPING_AD_PARAM_KEY_COLUMNS,
  MAPPING_BOUNDARY_REGEX_COLUMNS,
  MAPPING_ENTITIES,
  MAPPING_ENTITY_PARAM_SOURCE,
  MAPPING_LABEL_PARAM_KEY_COLUMNS,
  MAPPING_MATCH_REGEX_COLUMNS,
  MAPPING_MATCH_REGEX_REQUIRED_PARAM_KEY,
  MAPPING_MODES,
  MAPPING_PARAM_KEY_COLUMNS,
  MAPPING_PARAM_SOURCES,
  TRAFFIC_RULE_AD_DERIVED_CONDITION_COLUMNS,
  TRAFFIC_RULE_CLASSIFICATION_OUTPUT_COLUMNS,
  TRAFFIC_RULE_CONDITION_COLUMNS,
  TRAFFIC_RULE_OUTPUT_PLACEHOLDERS,
  TRAFFIC_RULE_REGEX_COLUMNS,
  TRAFFIC_RULE_STAGES,
  TRAFFIC_RULE_TARGETS,
  TRAFFIC_RULE_UTM_OUTPUT_COLUMNS,
  TRAFFIC_SETTINGS_LIMITS,
  TRAFFIC_RULE_WRITABLE_COLUMNS,
  MAPPING_WRITABLE_COLUMNS,
  MAPPING_REGEX_COLUMNS,
} from './traffic-settings.constants'
import { normalizeHost } from './host-normalization'
import type {
  IAttributionSignalMappingInput,
  IExcludedReferrerInput,
  IExcludedUrlParamInput,
  ITrafficRuleInput,
  IValidationIssue,
} from './traffic-settings.interface'

/**
 * Cross-field invariants of the four config resources, expressed once and used
 * by both `POST /validate` and every write. A draft that validates is not
 * guaranteed to save — concurrency and priority conflicts are re-checked inside
 * the write transaction — but nothing is ever written without passing here.
 *
 * Two deliberate non-behaviours:
 *  - an existing empty string is never turned into `null` and vice versa. `null`
 *    means "no condition"; `''` is a condition that matches everything. Both are
 *    accepted, the surprising one is reported as a warning.
 *  - values are not trimmed or lower-cased. Regexes, literal outputs, ad entity
 *    names and container keys are case- and content-sensitive.
 */

export interface IDomainValidationOutcome {
  errors: IValidationIssue[]
  warnings: IValidationIssue[]
}

function error(field: string, code: string, message: string): IValidationIssue {
  return { field, code, message }
}

/**
 * `POST /validate` keeps omitted fields as `undefined`; a write fills them with
 * `null`. Treating the two as different would invent errors for a legitimate
 * partial draft. After this, "not set" is always `null`.
 */
function withOmittedFieldsAsNull<T extends Record<string, unknown>>(
  item: T,
  columns: readonly string[],
): T {
  const filled: Record<string, unknown> = { ...item }
  for (const column of columns) {
    if (typeof filled[column] === 'undefined') {
      filled[column] = null
    }
  }
  return filled as T
}

/** A JSON number that is an exact integer and survives a JS round trip. */
function isLosslessInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value)
}

function checkStringLength(
  value: string | null,
  field: string,
  maxLength: number,
  errors: IValidationIssue[],
): void {
  if (value !== null && value.length > maxLength) {
    errors.push(error(field, 'VALUE_TOO_LONG', `Value must be at most ${maxLength} characters`))
  }
}

function checkEmptyStringWarning(
  value: string | null,
  field: string,
  warnings: IValidationIssue[],
): void {
  if (value === '') {
    warnings.push(
      error(
        field,
        'EMPTY_PATTERN_MATCHES_EVERYTHING',
        'An empty pattern is a condition that matches any value. Clear the field to remove the condition instead',
      ),
    )
  }
}

/**
 * `data_source_regex` / `ad_destination_regex` are exact job constants, not free
 * regex. Null and blank mean unrestricted; any other value must match the
 * allowlist character-for-character (no `^…$` wrappers, no trimming).
 */
function checkAllowedConstant(
  value: string | null,
  field: string,
  allowed: readonly string[],
  errors: IValidationIssue[],
): void {
  if (value === null || value.trim() === '') {
    return
  }

  if (!(allowed as readonly string[]).includes(value)) {
    errors.push(
      error(field, 'INVALID_ENUM', `${field} must be one of: ${allowed.join(', ')}`),
    )
  }
}

function checkDataSourceAndAdDestinationConstants(
  dataSourceRegex: string | null,
  adDestinationRegex: string | null,
  errors: IValidationIssue[],
): void {
  checkAllowedConstant(dataSourceRegex, 'data_source_regex', ALLOWED_DATA_SOURCES, errors)
  checkAllowedConstant(adDestinationRegex, 'ad_destination_regex', ALLOWED_AD_DESTINATIONS, errors)
}

/** These two columns are exact constants; blank means unrestricted, not "match all". */
const EXACT_CONSTANT_REGEX_COLUMNS = new Set(['data_source_regex', 'ad_destination_regex'])

function checkPriority(priority: unknown, field: string, errors: IValidationIssue[]): void {
  if (!isLosslessInteger(priority)) {
    errors.push(
      error(
        field,
        'PRIORITY_NOT_AN_INTEGER',
        'Priority must be a whole number representable without loss of precision',
      ),
    )
  }
}

/**
 * Reports placeholders that are not on the allowlist. Only the seven ad identity
 * placeholders exist; there are no arbitrary macros and no expression
 * evaluation.
 */
function checkPlaceholders(
  value: string | null,
  field: string,
  errors: IValidationIssue[],
): string[] {
  if (value === null) {
    return []
  }

  const used: string[] = []
  const pattern = /\{([^{}]*)\}/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(value)) !== null) {
    const name = match[1]
    if ((TRAFFIC_RULE_OUTPUT_PLACEHOLDERS as readonly string[]).includes(name)) {
      used.push(name)
    } else {
      errors.push(
        error(
          field,
          'UNKNOWN_PLACEHOLDER',
          `Unknown placeholder "{${name}}". Allowed: ${TRAFFIC_RULE_OUTPUT_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}`,
        ),
      )
    }
  }

  return used
}

export function validateExcludedUrlParamInput(
  item: IExcludedUrlParamInput,
): IDomainValidationOutcome {
  const errors: IValidationIssue[] = []
  const warnings: IValidationIssue[] = []

  if (typeof item.param_key_regex !== 'string' || item.param_key_regex.trim() === '') {
    errors.push(
      error(
        'param_key_regex',
        'PARAM_KEY_REGEX_REQUIRED',
        'A parameter key pattern is required and must not be blank',
      ),
    )
  }
  checkStringLength(
    typeof item.param_key_regex === 'string' ? item.param_key_regex : null,
    'param_key_regex',
    TRAFFIC_SETTINGS_LIMITS.REGEX_MAX_LENGTH,
    errors,
  )

  if (typeof item.is_active !== 'boolean') {
    errors.push(error('is_active', 'NOT_A_BOOLEAN', 'is_active must be a boolean'))
  }

  checkStringLength(
    item.description,
    'description',
    TRAFFIC_SETTINGS_LIMITS.DESCRIPTION_MAX_LENGTH,
    errors,
  )

  return { errors, warnings }
}

/**
 * One excluded referrer. The host carries the whole meaning of the row, so it is
 * validated through the same normalizer the bulk path and the preview use: a host
 * that the UI showed as accepted must not be rejected here, and vice versa.
 */
export function validateExcludedReferrerInput(
  item: IExcludedReferrerInput,
): IDomainValidationOutcome {
  const errors: IValidationIssue[] = []
  const warnings: IValidationIssue[] = []

  if (typeof item.host !== 'string' || item.host.trim() === '') {
    errors.push(error('host', 'HOST_REQUIRED', 'A host is required and must not be blank'))
  } else {
    const { error: hostError } = normalizeHost(item.host, 'host')
    if (hostError) {
      errors.push(hostError)
    }
  }

  if (typeof item.is_active !== 'boolean') {
    errors.push(error('is_active', 'NOT_A_BOOLEAN', 'is_active must be a boolean'))
  }

  checkStringLength(
    item.description,
    'description',
    TRAFFIC_SETTINGS_LIMITS.DESCRIPTION_MAX_LENGTH,
    errors,
  )

  return { errors, warnings }
}

export function validateTrafficRuleInput(item: ITrafficRuleInput): IDomainValidationOutcome {
  item = withOmittedFieldsAsNull(item, TRAFFIC_RULE_WRITABLE_COLUMNS)
  const errors: IValidationIssue[] = []
  const warnings: IValidationIssue[] = []

  checkPriority(item.priority, 'priority', errors)

  if (typeof item.is_active !== 'boolean') {
    errors.push(error('is_active', 'NOT_A_BOOLEAN', 'is_active must be a boolean'))
  }

  checkStringLength(
    item.name,
    'name',
    TRAFFIC_SETTINGS_LIMITS.DESCRIPTION_MAX_LENGTH,
    errors,
  )

  checkStringLength(
    item.description,
    'description',
    TRAFFIC_SETTINGS_LIMITS.DESCRIPTION_MAX_LENGTH,
    errors,
  )

  if (!(TRAFFIC_RULE_STAGES as readonly string[]).includes(item.stage)) {
    errors.push(
      error('stage', 'INVALID_ENUM', `stage must be one of: ${TRAFFIC_RULE_STAGES.join(', ')}`),
    )
    // Without a known stage the cross-stage rules below are meaningless.
    return { errors, warnings }
  }

  if (!(TRAFFIC_RULE_TARGETS as readonly string[]).includes(item.target)) {
    errors.push(
      error('target', 'INVALID_ENUM', `target must be one of: ${TRAFFIC_RULE_TARGETS.join(', ')}`),
    )
  }

  for (const column of TRAFFIC_RULE_REGEX_COLUMNS) {
    const value = item[column]
    checkStringLength(value, column, TRAFFIC_SETTINGS_LIMITS.REGEX_MAX_LENGTH, errors)
    if (!EXACT_CONSTANT_REGEX_COLUMNS.has(column)) {
      checkEmptyStringWarning(value, column, warnings)
    }
  }

  checkDataSourceAndAdDestinationConstants(
    item.data_source_regex,
    item.ad_destination_regex,
    errors,
  )

  for (const column of [
    ...TRAFFIC_RULE_UTM_OUTPUT_COLUMNS,
    ...TRAFFIC_RULE_CLASSIFICATION_OUTPUT_COLUMNS,
  ]) {
    checkStringLength(
      item[column],
      column,
      TRAFFIC_SETTINGS_LIMITS.STRING_OUTPUT_MAX_LENGTH,
      errors,
    )
  }

  checkStringLength(
    item.url_param_key,
    'url_param_key',
    TRAFFIC_SETTINGS_LIMITS.PARAM_KEY_MAX_LENGTH,
    errors,
  )

  const utmOutputsSet = TRAFFIC_RULE_UTM_OUTPUT_COLUMNS.filter((column) => item[column] !== null)
  const classificationOutputsSet = TRAFFIC_RULE_CLASSIFICATION_OUTPUT_COLUMNS.filter(
    (column) => item[column] !== null,
  )

  if (item.stage === 'utm') {
    if (utmOutputsSet.length === 0) {
      errors.push(
        error(
          'set_source',
          'UTM_RULE_WITHOUT_OUTPUT',
          'A utm rule must set at least one of source, medium, campaign, content, term or strimix_refid',
        ),
      )
    }
    for (const column of classificationOutputsSet) {
      errors.push(
        error(
          column,
          'OUTPUT_NOT_ALLOWED_FOR_STAGE',
          'Classification outputs belong to the origin and channel stages',
        ),
      )
    }
  } else {
    for (const column of utmOutputsSet) {
      errors.push(
        error(column, 'OUTPUT_NOT_ALLOWED_FOR_STAGE', 'Label outputs belong to the utm stage'),
      )
    }
  }

  if (item.stage === 'origin') {
    if (item.set_traffic_origin === null) {
      errors.push(
        error(
          'set_traffic_origin',
          'ORIGIN_RULE_WITHOUT_OUTPUT',
          'An origin rule must set the traffic origin',
        ),
      )
    }
    if (item.set_traffic_channel !== null) {
      errors.push(
        error(
          'set_traffic_channel',
          'OUTPUT_NOT_ALLOWED_FOR_STAGE',
          'The traffic channel is set by channel-stage rules',
        ),
      )
    }
  }

  if (item.stage === 'channel') {
    if (item.set_traffic_channel === null) {
      errors.push(
        error(
          'set_traffic_channel',
          'CHANNEL_RULE_WITHOUT_OUTPUT',
          'A channel rule must set the traffic channel',
        ),
      )
    }
    if (item.set_traffic_origin !== null) {
      errors.push(
        error(
          'set_traffic_origin',
          'OUTPUT_NOT_ALLOWED_FOR_STAGE',
          'The traffic origin is set by origin-stage rules',
        ),
      )
    }
  }

  // traffic_origin_regex reads a value that only exists once the origin stage has
  // run, so it is meaningful for channel rules only.
  if (item.traffic_origin_regex !== null && item.stage !== 'channel') {
    errors.push(
      error(
        'traffic_origin_regex',
        'CONDITION_NOT_ALLOWED_FOR_STAGE',
        'A condition on the resolved traffic origin is only available for channel rules',
      ),
    )
  }

  if (item.applies_to_web === true) {
    if (item.stage !== 'utm') {
      errors.push(
        error(
          'applies_to_web',
          'APPLIES_TO_WEB_NOT_ALLOWED_FOR_STAGE',
          'Applying a rule to web visits is only available for utm rules',
        ),
      )
    }
    if (item.target === 'ad_cost') {
      errors.push(
        error(
          'applies_to_web',
          'APPLIES_TO_WEB_REQUIRES_VISIT_TARGET',
          'Applying a rule to web visits requires a target that includes visits',
        ),
      )
    }
  }

  // A key without a regex is an existence check; a regex without a key has
  // nothing to test.
  if (item.url_param_value_regex !== null && (item.url_param_key ?? '') === '') {
    errors.push(
      error(
        'url_param_key',
        'URL_PARAM_KEY_REQUIRED',
        'A URL parameter value pattern requires the parameter key',
      ),
    )
  }

  const placeholderFields: string[] = []
  for (const column of TRAFFIC_RULE_UTM_OUTPUT_COLUMNS) {
    const used = checkPlaceholders(item[column], column, errors)
    if (used.length > 0) {
      placeholderFields.push(column)
    }
  }
  for (const column of TRAFFIC_RULE_CLASSIFICATION_OUTPUT_COLUMNS) {
    if (item[column] !== null && /\{[^{}]*\}/.test(item[column] as string)) {
      errors.push(
        error(
          column,
          'PLACEHOLDER_NOT_ALLOWED',
          'Placeholders are only supported in label outputs of utm rules',
        ),
      )
    }
  }

  if (placeholderFields.length > 0) {
    warnings.push(
      error(
        placeholderFields[0],
        'PLACEHOLDER_RULE_REQUIRES_EMPTY_LABELS',
        'A rule using placeholders applies only to rows where source, medium, campaign, content and term are all empty',
      ),
    )
  }

  const adDerivedUsed = TRAFFIC_RULE_AD_DERIVED_CONDITION_COLUMNS.filter(
    (column) => item[column] !== null,
  )
  if (adDerivedUsed.length > 0) {
    warnings.push(
      error(
        adDerivedUsed[0],
        'AD_DERIVED_CONDITION_SCOPE',
        'Ad conditions are checked on cost rows and on the resolved group of a synthetic visit. They never match web visits, even with "applies to web" enabled',
      ),
    )
    if (item.applies_to_web === true) {
      warnings.push(
        error(
          'applies_to_web',
          'AD_DERIVED_CONDITION_NEVER_MATCHES_WEB',
          'This rule applies to web visits but also has ad conditions, which web visits can never satisfy',
        ),
      )
    }
  }

  if (item.url_param_key !== null) {
    warnings.push(
      error(
        'url_param_key',
        'URL_PARAMS_EMPTY_FOR_SYNTHETIC_VISITS',
        'Synthetic visits have no URL parameters, so this condition only matches web visits and cost rows',
      ),
    )
  }

  const conditionsUsed = TRAFFIC_RULE_CONDITION_COLUMNS.filter((column) => item[column] !== null)
  if (conditionsUsed.length === 0) {
    warnings.push(
      error(
        'stage',
        'RULE_WITHOUT_CONDITIONS',
        'This rule has no conditions and therefore applies to every matching record',
      ),
    )
  }

  return { errors, warnings }
}

export function validateAttributionSignalMappingInput(
  item: IAttributionSignalMappingInput,
): IDomainValidationOutcome {
  item = withOmittedFieldsAsNull(item, MAPPING_WRITABLE_COLUMNS)
  const errors: IValidationIssue[] = []
  const warnings: IValidationIssue[] = []

  checkPriority(item.priority, 'priority', errors)

  if (typeof item.is_active !== 'boolean') {
    errors.push(error('is_active', 'NOT_A_BOOLEAN', 'is_active must be a boolean'))
  }

  if (!(MAPPING_ENTITIES as readonly string[]).includes(item.entity)) {
    errors.push(
      error('entity', 'INVALID_ENUM', `entity must be one of: ${MAPPING_ENTITIES.join(', ')}`),
    )
  } else if (!(MAPPING_PARAM_SOURCES as readonly string[]).includes(item.param_source)) {
    errors.push(
      error(
        'param_source',
        'INVALID_ENUM',
        `param_source must be one of: ${MAPPING_PARAM_SOURCES.join(', ')}`,
      ),
    )
  } else if (item.param_source !== MAPPING_ENTITY_PARAM_SOURCE[item.entity]) {
    // The container is a consequence of the entity, not an independent choice.
    errors.push(
      error(
        'param_source',
        'PARAM_SOURCE_DOES_NOT_MATCH_ENTITY',
        `Entity "${item.entity}" reads its signals from ${MAPPING_ENTITY_PARAM_SOURCE[item.entity]}`,
      ),
    )
  }

  if (!(MAPPING_MODES as readonly string[]).includes(item.mode)) {
    errors.push(error('mode', 'INVALID_ENUM', `mode must be one of: ${MAPPING_MODES.join(', ')}`))
  }

  for (const column of MAPPING_PARAM_KEY_COLUMNS) {
    checkStringLength(item[column], column, TRAFFIC_SETTINGS_LIMITS.PARAM_KEY_MAX_LENGTH, errors)
  }

  for (const column of MAPPING_REGEX_COLUMNS) {
    checkStringLength(item[column], column, TRAFFIC_SETTINGS_LIMITS.REGEX_MAX_LENGTH, errors)
    if (!EXACT_CONSTANT_REGEX_COLUMNS.has(column)) {
      checkEmptyStringWarning(item[column], column, warnings)
    }
  }

  checkDataSourceAndAdDestinationConstants(
    item.data_source_regex,
    item.ad_destination_regex,
    errors,
  )

  checkStringLength(
    item.event_name,
    'event_name',
    TRAFFIC_SETTINGS_LIMITS.EVENT_NAME_MAX_LENGTH,
    errors,
  )

  checkStringLength(
    item.name,
    'name',
    TRAFFIC_SETTINGS_LIMITS.DESCRIPTION_MAX_LENGTH,
    errors,
  )

  checkStringLength(
    item.description,
    'description',
    TRAFFIC_SETTINGS_LIMITS.DESCRIPTION_MAX_LENGTH,
    errors,
  )

  const configuredParamKeys = MAPPING_PARAM_KEY_COLUMNS.filter((column) => item[column] !== null)
  if (configuredParamKeys.length === 0) {
    errors.push(
      error(
        'source_param_key',
        'MAPPING_WITHOUT_PARAM_KEY',
        'At least one parameter key must be configured, otherwise nothing is extracted',
      ),
    )
  }

  // A non-null filter with no extracted value always fails (strict emptiness),
  // so a filter without its mapped key could never match anything.
  for (const filterColumn of MAPPING_MATCH_REGEX_COLUMNS) {
    if (item[filterColumn] === null) {
      continue
    }
    const requiredKey = MAPPING_MATCH_REGEX_REQUIRED_PARAM_KEY[filterColumn] as
      keyof IAttributionSignalMappingInput | undefined
    if (requiredKey && item[requiredKey] === null) {
      errors.push(
        error(
          filterColumn,
          'MATCH_FILTER_WITHOUT_PARAM_KEY',
          `This filter requires "${String(requiredKey)}" to be configured, otherwise it can never match`,
        ),
      )
    }
  }

  if (item.event_name !== null && item.entity !== 'event') {
    warnings.push(
      error(
        'event_name',
        'EVENT_NAME_IGNORED_FOR_ENTITY',
        'Restricting by event name is only meaningful for the event entity',
      ),
    )
  }

  if (item.mode === 'override') {
    warnings.push(
      error(
        'mode',
        'OVERRIDE_MODE_WINS_OVER_WEB_ATTRIBUTION',
        'Override always creates a synthetic visit, so this signal can decide the conversion source even when marked web attribution exists',
      ),
    )
  }

  const adParamKeysUsed = MAPPING_AD_PARAM_KEY_COLUMNS.filter((column) => item[column] !== null)
  const boundariesUsed = MAPPING_BOUNDARY_REGEX_COLUMNS.filter((column) => item[column] !== null)
  if (adParamKeysUsed.length > 0 && boundariesUsed.length === 0) {
    warnings.push(
      error(
        'ad_destination_regex',
        'AD_LOOKUP_WITHOUT_BOUNDARY',
        'Without a resolution boundary, ad names are searched across all destinations and networks, so namesakes can make the match ambiguous',
      ),
    )
  }
  if (boundariesUsed.length > 0 && adParamKeysUsed.length === 0) {
    warnings.push(
      error(
        boundariesUsed[0],
        'BOUNDARY_WITHOUT_AD_LOOKUP',
        'Resolution boundaries only scope the ad lookup, which this mapping does not perform',
      ),
    )
  }

  const labelKeysUsed = MAPPING_LABEL_PARAM_KEY_COLUMNS.filter((column) => item[column] !== null)
  if (labelKeysUsed.length === 0 && adParamKeysUsed.length > 0) {
    warnings.push(
      error(
        'source_param_key',
        'MAPPING_WITHOUT_LABEL_KEYS',
        'This mapping extracts only ad identity. Labels of the synthetic visit will be filled by utm rules, if any match',
      ),
    )
  }

  return { errors, warnings }
}
