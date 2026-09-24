export const EXCLUDED_REFERRERS_TABLE_ID = 'excluded_referrers'

/**
 * Per-project list of referrer hosts excluded from referral attribution
 * (self-referrals / own domains that must not count as referral traffic).
 *
 * One row per host, addressed by `referrer_id`, so a single domain can be
 * disabled without deleting it and edited without rewriting the whole list.
 * The attribution job reads the active rows directly; an inactive row is kept
 * for the operator but excludes nothing.
 *
 * `host` holds a normalized hostname (lowercase, no scheme, no port, no
 * trailing dot, IDN in punycode) and is unique across active and inactive rows
 * alike — two rows for one domain have no meaning and the API refuses them.
 *
 * Client-owned: created empty at deploy, then edited via the traffic settings
 * UI. Projects deployed before this shape stored a single row with a REPEATED
 * `hosts` column; `migrate-traffic-settings` converts them and the readiness
 * probe reports the old shape as `migration_required` until it has run.
 */
export const EXCLUDED_REFERRERS_TABLE_SCHEMA = [
  { name: 'referrer_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'host', type: 'STRING', mode: 'REQUIRED' },
  { name: 'is_active', type: 'BOOLEAN', mode: 'REQUIRED' },
  { name: 'description', type: 'STRING' },
]

/** Column of the pre-row-per-host layout, used to recognize a table to migrate. */
export const EXCLUDED_REFERRERS_LEGACY_COLUMN = 'hosts'
