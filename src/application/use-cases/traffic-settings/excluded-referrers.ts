import {
  TrafficSettingsError,
  normalizeHostList,
  type IBulkReferrerResult,
  type IExcludedReferrer,
  type ITrafficSettingsActor,
} from '@modules/traffic-settings'
import {
  applicationInfo,
  assertMutationSucceeded,
  openTrafficSettingsSession,
  runMutation,
} from './traffic-settings.session'

/**
 * Bulk add for excluded referrers.
 *
 * Reads, single-row edits, toggles and deletes all go through the generic
 * id-addressed path; this is the one referrer-specific operation, and it exists
 * because own domains arrive as a pasted set rather than one at a time.
 *
 * Hosts already listed are skipped, not rejected: the caller usually cannot know
 * what is already there, and failing the whole submission would turn a convenience
 * into a chore. The response names the skipped ones so the UI can report them.
 */

const RESOURCE = 'excluded-referrers' as const

const addExcludedReferrers = async (
  projectId: number,
  hosts: string[],
  expectedRevision: string,
  actor: ITrafficSettingsActor,
): Promise<IBulkReferrerResult> => {
  const session = await openTrafficSettingsSession(projectId)
  await session.readiness.assertWritable(RESOURCE)

  // Normalization happens here, once, and the normalized hosts are what gets
  // stored: trim, lower case, IDN to ASCII, one trailing dot dropped, deduplicated.
  // `POST /validate` previews the same transformation, so what the client showed
  // and what is stored agree.
  const normalized = normalizeHostList(hosts)
  if (normalized.errors.length > 0) {
    throw TrafficSettingsError.validationFailed(RESOURCE, normalized.errors, normalized.warnings)
  }

  return runMutation(RESOURCE, async () => {
    const result = await session.repository.createReferrers(
      normalized.hosts,
      expectedRevision,
      actor,
    )
    assertMutationSucceeded(result, RESOURCE, {})

    const skipped = new Set(result.skippedValues)
    const added = normalized.hosts.filter((host) => !skipped.has(host))

    // Read the stored rows back rather than echoing the input: the client uses
    // them as the baseline of its list, so they have to carry the server-generated
    // ids and whatever the table actually holds.
    const { items } = await session.repository.readCollection<IExcludedReferrer>(RESOURCE)
    const addedRows = items.filter((item) => added.includes(item.host))

    return {
      items: addedRows,
      skipped_hosts: result.skippedValues,
      revision: result.currentRevision as string,
      application: applicationInfo(),
    }
  })
}

export { addExcludedReferrers }
