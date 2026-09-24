import { domainToASCII } from 'node:url'
import { TRAFFIC_SETTINGS_LIMITS } from './traffic-settings.constants'
import type { IValidationIssue } from './traffic-settings.interface'

/**
 * Normalization and validation of referrer hosts.
 *
 * The excluded_referrers table stores plain hostnames only, because the
 * attribution job compares them against the referrer HOST of a page view. A
 * value carrying a scheme, a port, a path, a query, a fragment or a wildcard
 * would silently never match, so it is rejected instead.
 *
 * The same code runs for API writes, for the UI preview of a pasted list and
 * for the migration preflight, so a host can never be normalized one way on
 * save and another way during migration.
 */

export interface IHostNormalizationOutcome {
  /** Accepted hosts, normalized, de-duplicated and sorted by ASCII hostname. */
  hosts: string[]
  errors: IValidationIssue[]
  warnings: IValidationIssue[]
  /**
   * Inputs that normalized onto an already present host. Reported so the UI can
   * show "3 duplicates removed" rather than silently shrinking the list.
   */
  duplicates: string[]
}

const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/

function issue(field: string, code: string, message: string): IValidationIssue {
  return { field, code, message }
}

/**
 * Normalizes one host. Returns the normalized value, or the reason it cannot be
 * used. Normalization is: trim, lower case, IDN to ASCII punycode, drop a single
 * trailing DNS dot.
 */
export function normalizeHost(
  rawHost: string,
  field: string,
): { host: string | null; error: IValidationIssue | null } {
  const trimmed = rawHost.trim()

  if (trimmed === '') {
    return { host: null, error: issue(field, 'HOST_EMPTY', 'Host must not be empty') }
  }

  if (/[\s]/.test(trimmed)) {
    return {
      host: null,
      error: issue(field, 'HOST_CONTAINS_WHITESPACE', 'Host must not contain whitespace'),
    }
  }

  if (trimmed.includes('://')) {
    return {
      host: null,
      error: issue(
        field,
        'HOST_CONTAINS_SCHEME',
        'Enter the hostname only, without a protocol such as https://',
      ),
    }
  }

  if (trimmed.includes('/')) {
    return {
      host: null,
      error: issue(field, 'HOST_CONTAINS_PATH', 'Enter the hostname only, without a path'),
    }
  }

  if (trimmed.includes('?') || trimmed.includes('#')) {
    return {
      host: null,
      error: issue(
        field,
        'HOST_CONTAINS_QUERY_OR_FRAGMENT',
        'Enter the hostname only, without a query string or fragment',
      ),
    }
  }

  if (trimmed.includes('@')) {
    return {
      host: null,
      error: issue(field, 'HOST_CONTAINS_USERINFO', 'Enter the hostname only, without credentials'),
    }
  }

  if (trimmed.includes('*')) {
    return {
      host: null,
      error: issue(
        field,
        'HOST_CONTAINS_WILDCARD',
        'Wildcards are not supported. Add each subdomain as a separate host',
      ),
    }
  }

  // A colon means a port, or an IPv6 literal. Both are out of scope for v1.
  if (trimmed.includes(':')) {
    return {
      host: null,
      error: issue(field, 'HOST_CONTAINS_PORT', 'Enter the hostname only, without a port'),
    }
  }

  const lowered = trimmed.toLowerCase()
  // A single trailing dot is the DNS root and carries no meaning here; more than
  // one, or a leading dot, means an empty label.
  const withoutRootDot = lowered.endsWith('.') ? lowered.slice(0, -1) : lowered

  if (withoutRootDot === '') {
    return { host: null, error: issue(field, 'HOST_EMPTY', 'Host must not be empty') }
  }

  if (IPV4_PATTERN.test(withoutRootDot)) {
    return {
      host: null,
      error: issue(
        field,
        'HOST_IS_IP_ADDRESS',
        'IP addresses are not supported in this version. Use a hostname',
      ),
    }
  }

  const ascii = domainToASCII(withoutRootDot)
  if (ascii === '') {
    return {
      host: null,
      error: issue(field, 'HOST_INVALID', 'Host is not a valid domain name'),
    }
  }

  const labels = ascii.split('.')

  if (labels.length < 2) {
    return {
      host: null,
      error: issue(
        field,
        'HOST_SINGLE_LABEL',
        'Single-label hosts such as "localhost" are not supported in this version',
      ),
    }
  }

  if (ascii.length > TRAFFIC_SETTINGS_LIMITS.HOSTNAME_MAX_LENGTH) {
    return {
      host: null,
      error: issue(
        field,
        'HOST_TOO_LONG',
        `Host must be at most ${TRAFFIC_SETTINGS_LIMITS.HOSTNAME_MAX_LENGTH} characters`,
      ),
    }
  }

  for (const label of labels) {
    if (label === '') {
      return {
        host: null,
        error: issue(field, 'HOST_EMPTY_LABEL', 'Host must not contain an empty label'),
      }
    }
    if (label.length > TRAFFIC_SETTINGS_LIMITS.HOSTNAME_LABEL_MAX_LENGTH) {
      return {
        host: null,
        error: issue(
          field,
          'HOST_LABEL_TOO_LONG',
          `Each part of the host must be at most ${TRAFFIC_SETTINGS_LIMITS.HOSTNAME_LABEL_MAX_LENGTH} characters`,
        ),
      }
    }
    if (!HOST_LABEL_PATTERN.test(label)) {
      return {
        host: null,
        error: issue(
          field,
          'HOST_INVALID_LABEL',
          'Host parts may contain letters, digits and hyphens, and must not start or end with a hyphen',
        ),
      }
    }
  }

  return { host: ascii, error: null }
}

