import 'dotenv/config'
import mongoose from 'mongoose'
import { migrateAdAccountColumns } from '@application/use-cases/ad-costs/migrate-ad-account-columns'
import type { IMigrationReport } from '@application/use-cases/traffic-settings/migrate-traffic-settings'

/**
 * Adds the ad account columns (staging tables + ad_costs) and deploys the
 * attribution query that fills them. Dry run by default; `--apply` is explicit.
 * Projects are processed one at a time, as in migrate-traffic-settings.
 *
 *   npx tsx src/scripts/migrate-ad-account-columns.ts --project=7924
 *   npx tsx src/scripts/migrate-ad-account-columns.ts --project=7924 --apply
 */

function parseArguments(argv: string[]): { projectIds: number[]; apply: boolean } {
  const projectIds = argv
    .filter((argument) => argument.startsWith('--project='))
    .flatMap((argument) => argument.slice('--project='.length).split(','))
    .map((value) => Number(value.trim()))

  if (projectIds.length === 0 || projectIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error('Specify --project=<id>[,<id>...] with positive integer project ids')
  }

  return { projectIds, apply: argv.includes('--apply') }
}

function printReport(report: IMigrationReport): void {
  console.log(`\n=== project ${report.projectId} (${report.dryRun ? 'DRY RUN' : 'APPLIED'}) ===`)
  if (report.failed) {
    console.log(`  FAILED: ${report.failure}`)
    return
  }
  console.log(`  dataset: ${report.gcpProjectId}.${report.datasetId}`)
  for (const step of report.steps) {
    console.log(`  [${step.status}] ${step.step}${step.detail ? ` — ${step.detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  const { projectIds, apply } = parseArguments(process.argv.slice(2))

  await mongoose.connect(`${process.env.MONGO_CREDENTIALS}`)

  try {
    console.log(
      `Migrating ad account columns for ${projectIds.length} project(s) in ${apply ? 'apply' : 'dry-run'} mode`,
    )

    const reports: IMigrationReport[] = []
    for (const projectId of projectIds) {
      const report = await migrateAdAccountColumns(projectId, { dryRun: !apply })
      reports.push(report)
      printReport(report)
    }

    const failed = reports.filter((report) => report.failed)
    const skipped = reports.filter((report) =>
      report.steps.some((step) => step.status === 'skipped'),
    )
    console.log(
      `\nDone. ${reports.length} project(s), ${failed.length} failed, ${skipped.length} with skipped steps.`,
    )
    if (failed.length > 0 || skipped.length > 0) {
      process.exitCode = 1
    }
  } finally {
    await mongoose.connection.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
