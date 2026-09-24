import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  validateAttributionSignalMappingInput,
  validateExcludedUrlParamInput,
  validateTrafficRuleInput,
} from './domain-validation'
import {
  TRAFFIC_RULE_WRITABLE_COLUMNS,
  MAPPING_WRITABLE_COLUMNS,
} from './traffic-settings.constants'
import type {
  IAttributionSignalMappingInput,
  ITrafficRuleInput,
  IValidationIssue,
} from './traffic-settings.interface'

/**
 * The invariants covered here all share one property: breaking them produces a
 * configuration that saves successfully and then does nothing, or does something
 * other than what the form said. A channel rule with no `set_traffic_channel`
 * matches rows and classifies nothing; a `match_source_regex` without
 * `source_param_key` can never pass because the extracted value is always empty.
 * Neither is detectable by looking at the UI afterwards, so they are rejected here.
 */

function codes(issues: IValidationIssue[]): string[] {
  return issues.map((issue) => issue.code)
}

/** A rule with every optional field explicitly null, as a PUT would send it. */
function ruleDraft(overrides: Partial<ITrafficRuleInput>): ITrafficRuleInput {
  const draft = { priority: 10, is_active: true, stage: 'utm', target: 'both' } as Record<
    string,
    unknown
  >
  for (const column of TRAFFIC_RULE_WRITABLE_COLUMNS) {
    if (!(column in draft)) {
      draft[column] = null
    }
  }
  return { ...draft, ...overrides } as ITrafficRuleInput
}

function mappingDraft(
  overrides: Partial<IAttributionSignalMappingInput>,
): IAttributionSignalMappingInput {
  const draft = {
    priority: 10,
    is_active: true,
    entity: 'order',
    param_source: 'custom_params',
    mode: 'fallback',
  } as Record<string, unknown>
  for (const column of MAPPING_WRITABLE_COLUMNS) {
    if (!(column in draft)) {
      draft[column] = null
    }
  }
  return { ...draft, ...overrides } as IAttributionSignalMappingInput
}

test('an excluded url param needs a non-blank pattern', () => {
  assert.deepEqual(
    codes(
      validateExcludedUrlParamInput({ param_key_regex: '  ', is_active: true, description: null })
        .errors,
    ),
    ['PARAM_KEY_REGEX_REQUIRED'],
  )
  assert.deepEqual(
    validateExcludedUrlParamInput({
      param_key_regex: 'utm_[a-z]+',
      is_active: true,
      description: null,
    }).errors,
    [],
  )
})

test('priority must be a whole number that survives JSON', () => {
  assert.ok(
    codes(validateTrafficRuleInput(ruleDraft({ priority: 1.5 })).errors).includes(
      'PRIORITY_NOT_AN_INTEGER',
    ),
  )
  assert.ok(
    codes(
      validateTrafficRuleInput(ruleDraft({ priority: '10' as unknown as number })).errors,
    ).includes('PRIORITY_NOT_AN_INTEGER'),
  )
  // Negative is allowed: ordering is "lower runs earlier" and no floor is part of
  // the domain, so forbidding it would invent a rule the job does not have.
  assert.equal(
    codes(validateTrafficRuleInput(ruleDraft({ priority: -5, set_source: 'x' })).errors).includes(
      'PRIORITY_NOT_AN_INTEGER',
    ),
    false,
  )
})

test('each stage requires its own output and rejects the other stage\u2019s', () => {
  assert.ok(
    codes(validateTrafficRuleInput(ruleDraft({ stage: 'utm' })).errors).includes(
      'UTM_RULE_WITHOUT_OUTPUT',
    ),
  )
  assert.ok(
    codes(validateTrafficRuleInput(ruleDraft({ stage: 'origin' })).errors).includes(
      'ORIGIN_RULE_WITHOUT_OUTPUT',
    ),
  )
  assert.ok(
    codes(validateTrafficRuleInput(ruleDraft({ stage: 'channel' })).errors).includes(
      'CHANNEL_RULE_WITHOUT_OUTPUT',
    ),
  )
  assert.ok(
    codes(
      validateTrafficRuleInput(ruleDraft({ stage: 'utm', set_traffic_origin: 'Google Ads' }))
        .errors,
    ).includes('OUTPUT_NOT_ALLOWED_FOR_STAGE'),
  )
  assert.ok(
    codes(
      validateTrafficRuleInput(
        ruleDraft({ stage: 'origin', set_traffic_origin: 'Google Ads', set_source: 'google' }),
      ).errors,
    ).includes('OUTPUT_NOT_ALLOWED_FOR_STAGE'),
  )
})

test('a condition on the resolved origin is only available to channel rules', () => {
  assert.ok(
    codes(
      validateTrafficRuleInput(
        ruleDraft({ stage: 'utm', set_source: 'x', traffic_origin_regex: 'Google' }),
      ).errors,
    ).includes('CONDITION_NOT_ALLOWED_FOR_STAGE'),
  )
  assert.equal(
    codes(
      validateTrafficRuleInput(
        ruleDraft({
          stage: 'channel',
          set_traffic_channel: 'Paid',
          traffic_origin_regex: 'Google',
        }),
      ).errors,
    ).includes('CONDITION_NOT_ALLOWED_FOR_STAGE'),
    false,
  )
})

