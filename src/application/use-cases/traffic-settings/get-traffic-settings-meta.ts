import { datasetMissingMeta, type IMetaResult } from '@modules/traffic-settings'
import { openTrafficSettingsSession } from './traffic-settings.session'

/**
 * Readiness and diagnostics for all four resources of one project.
 *
 * A project with no BigQuery dataset at all is a normal, reportable state rather
 * than a failure: the section has to be able to say "not provisioned yet" instead
 * of erroring, so the caller can render an explanation. A project that is not
 * registered in this service at all still propagates as 404 — that is a different
 * situation and hiding it would mask a broken registration.
 */
const getTrafficSettingsMeta = async (projectId: number): Promise<IMetaResult> => {
  try {
    const session = await openTrafficSettingsSession(projectId)
    return await session.readiness.buildMeta()
  } catch (error) {
    const details = (error as { details?: { reason_code?: string } }).details
    if (details?.reason_code === 'DATASET_MISSING') {
      return datasetMissingMeta(projectId)
    }
    throw error
  }
}

export { getTrafficSettingsMeta }
