import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const ATTRIBUTION_SQL_FILENAME = 'update-costs-and-calculate-attribution.sql'

function readSqlTemplate(filename: string): string {
  const candidates = [
    join(__dirname, filename),
    join(process.cwd(), 'src/modules/gcloud/bigquery/scheduled-queries/templates', filename),
  ]
  const templatePath = candidates.find((candidate) => existsSync(candidate))
  if (!templatePath) {
    throw new Error(`SQL template not found: ${filename}. Tried: ${candidates.join(', ')}`)
  }
  return readFileSync(templatePath, 'utf-8')
}

/**
 * Единая джоба проекта: последовательно обновляет расходы всех рекламных
 * коннекторов (Facebook / Google / TikTok / ручные из Google Sheets) и затем
 * запускает атрибуцию и классификацию трафика по свежему снимку ad_costs.
 * Деплоится как одна scheduled query (раздел 11 ТЗ).
 */
export const UPDATE_COSTS_AND_CALCULATE_ATTRIBUTION_TEMPLATE = readSqlTemplate(
  ATTRIBUTION_SQL_FILENAME,
)
