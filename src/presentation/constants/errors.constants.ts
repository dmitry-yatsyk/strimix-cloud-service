export const ERRORS = {
  PROJECT: {
    NOT_FOUND: {
      status: 404,
      code: 'PROJECT_NOT_FOUND',
      message: 'Project not found',
    },
  },
  RESOURCE_GROUP: {
    NOT_FOUND: {
      status: 404,
      code: 'RESOURCE_GROUP_NOT_FOUND',
      message: 'Resource group not found',
    },
  },
  AUTH: {
    AUTHENTICATION_ERROR: {
      status: 401,
      code: 'AUTHENTICATION_ERROR',
      message: 'Authentication error',
    },
  },
  OTHER: {
    INTERNAL_SERVER_ERROR: {
      status: 500,
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    },
    REQUEST_VALIDATION_ERROR: {
      status: 400,
      code: 'REQUEST_VALIDATION_ERROR',
      message: 'Request validation error',
    },
  },
  /**
   * Traffic and attribution settings. The codes are stable: the gateway
   * forwards them unchanged and the frontend keys its behaviour off them, so
   * they must not be renamed without updating all three repositories and the
   * shared contract fixtures.
   */
  TRAFFIC_SETTINGS: {
    /** Stale or missing collection revision. Details carry current_revision. */
    REVISION_CONFLICT: {
      status: 409,
      code: 'TRAFFIC_SETTINGS_REVISION_CONFLICT',
      message: 'Settings have changed',
    },
    /** A mutation would leave two active rules of one stage on the same priority. */
    RULE_PRIORITY_CONFLICT: {
      status: 409,
      code: 'TRAFFIC_RULE_PRIORITY_CONFLICT',
      message: 'Another active rule of this stage already uses this priority',
    },
    /** The host is already listed, active or not. Details carry the owning row ids. */
    REFERRER_HOST_CONFLICT: {
      status: 409,
      code: 'TRAFFIC_SETTINGS_REFERRER_HOST_CONFLICT',
      message: 'This host is already on the excluded referrers list',
    },
    /** The list would grow past the supported number of rows. */
    REFERRER_LIMIT_EXCEEDED: {
      status: 409,
      code: 'TRAFFIC_SETTINGS_REFERRER_LIMIT_EXCEEDED',
      message: 'The excluded referrers list has reached its maximum size',
    },
    NOT_FOUND: {
      status: 404,
      code: 'TRAFFIC_SETTING_NOT_FOUND',
      message: 'Traffic setting not found',
    },
    /** A required migration has not been run for this project yet. */
    MIGRATION_REQUIRED: {
      status: 409,
      code: 'TRAFFIC_SETTINGS_MIGRATION_REQUIRED',
      message: 'This project requires a settings migration before changes can be saved',
    },
    /** Stored configuration cannot be addressed safely (duplicate ids, bad schema). */
    INVALID_CONFIGURATION: {
      status: 409,
      code: 'TRAFFIC_SETTINGS_INVALID_CONFIGURATION',
      message: 'Stored configuration of this resource needs an administrative fix',
    },
    NOT_PROVISIONED: {
      status: 409,
      code: 'TRAFFIC_SETTINGS_NOT_PROVISIONED',
      message: 'This resource has not been provisioned for the project yet',
    },
    EXPECTED_REVISION_REQUIRED: {
      status: 400,
      code: 'TRAFFIC_SETTINGS_EXPECTED_REVISION_REQUIRED',
      message: 'expected_revision is required for this operation',
    },
    /** Domain validation failed. Details carry per-field errors and warnings. */
    VALIDATION_FAILED: {
      status: 400,
      code: 'TRAFFIC_SETTINGS_VALIDATION_FAILED',
      message: 'Traffic settings validation failed',
    },
    /** More than one row carries the same id: never mass-updated, always reported. */
    DUPLICATE_ITEM_ID: {
      status: 409,
      code: 'TRAFFIC_SETTINGS_DUPLICATE_ITEM_ID',
      message: 'Stored configuration contains duplicate ids and cannot be addressed by id',
    },
    PROJECT_RESOURCES_NOT_FOUND: {
      status: 404,
      code: 'TRAFFIC_SETTINGS_PROJECT_RESOURCES_NOT_FOUND',
      message: 'Cloud resources are not registered for this project',
    },
    /** Outcome of the write is genuinely unknown: never retried automatically. */
    OUTCOME_UNKNOWN: {
      status: 504,
      code: 'TRAFFIC_SETTINGS_OUTCOME_UNKNOWN',
      message: 'The result of the operation is unknown. Reload the settings before retrying',
    },
    RESOURCE_TEMPORARILY_UNAVAILABLE: {
      status: 503,
      code: 'TRAFFIC_SETTINGS_RESOURCE_TEMPORARILY_UNAVAILABLE',
      message: 'Settings storage is temporarily unavailable',
    },
    UNSAFE_IDENTIFIER: {
      status: 500,
      code: 'TRAFFIC_SETTINGS_UNSAFE_IDENTIFIER',
      message: 'Resolved resource identifier is not usable',
    },
    /**
     * The write statement matched a different number of rows than the one the
     * script asserted, so the whole transaction was rolled back. Nothing was
     * written; this signals a defect in the service, not a user-fixable state.
     */
    AFFECTED_ROWS_MISMATCH: {
      status: 500,
      code: 'TRAFFIC_SETTINGS_AFFECTED_ROWS_MISMATCH',
      message: 'The operation was rolled back because it would have changed unexpected records',
    },
    /** Attribution scheduled query is not registered for this project. */
    ATTRIBUTION_JOB_NOT_CONFIGURED: {
      status: 409,
      code: 'TRAFFIC_SETTINGS_ATTRIBUTION_JOB_NOT_CONFIGURED',
      message: 'The attribution job is not configured for this project yet',
    },
    /** A transfer run is already PENDING or RUNNING; a second start was refused. */
    ATTRIBUTION_JOB_ALREADY_RUNNING: {
      status: 409,
      code: 'TRAFFIC_SETTINGS_ATTRIBUTION_JOB_ALREADY_RUNNING',
      message: 'An attribution job run is already in progress',
    },
    /** No identification_jobs document for this project. */
    IDENTIFICATION_JOB_NOT_FOUND: {
      status: 404,
      code: 'TRAFFIC_SETTINGS_IDENTIFICATION_JOB_NOT_FOUND',
      message: 'The identification job was not found for this project',
    },
    /** Mongo reports is_running; a second start was refused. */
    IDENTIFICATION_JOB_ALREADY_RUNNING: {
      status: 409,
      code: 'TRAFFIC_SETTINGS_IDENTIFICATION_JOB_ALREADY_RUNNING',
      message: 'An identification job run is already in progress',
    },
    /** IDENTITY_SERVICE_CLOUD_RUN_JOB_* env vars missing or malformed. */
    IDENTIFICATION_JOB_NOT_CONFIGURED: {
      status: 503,
      code: 'TRAFFIC_SETTINGS_IDENTIFICATION_JOB_NOT_CONFIGURED',
      message: 'The identification Cloud Run Job is not configured',
    },
    /** Cloud Run Jobs.run failed or returned a non-success status. */
    IDENTIFICATION_JOB_RUN_FAILED: {
      status: 502,
      code: 'TRAFFIC_SETTINGS_IDENTIFICATION_JOB_RUN_FAILED',
      message: 'The identification Cloud Run Job could not be started',
    },
    /** Status body was not ACTIVE or PAUSED. */
    IDENTIFICATION_JOB_INVALID_STATUS: {
      status: 400,
      code: 'TRAFFIC_SETTINGS_IDENTIFICATION_JOB_INVALID_STATUS',
      message: 'Identification job status must be ACTIVE or PAUSED',
    },
  },
}
