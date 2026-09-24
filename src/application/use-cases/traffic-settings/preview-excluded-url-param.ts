import {
  TrafficSettingsError,
  validateExcludedUrlParamPatterns,
  type IExcludedUrlParamInput,
  type IUrlPreviewResult,
  type IValidationIssue,
} from '@modules/traffic-settings'
import { openTrafficSettingsSession, runRead } from './traffic-settings.session'

/**
 * Shows what ONE draft exclusion would do to ONE URL.
 *
 * Three properties are deliberate:
 *  - it previews the single exclusion being edited, not the project's whole
 *    configuration, so the user sees the effect of their own change;
 *  - it runs the same SQL the attribution job runs, through the shared fragments
 *    in `url-normalization.sql-helper`, so a preview that says a key is removed is
 *    not an approximation of the job's behaviour;
 *  - it reads no stored rows and no events, and it never issues a request to the
 *    address — the URL is just a string parameter.
 *
 * The result is a normalized `landing_page`, which is not the input URL with a
 * tweaked query string: the protocol is gone, `www.` is gone, the trailing slash
 * is gone, the case is folded and the remaining params are sorted. Callers label
 * it accordingly, otherwise it looks like the preview mangled the address.
 */
const RESOURCE = 'excluded-url-params' as const

const previewExcludedUrlParam = async (
  projectId: number,
  url: string,
  item: IExcludedUrlParamInput,
): Promise<IUrlPreviewResult> => {
  const session = await openTrafficSettingsSession(projectId)

  const warnings: IValidationIssue[] = []
  const pattern = typeof item.param_key_regex === 'string' ? item.param_key_regex : ''

  // `is_active: false` still normalizes the URL, it just excludes nothing. That is
  // what makes the preview honest about a disabled row: the landing page is not
  // the raw URL either way.
  const patterns = item.is_active === true && pattern.trim() !== '' ? [pattern] : []

  if (item.is_active !== true) {
    warnings.push({
      field: 'is_active',
      code: 'EXCLUSION_DISABLED',
      message:
        'This exclusion is disabled, so no parameter is removed. Normalization still applies',
    })
  } else if (pattern.trim() === '') {
    warnings.push({
      field: 'param_key_regex',
      code: 'PARAM_KEY_REGEX_EMPTY',
      message: 'No pattern was supplied, so no parameter is removed',
    })
  }

  // An uncompilable pattern would fail the preview query itself, so it is reported
  // as a field error instead of surfacing as a storage failure.
  const regexIssues = await validateExcludedUrlParamPatterns(session.bigqueryApi, patterns)
  if (regexIssues.length > 0) {
    throw TrafficSettingsError.validationFailed(
      RESOURCE,
      regexIssues.map((issue) => ({ ...issue, field: 'param_key_regex' })),
      warnings,
    )
  }

  return runRead(RESOURCE, async () => {
    const preview = await session.repository.previewUrl(url, patterns)
    return { ...preview, warnings }
  })
}

export { previewExcludedUrlParam }
