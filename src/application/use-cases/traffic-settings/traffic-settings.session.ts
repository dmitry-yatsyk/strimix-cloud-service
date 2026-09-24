import type { BigQueryApi } from '@modules/gcloud/bigquery'
import {
  TRAFFIC_SETTINGS_APPLICATION_MODE,
  TrafficSettingsError,
  TrafficSettingsReadiness,
  TrafficSettingsRepository,
  createBigQueryApiForContext,
  resolveProjectContext,
  type IApplicationInfo,
  type IMutationScriptResult,
  type IProjectBigQueryContext,
  type Revision,
  type TrafficSettingsResource,
} from '@modules/traffic-settings'

/**
 * Per-request plumbing shared by every traffic settings use case.
 *
 * A session is created once per HTTP request and thrown away with it. That keeps
 * the readiness memoization inside it correct — a long-lived cache would happily
 * report a resource as ready minutes after an administrator dropped its table.
 */

export interface ITrafficSettingsSession {
  context: IProjectBigQueryContext
  bigqueryApi: BigQueryApi
  repository: TrafficSettingsRepository
  readiness: TrafficSettingsReadiness
}

export async function openTrafficSettingsSession(
  projectId: number,
): Promise<ITrafficSettingsSession> {
  const { context, misregisteredResources } = await resolveProjectContext(projectId)
  const bigqueryApi = createBigQueryApiForContext(context)

  return {
    context,
    bigqueryApi,
    repository: new TrafficSettingsRepository(context, bigqueryApi),
    readiness: new TrafficSettingsReadiness(context, bigqueryApi, misregisteredResources),
  }
}

/** Every mutation reports the same thing: saved, effective after the next run. */
export function applicationInfo(): IApplicationInfo {
  return { mode: TRAFFIC_SETTINGS_APPLICATION_MODE }
}

/**
 * Turns the revision rows of a read into the single opaque value handed to the
 * client.
 *
 * `'0'` is the sentinel for "this resource has no revision row yet". It is
 * returned so a project awaiting migration can still be inspected, and it is
 * never accepted on a write: the conditional update in the mutation script
 * cannot match a row that does not exist, and the readiness check refuses the
 * write before that anyway.
 */
export const NO_REVISION_SENTINEL = '0'

export function resolveRevision(revisions: string[], resource: TrafficSettingsResource): Revision {
  if (revisions.length === 0) {
    return NO_REVISION_SENTINEL
  }
  if (revisions.length > 1) {
    throw TrafficSettingsError.invalidConfiguration(resource, 'REVISION_ROWS_DUPLICATED')
  }
  return revisions[0]
}

/**
 * Translates the outcome of a mutation script into the contract's error codes.
 * `OK` is the only outcome that returns; everything else rolled the transaction
 * back, so nothing was written in any of these branches.
 */
export function assertMutationSucceeded(
  result: IMutationScriptResult,
  resource: TrafficSettingsResource,
  context: { id?: string; priority?: number; host?: string },
): void {
  switch (result.outcome) {
    case 'OK':
      return
    case 'REVISION_CONFLICT':
      throw TrafficSettingsError.revisionConflict(
        resource,
        result.currentRevision ?? NO_REVISION_SENTINEL,
      )
    case 'NOT_FOUND':
      throw TrafficSettingsError.notFound(resource, context.id ?? '')
    case 'DUPLICATE_ID':
      throw TrafficSettingsError.duplicateItemId(resource, context.id ?? '', result.affected)
    case 'PRIORITY_CONFLICT':
      throw TrafficSettingsError.rulePriorityConflict(context.priority ?? 0, result.conflictingIds)
    case 'HOST_CONFLICT':
      throw TrafficSettingsError.referrerHostConflict(context.host ?? '', result.conflictingIds)
    case 'LIMIT_EXCEEDED':
      throw TrafficSettingsError.referrerLimitExceeded()
    case 'AFFECTED_ROWS_MISMATCH':
    default:
      // The script asserted its own row counts and rolled back, so the data is
      // intact — but the statement did something this code did not predict, and
      // that is a defect here rather than a user-resolvable situation.
      throw TrafficSettingsError.affectedRowsMismatch(resource)
  }
}

/** Failure classes that change what the client is told, and what it may retry. */
type FailureClass = 'timeout' | 'unavailable' | 'other'

function classifyFailure(error: unknown): FailureClass {
  const candidate = error as { code?: unknown; message?: unknown } | null
  const code = typeof candidate?.code === 'number' ? candidate.code : null
  const codeText = typeof candidate?.code === 'string' ? candidate.code : ''
  const message = typeof candidate?.message === 'string' ? candidate.message : ''
  const haystack = `${codeText} ${message}`.toUpperCase()

  if (
    code === 4 ||
    codeText === 'ETIMEDOUT' ||
    codeText === 'ECONNABORTED' ||
    haystack.includes('DEADLINE_EXCEEDED') ||
    haystack.includes('TIMEOUT') ||
    haystack.includes('TIMED OUT')
  ) {
    return 'timeout'
  }

  if (
    code === 14 ||
    code === 429 ||
    code === 503 ||
    codeText === 'ECONNRESET' ||
    haystack.includes('UNAVAILABLE') ||
    haystack.includes('RATELIMITEXCEEDED') ||
    haystack.includes('RATE LIMIT') ||
    haystack.includes('QUOTA')
  ) {
    return 'unavailable'
  }

  return 'other'
}

/** An already-typed domain error must pass through untouched. */
function isDomainError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { status?: unknown }).status === 'number' &&
    typeof (error as { code?: unknown }).code === 'string'
  )
}

/**
 * Wraps a read. A quota or availability failure is reported as retryable; it is
 * never reported as an empty configuration, which is the one answer that would
 * make a user re-create settings they already have.
 */
export async function runRead<T>(
  resource: TrafficSettingsResource,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (isDomainError(error)) {
      throw error
    }
    const failure = classifyFailure(error)
    if (failure === 'unavailable' || failure === 'timeout') {
      throw TrafficSettingsError.temporarilyUnavailable(resource)
    }
    throw error
  }
}

/**
 * Wraps a mutation.
 *
 * A timeout is the dangerous case: the BigQuery statement may have committed
 * after the client stopped waiting, so the write is reported as UNKNOWN rather
 * than failed. The contract forbids retrying it automatically, and requires that
 * an explicit retry reuse the ORIGINAL expected revision — a succeeded-but-
 * unreported write has already consumed it, so the retry is rejected as a
 * conflict instead of inserting a second row.
 */
export async function runMutation<T>(
  resource: TrafficSettingsResource,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (isDomainError(error)) {
      throw error
    }
    if (classifyFailure(error) === 'timeout') {
      throw TrafficSettingsError.outcomeUnknown(resource)
    }
    throw error
  }
}
