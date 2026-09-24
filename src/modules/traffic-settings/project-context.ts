import { ProjectResourcesRepository } from '@modules/project-resources'
import {
  BigQueryApi,
  TRAFFIC_SETTINGS_REVISIONS_TABLE_ID,
  type MultiRegionLocation,
} from '@modules/gcloud/bigquery'
import {
  RESOURCE_TABLE_IDS,
  TRAFFIC_SETTINGS_RESOURCES,
  type TrafficSettingsResource,
} from './traffic-settings.constants'
import type { IProjectBigQueryContext } from './traffic-settings.interface'
import { TrafficSettingsError } from './traffic-settings.errors'

/**
 * Resolves where a project's config tables physically live.
 *
 * The only input is a project ID that the gateway has already proven belongs to
 * the caller's organization. Everything else — GCP project, dataset, dataset
 * location, table names — comes from ProjectResourcesRepository. Nothing is
 * derived from a dataset naming convention and nothing is accepted from the
 * request, so a client cannot point this service at another tenant's data.
 */

/**
 * Splits a stored `project.dataset.table` reference and checks it against the
 * project's own placement and the fixed table allowlist.
 *
 * A stored reference that does not match is treated as a broken registration
 * rather than followed: otherwise a corrupted record could silently redirect a
 * write into a different dataset.
 */
function readRegisteredTableId(
  storedReference: string | null | undefined,
  gcpProjectId: string,
  datasetId: string,
  expectedTableId: string,
): { tableId: string | null; misregistered: boolean } {
  if (!storedReference) {
    return { tableId: null, misregistered: false }
  }

  const expectedReference = `${gcpProjectId}.${datasetId}.${expectedTableId}`
  if (storedReference !== expectedReference) {
    return { tableId: null, misregistered: true }
  }

  return { tableId: expectedTableId, misregistered: false }
}

export interface IResolvedProjectContext {
  context: IProjectBigQueryContext
  /** Resources whose stored reference contradicts the project's placement. */
  misregisteredResources: TrafficSettingsResource[]
}

export async function resolveProjectContext(projectId: number): Promise<IResolvedProjectContext> {
  const projectResources = await ProjectResourcesRepository.findOne({ project_id: projectId })

  if (!projectResources) {
    throw TrafficSettingsError.projectResourcesNotFound()
  }

  const gcpProjectId = projectResources.gcloud?.project_id
  const datasetId = projectResources.gcloud?.bigquery?.dataset?.id
  const datasetLocation = projectResources.gcloud?.bigquery?.dataset?.location

  // A project without a dataset is a distinct outcome, never a reason to fall
  // back to a default dataset or to the EU location.
  if (!gcpProjectId || !datasetId || !datasetLocation) {
    throw TrafficSettingsError.projectDatasetNotProvisioned()
  }

  const storedTables = projectResources.gcloud.bigquery.tables as unknown as Record<
    string,
    string | null
  >

  const tableIds = {} as Record<TrafficSettingsResource, string | null>
  const misregisteredResources: TrafficSettingsResource[] = []

  for (const resource of TRAFFIC_SETTINGS_RESOURCES) {
    const expectedTableId = RESOURCE_TABLE_IDS[resource]
    const { tableId, misregistered } = readRegisteredTableId(
      storedTables[expectedTableId],
      gcpProjectId,
      datasetId,
      expectedTableId,
    )
    tableIds[resource] = tableId
    if (misregistered) {
      misregisteredResources.push(resource)
    }
  }

  return {
    context: {
      projectId,
      gcpProjectId,
      datasetId,
      datasetLocation: datasetLocation as MultiRegionLocation,
      tableIds,
      revisionsTableId: TRAFFIC_SETTINGS_REVISIONS_TABLE_ID,
      scheduledQueryName:
        projectResources.gcloud.bigquery.scheduled_queries
          ?.update_costs_and_calculate_attribution ?? null,
    },
    misregisteredResources,
  }
}

/**
 * BigQuery client bound to the project's own GCP project and dataset location.
 * The location travels explicitly so a US dataset is never queried as EU.
 */
export function createBigQueryApiForContext(context: IProjectBigQueryContext): BigQueryApi {
  return new BigQueryApi({
    projectId: context.gcpProjectId,
    datasetLocation: context.datasetLocation,
  })
}

/**
 * Fully-qualified, backtick-quoted table reference.
 *
 * Both identifiers come from the project record and the fixed allowlist, never
 * from request input, and are asserted to contain only the characters BigQuery
 * allows in a dataset or table name. Query parameters carry values; identifiers
 * cannot be parameterized in BigQuery, so they are validated instead.
 */
export function qualifiedTableRef(context: IProjectBigQueryContext, tableId: string): string {
  assertSafeIdentifier(context.gcpProjectId, 'gcp project id')
  assertSafeIdentifier(context.datasetId, 'dataset id')
  assertSafeIdentifier(tableId, 'table id')
  return `\`${context.gcpProjectId}.${context.datasetId}.${tableId}\``
}

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/

export function assertSafeIdentifier(value: string, what: string): void {
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw TrafficSettingsError.unsafeIdentifier(what)
  }
}
