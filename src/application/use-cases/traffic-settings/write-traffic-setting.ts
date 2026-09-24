import {
  TrafficSettingsError,
  type IDeleteResult,
  type IMutationResult,
  type ITrafficSettingsActor,
  type TrafficSettingsItem,
  type TrafficSettingsItemInput,
  type TrafficSettingsItemResource,
} from '@modules/traffic-settings'
import {
  applicationInfo,
  assertMutationSucceeded,
  openTrafficSettingsSession,
  runMutation,
  type ITrafficSettingsSession,
} from './traffic-settings.session'
import { assertTrafficSettingsInputValid } from './validate-traffic-settings-input'

/**
 * The four write operations on the id-addressed resources.
 *
 * All of them share the same order, and the order is the point:
 *  1. readiness — refuse a write against an unmigrated or unsafe table;
 *  2. validation — domain invariants and real RE2 compilation;
 *  3. one transactional statement that both guards the revision and writes;
 *  4. read back the stored row, so the response is what the database holds and
 *     never an echo of the request.
 *
 * Step 4 matters more than it looks: the client uses the response as the new
 * baseline for its draft. Echoing the request would let a value the database
 * rejected or coerced live on in the UI as if it had been saved.
 */

/**
 * Re-reads the row a mutation just wrote. The revision comes from the mutation
 * itself, not from this read: the mutation's value is the one this write produced,
 * while a concurrent writer may already have moved the collection on. Pairing the
 * two is deliberate — if that happened, the client's next save fails with a
 * conflict and reloads, which is the correct outcome.
 */
async function readBack(
  session: ITrafficSettingsSession,
  resource: TrafficSettingsItemResource,
  id: string,
): Promise<TrafficSettingsItem> {
  const { items } = await session.repository.readItem<TrafficSettingsItem>(resource, id)
  if (items.length === 0) {
    throw TrafficSettingsError.notFound(resource, id)
  }
  return items[0]
}

const createTrafficSetting = async (
  projectId: number,
  resource: TrafficSettingsItemResource,
  item: TrafficSettingsItemInput,
  expectedRevision: string,
  actor: ITrafficSettingsActor,
): Promise<IMutationResult<TrafficSettingsItem>> => {
  const session = await openTrafficSettingsSession(projectId)
  await session.readiness.assertWritable(resource)
  await assertTrafficSettingsInputValid(session, resource, item as Record<string, unknown>)

  return runMutation(resource, async () => {
    const { result, generatedId } = await session.repository.createItem(
      resource,
      item,
      expectedRevision,
      actor,
    )
    assertMutationSucceeded(result, resource, {
      id: generatedId,
      priority: (item as { priority?: number }).priority,
      host: (item as { host?: string }).host,
    })

    return {
      item: await readBack(session, resource, generatedId),
      revision: result.currentRevision as string,
      application: applicationInfo(),
    }
  })
}

/**
 * Full replacement of the mutable fields. An omitted optional field is stored as
 * NULL rather than left alone, because "leave unchanged" cannot be expressed
 * without knowing which fields the client actually saw — and a client that loaded
 * an older version of the form would silently preserve fields it never displayed.
 */
const replaceTrafficSetting = async (
  projectId: number,
  resource: TrafficSettingsItemResource,
  id: string,
  item: TrafficSettingsItemInput,
  expectedRevision: string,
  actor: ITrafficSettingsActor,
): Promise<IMutationResult<TrafficSettingsItem>> => {
  const session = await openTrafficSettingsSession(projectId)
  await session.readiness.assertWritable(resource)
  await assertTrafficSettingsInputValid(session, resource, item as Record<string, unknown>, id)

  return runMutation(resource, async () => {
    const result = await session.repository.replaceItem(resource, id, item, expectedRevision, actor)
    assertMutationSucceeded(result, resource, {
      id,
      priority: (item as { priority?: number }).priority,
      host: (item as { host?: string }).host,
    })

    return {
      item: await readBack(session, resource, id),
      revision: result.currentRevision as string,
      application: applicationInfo(),
    }
  })
}

/**
 * `is_active` only. Kept separate from the full replace so a list-level toggle
 * cannot accidentally blank the fields the list does not show, which is exactly
 * what a PUT built from a table row would do.
 */
const setTrafficSettingActive = async (
  projectId: number,
  resource: TrafficSettingsItemResource,
  id: string,
  isActive: boolean,
  expectedRevision: string,
  actor: ITrafficSettingsActor,
): Promise<IMutationResult<TrafficSettingsItem>> => {
  const session = await openTrafficSettingsSession(projectId)
  await session.readiness.assertWritable(resource)

  return runMutation(resource, async () => {
    const result = await session.repository.setItemActive(
      resource,
      id,
      isActive,
      expectedRevision,
      actor,
    )
    assertMutationSucceeded(result, resource, { id })

    return {
      item: await readBack(session, resource, id),
      revision: result.currentRevision as string,
      application: applicationInfo(),
    }
  })
}

/**
 * Deletes one row, including a system one. System rows are seeded once at
 * provisioning and never re-inserted, so a deletion is permanent — that is the
 * documented behaviour, not an oversight.
 */
const deleteTrafficSetting = async (
  projectId: number,
  resource: TrafficSettingsItemResource,
  id: string,
  expectedRevision: string,
  actor: ITrafficSettingsActor,
): Promise<IDeleteResult> => {
  const session = await openTrafficSettingsSession(projectId)
  await session.readiness.assertWritable(resource)

  return runMutation(resource, async () => {
    const result = await session.repository.deleteItem(resource, id, expectedRevision, actor)
    assertMutationSucceeded(result, resource, { id })

    return {
      deleted_id: id,
      revision: result.currentRevision as string,
      application: applicationInfo(),
    }
  })
}

export {
  createTrafficSetting,
  deleteTrafficSetting,
  replaceTrafficSetting,
  setTrafficSettingActive,
}
