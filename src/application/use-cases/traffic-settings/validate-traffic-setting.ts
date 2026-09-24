import type { IValidationResult, TrafficSettingsResource } from '@modules/traffic-settings'
import { openTrafficSettingsSession } from './traffic-settings.session'
import { validateTrafficSettingsInput } from './validate-traffic-settings-input'

/**
 * Checks a draft and writes nothing.
 *
 * It exists so the editor can report a bad expression or a priority collision
 * before the user commits, and so the referrer drawer can show what normalization
 * will do to a pasted list. It is explicitly not a guarantee: the revision and the
 * priority constraint are re-checked inside the write transaction, because that is
 * the only place they can actually be enforced.
 */
const validateTrafficSetting = async (
  projectId: number,
  resource: TrafficSettingsResource,
  item: Record<string, unknown>,
  id: string | null,
): Promise<IValidationResult> => {
  const session = await openTrafficSettingsSession(projectId)
  // Validating against a resource that cannot be read would produce a misleading
  // "valid" for a project where nothing can be saved at all.
  await session.readiness.assertReadable(resource)

  return validateTrafficSettingsInput(session, resource, item, id)
}

export { validateTrafficSetting }
