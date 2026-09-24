import {
  ATTRIBUTION_SIGNAL_MAPPINGS_TABLE_SCHEMA,
  EXCLUDED_REFERRERS_TABLE_SCHEMA,
  EXCLUDED_URL_PARAMS_TABLE_SCHEMA,
  TRAFFIC_RULES_TABLE_SCHEMA,
} from '@modules/gcloud/bigquery'
import {
  EXCLUDED_REFERRER_WRITABLE_COLUMNS,
  EXCLUDED_URL_PARAM_WRITABLE_COLUMNS,
  MAPPING_WRITABLE_COLUMNS,
  RESOURCE_ID_COLUMNS,
  TRAFFIC_RULE_WRITABLE_COLUMNS,
  type TrafficSettingsItemResource,
} from './traffic-settings.constants'

/**
 * Column allowlists and their BigQuery parameter types, derived from the table
 * schemas rather than written out a second time.
 *
 * Two things follow from deriving them:
 *  - a column that does not exist in the schema cannot be written, so a request
 *    key can never turn into an identifier in a statement;
 *  - a schema change that renames or removes a column fails loudly at startup
 *    instead of producing a statement that silently drops configuration.
 */

interface ISchemaField {
  name: string
  type: string
  mode?: string
}

/** BigQuery query-parameter type for a schema column type. */
function parameterTypeFor(schemaType: string): string {
  switch (schemaType) {
    case 'STRING':
      return 'STRING'
    case 'BOOLEAN':
    case 'BOOL':
      return 'BOOL'
    case 'INTEGER':
    case 'INT64':
      return 'INT64'
    case 'TIMESTAMP':
      return 'TIMESTAMP'
    default:
      throw new Error(`Unsupported traffic settings column type: ${schemaType}`)
  }
}

function buildColumnTypeMap(schema: readonly ISchemaField[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const field of schema) {
    map[field.name] = parameterTypeFor(field.type)
  }
  return map
}

const SCHEMA_COLUMN_TYPES: Record<TrafficSettingsItemResource, Record<string, string>> = {
  'excluded-url-params': buildColumnTypeMap(
    EXCLUDED_URL_PARAMS_TABLE_SCHEMA as readonly ISchemaField[],
  ),
  'excluded-referrers': buildColumnTypeMap(
    EXCLUDED_REFERRERS_TABLE_SCHEMA as readonly ISchemaField[],
  ),
  'traffic-rules': buildColumnTypeMap(TRAFFIC_RULES_TABLE_SCHEMA as readonly ISchemaField[]),
  'attribution-signal-mappings': buildColumnTypeMap(
    ATTRIBUTION_SIGNAL_MAPPINGS_TABLE_SCHEMA as readonly ISchemaField[],
  ),
}

/** Writable columns per resource, in a stable order. */
export const WRITABLE_COLUMNS: Record<TrafficSettingsItemResource, readonly string[]> = {
  'excluded-url-params': EXCLUDED_URL_PARAM_WRITABLE_COLUMNS,
  'excluded-referrers': EXCLUDED_REFERRER_WRITABLE_COLUMNS,
  'traffic-rules': TRAFFIC_RULE_WRITABLE_COLUMNS,
  'attribution-signal-mappings': MAPPING_WRITABLE_COLUMNS,
}

/**
 * All columns the API reads back, id and origin first so a read DTO always
 * exposes them even though they are not writable.
 */
export const READABLE_COLUMNS: Record<TrafficSettingsItemResource, readonly string[]> = {
  'excluded-url-params': ['param_id', 'is_system', ...EXCLUDED_URL_PARAM_WRITABLE_COLUMNS],
  'excluded-referrers': ['referrer_id', ...EXCLUDED_REFERRER_WRITABLE_COLUMNS],
  'traffic-rules': ['rule_id', 'is_system', ...TRAFFIC_RULE_WRITABLE_COLUMNS],
  'attribution-signal-mappings': ['mapping_id', ...MAPPING_WRITABLE_COLUMNS],
}

/**
 * Fails fast when the allowlists and the schemas disagree. Called once at module
 * load, so a mismatch surfaces at service start rather than on a user's save.
 */
function assertAllowlistsMatchSchemas(): void {
  for (const resource of Object.keys(SCHEMA_COLUMN_TYPES) as TrafficSettingsItemResource[]) {
    const schemaColumns = SCHEMA_COLUMN_TYPES[resource]

    for (const column of READABLE_COLUMNS[resource]) {
      if (!(column in schemaColumns)) {
        throw new Error(
          `Traffic settings allowlist for "${resource}" references column "${column}" that is not in the BigQuery schema`,
        )
      }
    }

    const covered = new Set<string>(READABLE_COLUMNS[resource])
    for (const column of Object.keys(schemaColumns)) {
      if (!covered.has(column)) {
        throw new Error(
          `BigQuery schema column "${column}" of "${resource}" is not exposed by the traffic settings API. Every schema field must round-trip`,
        )
      }
    }
  }
}

assertAllowlistsMatchSchemas()

export function columnParameterType(resource: TrafficSettingsItemResource, column: string): string {
  const type = SCHEMA_COLUMN_TYPES[resource][column]
  if (!type) {
    throw new Error(`Unknown traffic settings column "${column}" for resource "${resource}"`)
  }
  return type
}

export function idColumnOf(resource: TrafficSettingsItemResource): string {
  return RESOURCE_ID_COLUMNS[resource]
}

/**
 * Columns the current code writes, used by the readiness check and the migration
 * to detect a table created by an older version.
 */
export function requiredSchemaColumns(resource: TrafficSettingsItemResource): readonly string[] {
  return READABLE_COLUMNS[resource]
}
