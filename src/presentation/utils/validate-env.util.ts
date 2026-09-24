import { cleanEnv, str, port } from 'envalid'

function validateEnv(): void {
  cleanEnv(process.env, {
    NODE_ENV: str({
      choices: ['development', 'production'],
    }),
    PORT: port({ default: 5017 }),
    APP_AUTHORIZATION_CODES: str(),
    MONGO_CREDENTIALS: str(),
    IDENTITY_SERVICE_MONGO_CREDENTIALS: str(),
    DATA_PROCESSING_SERVICE_MONGO_CREDENTIALS: str(),
    GOOGLE_CLOUD_SERVICE_ACCOUNT: str(),
    /**
     * JSON key of the Google service account allowed to run the identity
     * Cloud Run Job (Jobs.run). Same shape as GOOGLE_CLOUD_SERVICE_ACCOUNT.
     * Not a URL, not a job resource name, not a project id.
     */
    IDENTITY_SERVICE_CLOUD_RUN_JOB_SERVICE_ACCOUNT: str(),
    /**
     * Full Cloud Run Job resource name for the shared identity-resolution job:
     * `projects/{gcpProject}/locations/{region}/jobs/{jobName}`.
     * Not a URL — Jobs have no public endpoint.
     */
    IDENTITY_SERVICE_CLOUD_RUN_JOB_RESOURCE_NAME: str(),
    API_GATEWAY_AUTHORIZATION_CODE: str(),
    API_GATEWAY_HOST: str(),
    ERROR_NOTIFICATOR_URL: str(),
  })
}

export { validateEnv }