/**
 * Normalizes a pasted list of hosts for a bulk add. The stored set is the union
 * of what is already there and what this function accepts; duplicates against
 * existing rows are reported, not overwritten.
 *
 * An empty input list is valid and means "add nothing".
 */
export function normalizeHostList(
  rawHosts: string[],
  fieldPrefix = 'hosts',
): IHostNormalizationOutcome {
  const errors: IValidationIssue[] = []
  const duplicates: string[] = []
  const warnings: IValidationIssue[] = []
  const seen = new Map<string, string>()

  rawHosts.forEach((rawHost, index) => {
    const field = `${fieldPrefix}[${index}]`

    if (typeof rawHost !== 'string') {
      errors.push(issue(field, 'HOST_NOT_A_STRING', 'Host must be a string'))
      return
    }

    const { host, error } = normalizeHost(rawHost, field)
    if (error) {
      errors.push(error)
      return
    }

    if (seen.has(host as string)) {
      duplicates.push(rawHost)
      return
    }
    seen.set(host as string, rawHost)
  })

  const hosts = [...seen.keys()].sort()

  if (hosts.length > TRAFFIC_SETTINGS_LIMITS.HOSTS_MAX_COUNT) {
    errors.push(
      issue(
        fieldPrefix,
        'HOSTS_LIMIT_EXCEEDED',
        `At most ${TRAFFIC_SETTINGS_LIMITS.HOSTS_MAX_COUNT} hosts are supported`,
      ),
    )
  }

  if (duplicates.length > 0) {
    warnings.push(
      issue(
        fieldPrefix,
        'HOSTS_DUPLICATES_REMOVED',
        `${duplicates.length} duplicate host(s) were removed after normalization`,
      ),
    )
  }

  return { hosts, errors, warnings, duplicates }
}

/**
 * Splits pasted multiline input into candidate hosts. Used by the UI drawer via
 * the validate endpoint so the preview of "one host per line" matches the write.
 */
export function splitHostInput(rawInput: string): string[] {
  return rawInput
    .split(/[\r\n,;]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/**
 * Checks whether an existing stored list would change under current
 * normalization. The migration must not silently alter the excluded set, so a
 * difference stops that resource and is reported instead of being applied.
 */
export function diffStoredHostList(storedHosts: string[]): {
  normalized: string[]
  unchanged: boolean
  rejected: IValidationIssue[]
  changed: Array<{ from: string; to: string }>
} {
  const rejected: IValidationIssue[] = []
  const changed: Array<{ from: string; to: string }> = []
  const normalizedSet = new Set<string>()

  storedHosts.forEach((storedHost, index) => {
    const { host, error } = normalizeHost(storedHost, `hosts[${index}]`)
    if (error) {
      rejected.push(error)
      return
    }
    if (host !== storedHost) {
      changed.push({ from: storedHost, to: host as string })
    }
    normalizedSet.add(host as string)
  })

  const normalized = [...normalizedSet].sort()
  const storedSet = new Set(storedHosts)
  const unchanged =
    rejected.length === 0 &&
    changed.length === 0 &&
    normalized.length === storedSet.size &&
    normalized.every((host) => storedSet.has(host))

  return { normalized, unchanged, rejected, changed }
}
