import { ERRORS } from '@presentation/constants/errors.constants'
import { HttpException } from '@presentation/exceptions/http.exception'
import { TRAFFIC_SETTINGS_LIMITS, type TrafficSettingsResource } from './traffic-settings.constants'
import type { IValidationIssue } from './traffic-settings.interface'

/**
 * Factories for the domain errors of this feature.
 *
 * All of them produce the nested `{ error: { status, code, message, details } }`
 * shape that the existing error middleware already emits, so the gateway can
 * forward them without translation. `details` carries only what the UI needs to
 * resolve the situation: never SQL, dataset identifiers, service accounts or raw
 * stack traces.
 */
export class TrafficSettingsError {
  /**
   * The caller's revision no longer matches the stored one. `current_revision`
   * lets the UI offer "load the current data" instead of guessing.
   */
  public static revisionConflict(
    resource: TrafficSettingsResource,
    currentRevision: string,
  ): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.REVISION_CONFLICT,
      details: { resource, current_revision: currentRevision },
    })
  }

  public static expectedRevisionRequired(resource: TrafficSettingsResource): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.EXPECTED_REVISION_REQUIRED,
      details: { resource },
    })
  }

  /**
   * A new conflict between active rules of the same stage with an overlapping
   * target. Existing conflicts are reported as warnings instead, so a legacy
   * configuration can still be disabled, deleted or corrected.
   */
  public static rulePriorityConflict(priority: number, conflictingIds: string[]): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.RULE_PRIORITY_CONFLICT,
      details: { resource: 'traffic-rules', priority, conflicting_rule_ids: conflictingIds },
    })
  }

  /**
   * The host is already listed. Reported with the ids of the rows that own it so
   * the UI can offer to open one instead of leaving the operator to search.
   */
  public static referrerHostConflict(host: string, conflictingIds: string[]): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.REFERRER_HOST_CONFLICT,
      details: {
        resource: 'excluded-referrers',
        host,
        conflicting_referrer_ids: conflictingIds,
      },
    })
  }

  public static referrerLimitExceeded(): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.REFERRER_LIMIT_EXCEEDED,
      details: {
        resource: 'excluded-referrers',
        limit: TRAFFIC_SETTINGS_LIMITS.HOSTS_MAX_COUNT,
      },
    })
  }

  public static notFound(resource: TrafficSettingsResource, id: string): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.NOT_FOUND,
      details: { resource, id },
    })
  }

  public static migrationRequired(
    resource: TrafficSettingsResource,
    reasonCode: string,
  ): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.MIGRATION_REQUIRED,
      details: { resource, reason_code: reasonCode },
    })
  }

  public static invalidConfiguration(
    resource: TrafficSettingsResource,
    reasonCode: string,
  ): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.INVALID_CONFIGURATION,
      details: { resource, reason_code: reasonCode },
    })
  }

  public static notProvisioned(resource: TrafficSettingsResource): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.NOT_PROVISIONED,
      details: { resource, reason_code: 'TABLE_MISSING' },
    })
  }

  /** Field-level failures. The draft is kept by the client; nothing was written. */
  public static validationFailed(
    resource: TrafficSettingsResource,
    errors: IValidationIssue[],
    warnings: IValidationIssue[] = [],
  ): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.VALIDATION_FAILED,
      details: { resource, errors, warnings },
    })
  }

  public static duplicateItemId(
    resource: TrafficSettingsResource,
    id: string,
    count: number,
  ): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.DUPLICATE_ITEM_ID,
      details: { resource, id, occurrences: count },
    })
  }

  public static projectResourcesNotFound(): HttpException {
    return new HttpException(ERRORS.TRAFFIC_SETTINGS.PROJECT_RESOURCES_NOT_FOUND)
  }

  public static projectDatasetNotProvisioned(): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.NOT_PROVISIONED,
      details: { reason_code: 'DATASET_MISSING' },
    })
  }

  /**
   * The commit may or may not have happened. The client must reload before an
   * explicit retry, and the retry must reuse the ORIGINAL expected revision so a
   * succeeded-but-unreported write cannot produce a second row.
   */
  public static outcomeUnknown(resource: TrafficSettingsResource): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.OUTCOME_UNKNOWN,
      details: { resource, outcome: 'unknown' },
    })
  }

  public static temporarilyUnavailable(resource: TrafficSettingsResource): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.RESOURCE_TEMPORARILY_UNAVAILABLE,
      details: { resource },
    })
  }

  /** Internal invariant breach: the transaction rolled back, nothing was written. */
  public static affectedRowsMismatch(resource: TrafficSettingsResource): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.AFFECTED_ROWS_MISMATCH,
      details: { resource },
    })
  }

  public static unsafeIdentifier(what: string): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.UNSAFE_IDENTIFIER,
      details: { identifier: what },
    })
  }

  public static attributionJobNotConfigured(): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.ATTRIBUTION_JOB_NOT_CONFIGURED,
      details: { reason_code: 'SCHEDULED_QUERY_MISSING' },
    })
  }

  public static attributionJobAlreadyRunning(): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.ATTRIBUTION_JOB_ALREADY_RUNNING,
      details: { running: true },
    })
  }

  public static identificationJobNotFound(): HttpException {
    return new HttpException(ERRORS.TRAFFIC_SETTINGS.IDENTIFICATION_JOB_NOT_FOUND)
  }

  public static identificationJobAlreadyRunning(): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.IDENTIFICATION_JOB_ALREADY_RUNNING,
      details: { is_running: true },
    })
  }

  public static identificationJobNotConfigured(): HttpException {
    return new HttpException(ERRORS.TRAFFIC_SETTINGS.IDENTIFICATION_JOB_NOT_CONFIGURED)
  }

  public static identificationJobRunFailed(): HttpException {
    return new HttpException(ERRORS.TRAFFIC_SETTINGS.IDENTIFICATION_JOB_RUN_FAILED)
  }

  public static identificationJobInvalidStatus(status: unknown): HttpException {
    return new HttpException({
      ...ERRORS.TRAFFIC_SETTINGS.IDENTIFICATION_JOB_INVALID_STATUS,
      details: { status },
    })
  }
}
