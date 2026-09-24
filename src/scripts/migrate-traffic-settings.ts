import 'dotenv/config'
import mongoose from 'mongoose'
import { ProjectResourcesRepository } from '@modules/project-resources'
import {
  migrateTrafficSettings,
  type IMigrationReport,
} from '@application/use-cases/traffic-settings/migrate-traffic-settings'

/**
 * Operator entry point for the traffic settings migration.
 *
 * Dry run is the default and the only mode that needs no argument, because the
 * useful first step is always "tell me what you would change". `--apply` is
 * deliberately explicit.
 *
 *   npx tsx src/scripts/migrate-traffic-settings.ts --project=123
 *   npx tsx src/scripts/migrate-traffic-settings.ts --project=123 --apply
 *   npx tsx src/scripts/migrate-traffic-settings.ts --all
 *   npx tsx src/scripts/migrate-traffic-settings.ts --all --apply --json
 *
 * Projects are processed one at a time on purpose: each one issues BigQuery jobs
 * against its own dataset, and a parallel sweep across every tenant would turn a
 * maintenance task into a load spike.
 */

interface IOptions {
  projectIds: number[] | 'all'
  apply: boolean
  json: boolean
}

function parseArguments(argv: string[]): IOptions {
  const apply = argv.includes('--apply')
  const json = argv.includes('--json')

  if (argv.includes('--all')) {
    return { projectIds: 'all', apply, json }
  }

  const projectIds = argv
    .filter((argument) => argument.startsWith('--project='))
    .flatMap((argument) => argument.slice('--project='.length).split(','))
    .map((value) => Number(value.trim()))

  if (projectIds.length === 0 || projectIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error('Specify --all or --project=<id>[,<id>...] with positive integer project ids')
  }

  return { projectIds, apply, json }
}

function printReport(report: IMigrationReport): void {
  const mode = report.dryRun ? 'DRY RUN' : 'APPLIED'
  console.log(`\n=== project ${report.projectId} (${mode}) ===`)

  if (report.failed) {
    console.log(`  FAILED: ${report.failure}`)
    return
  }

  console.log(`  dataset: ${report.gcpProjectId}.${report.datasetId}`)
  for (const step of report.steps) {
    console.log(`  [${step.status}] ${step.step}${step.detail ? ` — ${step.detail}` : ''}`)
  }

  const readiness = report.readinessAfter ?? report.readinessBefore
  if (readiness) {
    const label = report.readinessAfter ? 'readiness after' : 'readiness'
    console.log(`  ${label}:`)
    for (const [resource, state] of Object.entries(readiness)) {
      const reason = state.reason_code ? ` (${state.reason_code})` : ''
      console.log(
        `    ${resource}: ${state.state}${reason} read=${state.readable} write=${state.writable}`,
      )
    }
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))

  // With --json, stdout carries the report and nothing else, so it can be piped
  // into jq. The narration goes to stderr, where it is still visible on a terminal.
  const narrate = options.json ? console.error : console.log

  await mongoose.connect(`${process.env.MONGO_CREDENTIALS}`)

  try {
    const projectIds =
      options.projectIds === 'all'
        ? (await ProjectResourcesRepository.find({}, { project_id: 1 }).lean())
            .map((document) => document.project_id)
            .sort((left, right) => left - right)
        : options.projectIds

    narrate(
      `Migrating traffic settings for ${projectIds.length} project(s) in ${
        options.apply ? 'apply' : 'dry-run'
      } mode`,
    )

    const reports: IMigrationReport[] = []
    for (const projectId of projectIds) {
      const report = await migrateTrafficSettings(projectId, { dryRun: !options.apply })
      reports.push(report)
      if (!options.json) {
        printReport(report)
      }
    }

    if (options.json) {
      console.log(JSON.stringify(reports, null, 2))
    }

    const failed = reports.filter((report) => report.failed)
    const skipped = reports.filter((report) =>
      report.steps.some((step) => step.status === 'skipped'),
    )

    narrate(
      `\nDone. ${reports.length} project(s), ${failed.length} failed, ${skipped.length} with skipped steps.`,
    )

    // A skipped step is not a crash, but it does mean the project is not fully
    // migrated — leaving the attribution query untouched because referrers are
    // still in the old shape is exactly what a runbook must not miss.
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
