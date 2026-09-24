import {
  TrafficSettingsError,
  collectExcludedUrlParamRegexCandidates,
  collectMappingRegexCandidates,
  collectTrafficRuleRegexCandidates,
  normalizeHost,
  normalizeHostList,
  validateAttributionSignalMappingInput,
  validateExcludedReferrerInput,
  validateExcludedUrlParamInput,
  validateRegexCandidates,
  validateTrafficRuleInput,
  type IAttributionSignalMapping,
  type IAttributionSignalMappingInput,
  type IExcludedReferrer,
  type IExcludedReferrerInput,
  type IExcludedUrlParamInput,
  type ITrafficRule,
  type ITrafficRuleInput,
  type IValidationIssue,
  type IValidationResult,
  type TrafficSettingsItemResource,
  type TrafficSettingsResource,
} from '@modules/traffic-settings'
import type { ITrafficSettingsSession } from './traffic-settings.session'

/**
 * The one validation path used by `POST /validate` and by every write.
 *
 * It combines three kinds of check that no single one of them can replace:
 *  - cross-field domain invariants, which are pure and need no I/O;
 *  - RE2 compilation, which must be done by BigQuery because JavaScript's regex
 *    engine accepts and rejects a different language;
 *  - collection-level checks (priority collisions), which need the other rows.
 *
 * Passing here still does not guarantee a successful save: the revision and the
 * priority constraint are re-checked inside the write transaction, where they are
 * actually enforceable.
 */

/** `both` overlaps `visit` and `ad_cost`; `visit` and `ad_cost` do not overlap. */
function targetsOverlap(left: string, right: string): boolean {
  return left === right || left === 'both' || right === 'both'
}

async function collectionIssues(
  session: ITrafficSettingsSession,
  resource: TrafficSettingsItemResource,
  item: Record<string, unknown>,
  id: string | null,
): Promise<{ errors: IValidationIssue[]; warnings: IValidationIssue[] }> {
  const errors: IValidationIssue[] = []
  const warnings: IValidationIssue[] = []

  // A host may appear once, active or not, so this is checked against the whole
  // collection rather than the active rows only. The write transaction repeats the
  // check; this one exists so the form can report it before the user saves.
  if (resource === 'excluded-referrers') {
    const draft = item as unknown as IExcludedReferrerInput
    if (typeof draft.host !== 'string') {
      return { errors, warnings }
    }

    const { host } = normalizeHost(draft.host, 'host')
    if (host === null) {
      return { errors, warnings }
    }

    const { items } = await session.repository.readCollection<IExcludedReferrer>(resource)
    const owners = items.filter(
      (existing) => existing.referrer_id !== id && existing.host === host,
    )

    if (owners.length > 0) {
      errors.push({
        field: 'host',
        code: 'HOST_CONFLICT',
        message: `"${host}" is already on the list`,
      })
    }

    return { errors, warnings }
  }

  if (resource === 'traffic-rules') {
    const draft = item as unknown as ITrafficRuleInput
    if (draft.is_active !== true) {
      // An inactive rule cannot collide: the constraint is on active rules only,
      // which is what makes a legacy conflict repairable by disabling one side.
      return { errors, warnings }
    }

    const { items } = await session.repository.readCollection<ITrafficRule>(resource)
    const conflicting = items.filter(
      (existing) =>
        existing.rule_id !== id &&
        existing.is_active === true &&
        existing.stage === draft.stage &&
        existing.priority === draft.priority &&
        targetsOverlap(existing.target, draft.target),
    )

    if (conflicting.length > 0) {
      errors.push({
        field: 'priority',
        code: 'PRIORITY_CONFLICT',
        message: `Rules ${conflicting
          .map((rule) => rule.rule_id)
          .join(', ')} are already active at this priority for the same stage and target`,
      })
    }

    return { errors, warnings }
  }

  if (resource === 'attribution-signal-mappings') {
    const draft = item as unknown as IAttributionSignalMappingInput
    if (draft.is_active !== true) {
      return { errors, warnings }
    }

    const { items } = await session.repository.readCollection<IAttributionSignalMapping>(resource)
    const tied = items.filter(
      (existing) =>
        existing.mapping_id !== id &&
        existing.is_active === true &&
        existing.priority === draft.priority,
    )

    // Deliberately a warning, not an error: the attribution job already breaks
    // ties by mapping_id, and forbidding equal priorities now would make existing
    // configurations unsavable without changing what they do.
    if (tied.length > 0) {
      warnings.push({
        field: 'priority',
        code: 'PRIORITY_TIE',
        message: `Mappings ${tied
          .map((mapping) => mapping.mapping_id)
          .join(
            ', ',
          )} already use this priority. Ties are resolved by identifier, which is not a meaningful order`,
      })
    }
  }

  return { errors, warnings }
}