test('applies_to_web is allowed for utm, origin, and channel when target includes visits', () => {
  assert.deepEqual(
    validateTrafficRuleInput(
      ruleDraft({ stage: 'utm', set_source: 'x', target: 'visit', applies_to_web: true }),
    ).errors,
    [],
  )
  assert.deepEqual(
    validateTrafficRuleInput(
      ruleDraft({ stage: 'origin', set_traffic_origin: 'x', applies_to_web: true }),
    ).errors,
    [],
  )
  assert.deepEqual(
    validateTrafficRuleInput(
      ruleDraft({ stage: 'channel', set_traffic_channel: 'x', applies_to_web: true }),
    ).errors,
    [],
  )
  assert.ok(
    codes(
      validateTrafficRuleInput(
        ruleDraft({ stage: 'utm', set_source: 'x', target: 'ad_cost', applies_to_web: true }),
      ).errors,
    ).includes('APPLIES_TO_WEB_REQUIRES_VISIT_TARGET'),
  )
  assert.ok(
    codes(
      validateTrafficRuleInput(
        ruleDraft({
          stage: 'origin',
          set_traffic_origin: 'x',
          target: 'ad_cost',
          applies_to_web: true,
        }),
      ).errors,
    ).includes('APPLIES_TO_WEB_REQUIRES_VISIT_TARGET'),
  )
  // false and null stay allowed on every stage/target combination that is
  // otherwise valid (ad_cost-only included).
  assert.deepEqual(
    validateTrafficRuleInput(
      ruleDraft({ stage: 'origin', set_traffic_origin: 'x', target: 'ad_cost', applies_to_web: false }),
    ).errors,
    [],
  )
  assert.deepEqual(
    validateTrafficRuleInput(
      ruleDraft({ stage: 'channel', set_traffic_channel: 'x', applies_to_web: null }),
    ).errors,
    [],
  )
})

test('a url param value pattern requires the key it tests', () => {
  assert.ok(
    codes(
      validateTrafficRuleInput(ruleDraft({ set_source: 'x', url_param_value_regex: '^1$' })).errors,
    ).includes('URL_PARAM_KEY_REQUIRED'),
  )
  // A key on its own is a valid existence check, not an incomplete condition.
  assert.equal(
    codes(
      validateTrafficRuleInput(ruleDraft({ set_source: 'x', url_param_key: 'gclid' })).errors,
    ).includes('URL_PARAM_KEY_REQUIRED'),
    false,
  )
})

test('only the allowlisted placeholders are accepted, and only in label outputs', () => {
  assert.deepEqual(
    validateTrafficRuleInput(ruleDraft({ set_campaign: '{campaign_name}' })).errors,
    [],
  )
  assert.deepEqual(
    validateTrafficRuleInput(
      ruleDraft({
        set_source: '{source}',
        set_medium: '{medium}',
        set_campaign: '{campaign}',
        set_content: '{content}',
        set_term: '{term}',
      }),
    ).errors,
    [],
  )
  assert.ok(
    codes(validateTrafficRuleInput(ruleDraft({ set_source: '{account_name}' })).errors).includes(
      'UNKNOWN_PLACEHOLDER',
    ),
  )
  assert.ok(
    codes(
      validateTrafficRuleInput(ruleDraft({ stage: 'origin', set_traffic_origin: '{data_source}' }))
        .errors,
    ).includes('PLACEHOLDER_NOT_ALLOWED'),
  )
})

test('an empty pattern is accepted but flagged, since it matches everything', () => {
  const outcome = validateTrafficRuleInput(ruleDraft({ set_source: 'x', source_regex: '' }))
  assert.deepEqual(outcome.errors, [])
  assert.ok(codes(outcome.warnings).includes('EMPTY_PATTERN_MATCHES_EVERYTHING'))
})

test('an ad condition combined with applies_to_web is reported as unsatisfiable', () => {
  const outcome = validateTrafficRuleInput(
    ruleDraft({ set_source: 'x', applies_to_web: true, campaign_id_regex: '^1$' }),
  )
  assert.deepEqual(outcome.errors, [])
  assert.ok(codes(outcome.warnings).includes('AD_DERIVED_CONDITION_NEVER_MATCHES_WEB'))
})

test('the param container is a consequence of the entity, not a free choice', () => {
  assert.ok(
    codes(
      validateAttributionSignalMappingInput(
        mappingDraft({
          entity: 'order',
          param_source: 'event_params',
          source_param_key: 'utm_source',
        }),
      ).errors,
    ).includes('PARAM_SOURCE_DOES_NOT_MATCH_ENTITY'),
  )
  assert.deepEqual(
    validateAttributionSignalMappingInput(
      mappingDraft({
        entity: 'event',
        param_source: 'event_params',
        source_param_key: 'utm_source',
      }),
    ).errors,
    [],
  )
})

