import { Request, Response, NextFunction, RequestHandler } from 'express'
import { HttpException } from '@presentation/exceptions/http.exception.js'
import { ERRORS } from '@presentation/constants/errors.constants.js'

/**
 * Restricts a route to ONE named internal application.
 *
 * `authMiddleware` accepts any code in APP_AUTHORIZATION_CODES, which is right for
 * the existing provisioning endpoints: several internal services legitimately call
 * them. Traffic settings are different — they are only ever reached on behalf of an
 * end user whose permissions the API gateway has already checked. Accepting another
 * service's code here would mean accepting a caller that performed no such check,
 * so the matched entry itself has to be the gateway.
 *
 * This runs in addition to `authMiddleware`, not instead of it.
 */
/** Must match the `appName` of the gateway's entry in APP_AUTHORIZATION_CODES. */
export const TRAFFIC_SETTINGS_TRUSTED_APP_NAME = 'APP_API_GATEWAY'

interface IAppAuthorizationCode {
  appName: string
  authCode: string
}

function readAuthorizationCodes(): IAppAuthorizationCode[] {
  try {
    const parsed = JSON.parse(process.env.APP_AUTHORIZATION_CODES as string)
    return Array.isArray(parsed) ? (parsed as IAppAuthorizationCode[]) : []
  } catch {
    // A malformed configuration must not read as "no restriction".
    return []
  }
}

function requireTrustedApp(appName: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authorizationCode = req.header('Authorization')
    if (!authorizationCode) {
      throw new HttpException(ERRORS.AUTH.AUTHENTICATION_ERROR)
    }

    // Every entry is considered, not just the first one carrying this code: a
    // deployment may legitimately register one code under more than one name. In
    // that case the restriction is only as strong as the circle of services that
    // hold the shared code, so a dedicated code is what makes it strict.
    const isTrusted = readAuthorizationCodes().some(
      (entry) => entry.authCode === authorizationCode && entry.appName === appName,
    )

    if (!isTrusted) {
      throw new HttpException(ERRORS.AUTH.AUTHENTICATION_ERROR)
    }

    return next()
  }
}

export { requireTrustedApp }
