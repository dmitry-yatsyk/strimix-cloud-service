import { Request, Response, NextFunction } from 'express'
import { returnErrorResponse } from '@presentation/utils/return-error-response'
import type {
  ITrafficSettingsActor,
  TrafficSettingsItemInput,
  TrafficSettingsItemResource,
  TrafficSettingsResource,
} from '@modules/traffic-settings'
import { getTrafficSettingsMeta } from '@application/use-cases/traffic-settings/get-traffic-settings-meta'
import {
  getTrafficSetting,
  getTrafficSettingsCollection,
} from '@application/use-cases/traffic-settings/get-traffic-settings-collection'
import {
  createTrafficSetting,
  deleteTrafficSetting,
  replaceTrafficSetting,
  setTrafficSettingActive,
} from '@application/use-cases/traffic-settings/write-traffic-setting'
import { addExcludedReferrers } from '@application/use-cases/traffic-settings/excluded-referrers'
import { validateTrafficSetting } from '@application/use-cases/traffic-settings/validate-traffic-setting'
import { previewExcludedUrlParam } from '@application/use-cases/traffic-settings/preview-excluded-url-param'
import {
  getAttributionJobStatus,
  runAttributionJob,
} from '@application/use-cases/traffic-settings/attribution-job'
import {
  getIdentificationJobStatus,
  runIdentificationJob,
  updateIdentificationJobStatus,
} from '@application/use-cases/traffic-settings/identification-job'
import type { IdentificationJobSettableStatus } from '@modules/identification-service'

/**
 * Traffic settings HTTP layer.
 *
 * It does three things and nothing else: read the request, call one use case, and
 * send the result. Permissions are the API gateway's job — it has the user's JWT
 * and roles; this service only trusts that the caller is the gateway, which
 * `requireTrustedApp` enforces on the router.
 */

/**
 * The actor comes from headers the gateway sets from the verified session. It is
 * recorded on the revision row for auditing and is never used for authorization,
 * so a forged value cannot grant access — but it also must not be taken from an
 * inbound header the gateway did not overwrite, which is the gateway's obligation
 * under the contract.
 */
function readActor(req: Request): ITrafficSettingsActor {
  return {
    actorId: req.header('X-Strimix-Actor-Id') ?? null,
    requestId: req.header('X-Strimix-Request-Id') ?? null,
  }
}

function readProjectId(req: Request): number {
  return Number(req.params.projectId)
}

function readResource(req: Request): TrafficSettingsItemResource {
  return req.params.resource as TrafficSettingsItemResource
}

/** Validated by `trafficSettingsItemParamsSchema` before any handler runs. */
function readItemId(req: Request): string {
  return req.params.id as string
}

export class TrafficSettingsController {
  public static getMeta = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await getTrafficSettingsMeta(readProjectId(req))
      res.status(200).json(result)
      return
    } catch (e: any) {
      returnErrorResponse(e, next)
    }
  }

  public static getCollection = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await getTrafficSettingsCollection(readProjectId(req), readResource(req))
      res.status(200).json(result)
      return
    } catch (e: any) {
      returnErrorResponse(e, next)
    }
  }

  public static getItem = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await getTrafficSetting(readProjectId(req), readResource(req), readItemId(req))
      res.status(200).json(result)
      return
    } catch (e: any) {
      returnErrorResponse(e, next)
    }
  }

  public static createItem = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await createTrafficSetting(
        readProjectId(req),
        readResource(req),
        req.body.item as TrafficSettingsItemInput,
        req.body.expected_revision,
        readActor(req),
      )
      res.status(201).json(result)
      return
    } catch (e: any) {
      returnErrorResponse(e, next)
    }
  }

  public static replaceItem = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await replaceTrafficSetting(
        readProjectId(req),
        readResource(req),
        readItemId(req),
        req.body.item as TrafficSettingsItemInput,
        req.body.expected_revision,
        readActor(req),
      )
      res.status(200).json(result)
      return
    } catch (e: any) {
      returnErrorResponse(e, next)
    }
  }

  public static setItemActive = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await setTrafficSettingActive(
        readProjectId(req),
        readResource(req),
        readItemId(req),
        req.body.is_active,
        req.body.expected_revision,
        readActor(req),
      )
      res.status(200).json(result)
      return
    } catch (e: any) {
      returnErrorResponse(e, next)
    }
  }

  public static deleteItem = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await deleteTrafficSetting(
        readProjectId(req),
        readResource(req),
        readItemId(req),
        req.body.expected_revision,
        readActor(req),
      )
      res.status(200).json(result)
      return
    } catch (e: any) {
      returnErrorResponse(e, next)
    }
  }

  /** Bulk add. Single-row operations use the generic item handlers above. */
  public static addExcludedReferrers = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await addExcludedReferrers(
        readProjectId(req),
        req.body.hosts,
        req.body.expected_revision,
        readActor(req),
      )
      res.status(201).json(result)
      return
    } catch (e: any) {
      returnErrorResponse(e, next)
    }
  }

  public static validate = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await validateTrafficSetting(
        readProjectId(req),
        req.body.resource as TrafficSettingsResource,
        req.body.item,
        req.body.id,
      )
      res.status(200).json(result)
      return
    } catch (e: any) {
      returnErrorResponse(e, next)
    }
  }

  public static previewExcludedUrlParam = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await previewExcludedUrlParam(readProjectId(req), req.body.url, req.body.item)
      res.status(200).json(result)
      return
    } catch (e: any) {
      returnErrorResponse(e, next)
    }
  }

  public static getAttributionJobStatus = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await getAttributionJobStatus(readProjectId(req))
      res.status(200).json(result)
      return
    } catch (e: any) {
      returnErrorResponse(e, next)
    }
  }

  public static runAttributionJob = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await runAttributionJob(readProjectId(req))
      res.status(202).json(result)
      return
    } catch (e: any) {
      returnErrorResponse(e, next)
    }
  }

  public static getIdentificationJobStatus = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await getIdentificationJobStatus(readProjectId(req))
      res.status(200).json(result)
      return
    } catch (e: any) {
      returnErrorResponse(e, next)
    }
  }

  public static runIdentificationJob = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await runIdentificationJob(readProjectId(req))
      res.status(202).json(result)
      return
    } catch (e: any) {
      returnErrorResponse(e, next)
    }
  }

  public static updateIdentificationJobStatus = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await updateIdentificationJobStatus(
        readProjectId(req),
        req.body.status as IdentificationJobSettableStatus,
      )
      res.status(200).json(result)
      return
    } catch (e: any) {
      returnErrorResponse(e, next)
    }
  }
}
