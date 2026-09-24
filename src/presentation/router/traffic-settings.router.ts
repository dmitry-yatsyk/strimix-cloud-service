import { Router } from 'express'
import { IRouter } from '@presentation/interfaces/router.interface.js'
import { TrafficSettingsController } from '@presentation/controllers/traffic-settings.controller.js'
import { authMiddleware } from '@presentation/middleware/auth.middleware.js'
import {
  TRAFFIC_SETTINGS_TRUSTED_APP_NAME,
  requireTrustedApp,
} from '@presentation/middleware/trusted-app.middleware.js'
import { validationMiddleware } from '@presentation/middleware/validation.middleware.js'
import {
  addExcludedReferrersApiValidation,
  createTrafficSettingApiValidation,
  deleteTrafficSettingApiValidation,
  getTrafficSettingApiValidation,
  getTrafficSettingsCollectionApiValidation,
  getTrafficSettingsMetaApiValidation,
  getAttributionJobStatusApiValidation,
  getIdentificationJobStatusApiValidation,
  previewExcludedUrlParamApiValidation,
  replaceTrafficSettingApiValidation,
  runAttributionJobApiValidation,
  runIdentificationJobApiValidation,
  setTrafficSettingActiveApiValidation,
  updateIdentificationJobStatusApiValidation,
  validateTrafficSettingApiValidation,
} from '@presentation/api-validation/traffic-settings/traffic-settings.api.validation'

/**
 * Internal routes of the traffic and attribution settings.
 *
 * Route ORDER is load-bearing. Every literal path — `/meta`, `/validate`,
 * `/excluded-url-params/preview`, `/excluded-referrers/bulk`, `/attribution-job/*`,
 * `/identification-job/*` —
 * is registered before the `/:resource` and `/:resource/:id` patterns, because
 * Express matches in declaration order and `/:resource` would otherwise swallow
 * `meta` and treat it as a resource slug. The slug itself is still validated
 * against a closed enum, so a mismatch is a 400 rather than an attempt to reach
 * an unknown table.
 *
 * Both middlewares are applied to every route: `authMiddleware` proves the caller
 * holds a known service code, and `requireTrustedApp` proves that code belongs to
 * the API gateway specifically — the only caller that has verified a user's
 * permissions before getting here.
 */
class TrafficSettingsRouter implements IRouter {
  public path: string = '/project-resources'
  public router = Router()

  constructor() {
    this.initialiseRoutes()
  }

  private get base(): string {
    return `${this.path}/:projectId/traffic-settings`
  }

  private initialiseRoutes(): void {
    const guards = [authMiddleware, requireTrustedApp(TRAFFIC_SETTINGS_TRUSTED_APP_NAME)]

    this.router.get(
      `${this.base}/meta`,
      ...guards,
      validationMiddleware(getTrafficSettingsMetaApiValidation),
      TrafficSettingsController.getMeta,
    )

    this.router.post(
      `${this.base}/validate`,
      ...guards,
      validationMiddleware(validateTrafficSettingApiValidation),
      TrafficSettingsController.validate,
    )

    this.router.post(
      `${this.base}/excluded-url-params/preview`,
      ...guards,
      validationMiddleware(previewExcludedUrlParamApiValidation),
      TrafficSettingsController.previewExcludedUrlParam,
    )

    // Bulk add of referrer hosts. Reads, edits, toggles and deletes of referrers
    // go through the generic `/:resource` routes below like any other resource.
    this.router.post(
      `${this.base}/excluded-referrers/bulk`,
      ...guards,
      validationMiddleware(addExcludedReferrersApiValidation),
      TrafficSettingsController.addExcludedReferrers,
    )

    this.router.get(
      `${this.base}/attribution-job/status`,
      ...guards,
      validationMiddleware(getAttributionJobStatusApiValidation),
      TrafficSettingsController.getAttributionJobStatus,
    )

    this.router.post(
      `${this.base}/attribution-job/run`,
      ...guards,
      validationMiddleware(runAttributionJobApiValidation),
      TrafficSettingsController.runAttributionJob,
    )

    this.router.get(
      `${this.base}/identification-job/status`,
      ...guards,
      validationMiddleware(getIdentificationJobStatusApiValidation),
      TrafficSettingsController.getIdentificationJobStatus,
    )

    this.router.post(
      `${this.base}/identification-job/run`,
      ...guards,
      validationMiddleware(runIdentificationJobApiValidation),
      TrafficSettingsController.runIdentificationJob,
    )

    this.router.patch(
      `${this.base}/identification-job/status`,
      ...guards,
      validationMiddleware(updateIdentificationJobStatusApiValidation),
      TrafficSettingsController.updateIdentificationJobStatus,
    )

    this.router.get(
      `${this.base}/:resource`,
      ...guards,
      validationMiddleware(getTrafficSettingsCollectionApiValidation),
      TrafficSettingsController.getCollection,
    )

    this.router.post(
      `${this.base}/:resource`,
      ...guards,
      validationMiddleware(createTrafficSettingApiValidation),
      TrafficSettingsController.createItem,
    )

    this.router.get(
      `${this.base}/:resource/:id`,
      ...guards,
      validationMiddleware(getTrafficSettingApiValidation),
      TrafficSettingsController.getItem,
    )

    this.router.put(
      `${this.base}/:resource/:id`,
      ...guards,
      validationMiddleware(replaceTrafficSettingApiValidation),
      TrafficSettingsController.replaceItem,
    )

    this.router.patch(
      `${this.base}/:resource/:id/active`,
      ...guards,
      validationMiddleware(setTrafficSettingActiveApiValidation),
      TrafficSettingsController.setItemActive,
    )

    this.router.delete(
      `${this.base}/:resource/:id`,
      ...guards,
      validationMiddleware(deleteTrafficSettingApiValidation),
      TrafficSettingsController.deleteItem,
    )
  }
}

export { TrafficSettingsRouter }