export async function validateTrafficSettingsInput(
  session: ITrafficSettingsSession,
  resource: TrafficSettingsResource,
  item: Record<string, unknown>,
  id: string | null = null,
): Promise<IValidationResult> {
  // Referrers accept either shape here: a `hosts` array previews a bulk add
  // exactly as the paste field shows it, while anything else is one row and takes
  // the same path as the other resources.
  if (resource === 'excluded-referrers' && Array.isArray(item.hosts)) {
    const outcome = normalizeHostList(item.hosts as string[])
    return {
      valid: outcome.errors.length === 0,
      errors: outcome.errors,
      warnings: outcome.warnings,
    }
  }

  const itemResource = resource as TrafficSettingsItemResource

  // An id supplied for context must belong to this project: validate must never
  // become a way to probe for identifiers from another tenant's configuration.
  if (id !== null) {
    const { items } = await session.repository.readItem(itemResource, id)
    if (items.length === 0) {
      throw TrafficSettingsError.notFound(resource, id)
    }
  }

  const domain = (() => {
    switch (itemResource) {
      case 'excluded-url-params':
        return validateExcludedUrlParamInput(item as unknown as IExcludedUrlParamInput)
      case 'excluded-referrers':
        return validateExcludedReferrerInput(item as unknown as IExcludedReferrerInput)
      case 'traffic-rules':
        return validateTrafficRuleInput(item as unknown as ITrafficRuleInput)
      case 'attribution-signal-mappings':
      default:
        return validateAttributionSignalMappingInput(
          item as unknown as IAttributionSignalMappingInput,
        )
    }
  })()

  const candidates = (() => {
    switch (itemResource) {
      case 'excluded-url-params':
        return collectExcludedUrlParamRegexCandidates(item as unknown as IExcludedUrlParamInput)
      // A referrer host is a literal, so there is no pattern to compile.
      case 'excluded-referrers':
        return []
      case 'traffic-rules':
        return collectTrafficRuleRegexCandidates(item as unknown as ITrafficRuleInput)
      case 'attribution-signal-mappings':
      default:
        return collectMappingRegexCandidates(item as unknown as IAttributionSignalMappingInput)
    }
  })()

  // Both remaining checks touch BigQuery and are independent, so they run
  // together: a user fixing a draft should see the regex problem and the priority
  // collision in one response rather than one per save attempt.
  const [regexIssues, collection] = await Promise.all([
    validateRegexCandidates(session.bigqueryApi, candidates),
    collectionIssues(session, itemResource, item, id),
  ])

  const errors = [...domain.errors, ...regexIssues, ...collection.errors]
  const warnings = [...domain.warnings, ...collection.warnings]

  return { valid: errors.length === 0, errors, warnings }
}

/** Write path: same checks, but a failure is an error response, not a report. */
export async function assertTrafficSettingsInputValid(
  session: ITrafficSettingsSession,
  resource: TrafficSettingsResource,
  item: Record<string, unknown>,
  id: string | null = null,
): Promise<IValidationResult> {
  const result = await validateTrafficSettingsInput(session, resource, item, id)
  if (!result.valid) {
    throw TrafficSettingsError.validationFailed(resource, result.errors, result.warnings)
  }
  return result
}