test('a mapping that extracts nothing is rejected', () => {
  assert.ok(
    codes(validateAttributionSignalMappingInput(mappingDraft({})).errors).includes(
      'MAPPING_WITHOUT_PARAM_KEY',
    ),
  )
})

test('a match filter without its param key can never match, so it is rejected', () => {
  assert.ok(
    codes(
      validateAttributionSignalMappingInput(
        mappingDraft({ medium_param_key: 'm', match_source_regex: '^google$' }),
      ).errors,
    ).includes('MATCH_FILTER_WITHOUT_PARAM_KEY'),
  )
  assert.deepEqual(
    validateAttributionSignalMappingInput(
      mappingDraft({ source_param_key: 'utm_source', match_source_regex: '^google$' }),
    ).errors,
    [],
  )
})

test('an ad lookup without a resolution boundary is flagged as ambiguous', () => {
  const outcome = validateAttributionSignalMappingInput(mappingDraft({ ad_name_param_key: 'ad' }))
  assert.deepEqual(outcome.errors, [])
  assert.ok(codes(outcome.warnings).includes('AD_LOOKUP_WITHOUT_BOUNDARY'))
})

test('a boundary without an ad lookup is flagged as having no effect', () => {
  const outcome = validateAttributionSignalMappingInput(
    mappingDraft({ source_param_key: 'utm_source', data_source_regex: 'FACEBOOK_ADS' }),
  )
  assert.deepEqual(outcome.errors, [])
  assert.ok(codes(outcome.warnings).includes('BOUNDARY_WITHOUT_AD_LOOKUP'))
})

test('data_source_regex and ad_destination_regex on rules must be exact job constants', () => {
  assert.deepEqual(
    codes(
      validateTrafficRuleInput(
        ruleDraft({ set_source: 'x', data_source_regex: 'FACEBOOK_ADS', ad_destination_regex: 'chat' }),
      ).errors,
    ).filter((code) => code === 'INVALID_ENUM'),
    [],
  )
  assert.deepEqual(
    codes(
      validateTrafficRuleInput(ruleDraft({ set_source: 'x', data_source_regex: null })).errors,
    ).filter((code) => code === 'INVALID_ENUM'),
    [],
  )
  assert.deepEqual(
    codes(
      validateTrafficRuleInput(ruleDraft({ set_source: 'x', data_source_regex: '' })).errors,
    ).filter((code) => code === 'INVALID_ENUM'),
    [],
  )
  assert.ok(
    codes(
      validateTrafficRuleInput(ruleDraft({ set_source: 'x', data_source_regex: '^GOOGLE_ADS$' }))
        .errors,
    ).includes('INVALID_ENUM'),
  )
  assert.ok(
    codes(
      validateTrafficRuleInput(
        ruleDraft({ set_source: 'x', ad_destination_regex: '^(call|chat)$' }),
      ).errors,
    ).includes('INVALID_ENUM'),
  )
})

test('data_source_regex and ad_destination_regex on mappings must be exact job constants', () => {
  assert.deepEqual(
    codes(
      validateAttributionSignalMappingInput(
        mappingDraft({
          source_param_key: 'utm_source',
          data_source_regex: 'TIKTOK_ADS',
          ad_destination_regex: 'web',
        }),
      ).errors,
    ).filter((code) => code === 'INVALID_ENUM'),
    [],
  )
  assert.deepEqual(
    codes(
      validateAttributionSignalMappingInput(
        mappingDraft({ source_param_key: 'utm_source', ad_destination_regex: null }),
      ).errors,
    ).filter((code) => code === 'INVALID_ENUM'),
    [],
  )
  assert.ok(
    codes(
      validateAttributionSignalMappingInput(
        mappingDraft({ source_param_key: 'utm_source', data_source_regex: 'facebook' }),
      ).errors,
    ).includes('INVALID_ENUM'),
  )
  assert.ok(
    codes(
      validateAttributionSignalMappingInput(
        mappingDraft({ source_param_key: 'utm_source', data_source_regex: 'GOOGLE_SHEETS' }),
      ).errors,
    ).includes('INVALID_ENUM'),
  )
})

test('event_name on a non-event entity is reported as ignored', () => {
  const outcome = validateAttributionSignalMappingInput(
    mappingDraft({ source_param_key: 'utm_source', event_name: 'purchase' }),
  )
  assert.deepEqual(outcome.errors, [])
  assert.ok(codes(outcome.warnings).includes('EVENT_NAME_IGNORED_FOR_ENTITY'))
})

test('a partial origin-rule draft is validated as if omitted fields were null', () => {
  const outcome = validateTrafficRuleInput({
    priority: 10,
    is_active: true,
    stage: 'origin',
    target: 'both',
    set_traffic_origin: 'Google',
  } as ITrafficRuleInput)

  assert.deepEqual(outcome.errors, [])
})

test('a partial mapping draft is validated as if omitted fields were null', () => {
  const outcome = validateAttributionSignalMappingInput({
    priority: 10,
    is_active: true,
    entity: 'order',
    param_source: 'custom_params',
    mode: 'fallback',
    source_param_key: 'utm_source',
  } as IAttributionSignalMappingInput)

  assert.deepEqual(outcome.errors, [])
})
