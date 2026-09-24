import {
  TrafficSettingsError,
  type ICollectionResult,
  type IItemResult,
  type TrafficSettingsItem,
  type TrafficSettingsItemResource,
} from '@modules/traffic-settings'
import { openTrafficSettingsSession, resolveRevision, runRead } from './traffic-settings.session'

/**
 * Whole collection plus its revision.
 *
 * The readiness check runs first so a missing table, a legacy view or an absent
 * revision row is reported as such. Returning an empty list for any of those
 * would be the worst possible answer: it reads as "nothing is configured" and
 * invites the user to recreate settings that already exist.
 *
 * There is no pagination. These collections are bounded by the application limits
 * and the client does its own search, sort and filter, so a partial page would
 * only create the opportunity to act on an incomplete picture.
 */
const getTrafficSettingsCollection = async (
  projectId: number,
  resource: TrafficSettingsItemResource,
): Promise<ICollectionResult<TrafficSettingsItem>> => {
  const session = await openTrafficSettingsSession(projectId)
  await session.readiness.assertReadable(resource)

  return runRead(resource, async () => {
    const { items, revisions } =
      await session.repository.readCollection<TrafficSettingsItem>(resource)
    return { items, revision: resolveRevision(revisions, resource) }
  })
}

/**
 * One row plus the revision of its whole collection: a mutation of that row is
 * guarded by the collection revision, so the item alone would not be enough to
 * save it back.
 */
const getTrafficSetting = async (
  projectId: number,
  resource: TrafficSettingsItemResource,
  id: string,
): Promise<IItemResult<TrafficSettingsItem>> => {
  const session = await openTrafficSettingsSession(projectId)
  await session.readiness.assertReadable(resource)

  return runRead(resource, async () => {
    const { items, revisions } = await session.repository.readItem<TrafficSettingsItem>(
      resource,
      id,
    )

    if (items.length === 0) {
      throw TrafficSettingsError.notFound(resource, id)
    }
    // Two rows behind one id means no statement can address either of them
    // safely, so this is reported instead of silently returning the first.
    if (items.length > 1) {
      throw TrafficSettingsError.duplicateItemId(resource, id, items.length)
    }

    return { item: items[0], revision: resolveRevision(revisions, resource) }
  })
}

export { getTrafficSettingsCollection, getTrafficSetting }
