import { GoogleAuth } from 'google-auth-library'
import type { CredentialBody } from 'google-auth-library'
import { TrafficSettingsError } from '@modules/traffic-settings'
import { HttpException } from '@presentation/exceptions/http.exception'

/**
 * Starts one execution of the shared identity-resolution Cloud Run Job.
 *
 * Credentials: IDENTITY_SERVICE_CLOUD_RUN_JOB_SERVICE_ACCOUNT — JSON key of
 * the Google service account allowed to run the job (same pattern as
 * GOOGLE_CLOUD_SERVICE_ACCOUNT). Never log this value.
 *
 * Job name: IDENTITY_SERVICE_CLOUD_RUN_JOB_RESOURCE_NAME — full resource name
 * `projects/{gcp}/locations/{region}/jobs/{name}`. Not a URL. Jobs have no
 * public endpoint. There is no per-project Cloud Run Job name in Mongo —
 * `project_resources.identification_service.job_id` is the Mongo
 * `identification_jobs` document id, not a GCP resource.
 *
 * Per-execution: Strimix project id is passed via
 * `overrides.containerOverrides.env` (PROJECT_ID). The job template env used
 * by the hourly schedule is never PATCHed.
 *
 * API: POST https://run.googleapis.com/v2/{name}:run
 * (Cloud Run Admin API v2 Jobs.run / runJob)
 */

/** Env key the identity container uses for the Strimix project id. */
const PROJECT_ID_ENV_KEY = 'PROJECT_ID'

const JOB_RESOURCE_NAME =
  /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/jobs\/[a-zA-Z0-9_-]+$/

function readCloudRunJobName(): string {
  const raw = process.env.IDENTITY_SERVICE_CLOUD_RUN_JOB_RESOURCE_NAME
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw TrafficSettingsError.identificationJobNotConfigured()
  }

  const name = raw.trim()
  if (!JOB_RESOURCE_NAME.test(name)) {
    console.error(
      '[identification-job] IDENTITY_SERVICE_CLOUD_RUN_JOB_RESOURCE_NAME is not a valid job resource name',
    )
    throw TrafficSettingsError.identificationJobNotConfigured()
  }

  return name
}

function readRunnerCredentials(): CredentialBody {
  const raw = process.env.IDENTITY_SERVICE_CLOUD_RUN_JOB_SERVICE_ACCOUNT
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw TrafficSettingsError.identificationJobNotConfigured()
  }

  try {
    return JSON.parse(raw) as CredentialBody
  } catch {
    console.error(
      '[identification-job] IDENTITY_SERVICE_CLOUD_RUN_JOB_SERVICE_ACCOUNT is not valid JSON',
    )
    throw TrafficSettingsError.identificationJobNotConfigured()
  }
}

/**
 * Triggers `jobs.run` on the shared identity Cloud Run Job with a per-execution
 * PROJECT_ID override for this Strimix project.
 */
export async function runIdentificationCloudRunJob(projectId: number): Promise<void> {
  const jobName = readCloudRunJobName()
  const credentials = readRunnerCredentials()

  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  })
  const client = await auth.getClient()

  try {
    const response = await client.request({
      url: `https://run.googleapis.com/v2/${jobName}:run`,
      method: 'POST',
      data: {
        overrides: {
          containerOverrides: [
            {
              env: [{ name: PROJECT_ID_ENV_KEY, value: String(projectId) }],
            },
          ],
        },
      },
    })

    const status = response.status ?? 0
    if (status < 200 || status >= 300) {
      console.error(
        `[identification-job] Cloud Run Jobs.run returned ${status} for project ${projectId}`,
      )
      throw TrafficSettingsError.identificationJobRunFailed()
    }
  } catch (error: unknown) {
    if (error instanceof HttpException) {
      throw error
    }

    console.error(
      `[identification-job] Cloud Run Jobs.run failed for project ${projectId}:`,
      error instanceof Error ? error.message : error,
    )
    throw TrafficSettingsError.identificationJobRunFailed()
  }
}
