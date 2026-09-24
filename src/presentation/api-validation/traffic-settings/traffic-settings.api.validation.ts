import { Request } from 'express'
import { TrafficSettingsError, type TrafficSettingsItemResource } from '@modules/traffic-settings'
import {
  addReferrerHostsBodySchema,
  deleteBodySchema,
  itemMutationBodySchema,
  previewExcludedUrlParamBodySchema,
  setActiveBodySchema,
  trafficSettingsItemParamsSchema,
  trafficSettingsProjectParamsSchema,
  trafficSettingsResourceParamsSchema,
  updateIdentificationJobStatusBodySchema,
  validateBodySchema,
} from '@presentation/api-schemas/traffic-settings/index.js'
import {
  parseReqSchema,
  validateReqBodySchema,
} from '@presentation/utils/validate-req-body-schema.util'

/**
 * Request validation of the traffic settings routes.
 *
 * Path parameters are validated in place, as elsewhere in this service. Bodies are
 * validated AND written back, because the schemas normalize: an omitted optional
 * field becomes an explicit `null` so the domain layer never has to distinguish
 * "absent" from "not configured".
 *
 * The missing-revision case gets its own error code rather than the generic
 * validation one. The client's correct reaction to it is specific — reload the
 * collection and retry with the revision it returns — and a code is the only thing
 * it can branch on reliably.
 */

function assertExpectedRevisionPresent(req: Request): void {
  const resource = (req.params.resource ?? 'excluded-referrers') as TrafficSettingsItemResource
  const body = req.body as { expected_revision?: unknown } | undefined

  if (!body || body.expected_revision === undefined || body.expected_revision === null) {
    throw TrafficSettingsError.expectedRevisionRequired(resource)
  }
}

const getTrafficSettingsMetaApiValidation = (req: Request): Request => {
  validateReqBodySchema(trafficSettingsProjectParamsSchema, req.params)
  return req
}

const getTrafficSettingsCollectionApiValidation = (req: Request): Request => {
  validateReqBodySchema(trafficSettingsResourceParamsSchema, req.params)
  return req
}

const getTrafficSettingApiValidation = (req: Request): Request => {
  validateReqBodySchema(trafficSettingsItemParamsSchema, req.params)
  return req
}

const createTrafficSettingApiValidation = (req: Request): Request => {
  validateReqBodySchema(trafficSettingsResourceParamsSchema, req.params)
  assertExpectedRevisionPresent(req)
  req.body = parseReqSchema(
    itemMutationBodySchema(req.params.resource as TrafficSettingsItemResource),
    req.body,
  )
  return req
}

const replaceTrafficSettingApiValidation = (req: Request): Request => {
  validateReqBodySchema(trafficSettingsItemParamsSchema, req.params)
  assertExpectedRevisionPresent(req)
  req.body = parseReqSchema(
    itemMutationBodySchema(req.params.resource as TrafficSettingsItemResource),
    req.body,
  )
  return req
}

const setTrafficSettingActiveApiValidation = (req: Request): Request => {
  validateReqBodySchema(trafficSettingsItemParamsSchema, req.params)
  assertExpectedRevisionPresent(req)
  req.body = parseReqSchema(setActiveBodySchema, req.body)
  return req
}

const deleteTrafficSettingApiValidation = (req: Request): Request => {
  validateReqBodySchema(trafficSettingsItemParamsSchema, req.params)
  assertExpectedRevisionPresent(req)
  req.body = parseReqSchema(deleteBodySchema, req.body)
  return req
}

const addExcludedReferrersApiValidation = (req: Request): Request => {
  validateReqBodySchema(trafficSettingsProjectParamsSchema, req.params)
  assertExpectedRevisionPresent(req)
  req.body = parseReqSchema(addReferrerHostsBodySchema, req.body)
  return req
}

const validateTrafficSettingApiValidation = (req: Request): Request => {
  validateReqBodySchema(trafficSettingsProjectParamsSchema, req.params)
  req.body = parseReqSchema(validateBodySchema, req.body)
  return req
}

const previewExcludedUrlParamApiValidation = (req: Request): Request => {
  validateReqBodySchema(trafficSettingsProjectParamsSchema, req.params)
  req.body = parseReqSchema(previewExcludedUrlParamBodySchema, req.body)
  return req
}

const getAttributionJobStatusApiValidation = (req: Request): Request => {
  validateReqBodySchema(trafficSettingsProjectParamsSchema, req.params)
  return req
}

const runAttributionJobApiValidation = (req: Request): Request => {
  validateReqBodySchema(trafficSettingsProjectParamsSchema, req.params)
  return req
}

const getIdentificationJobStatusApiValidation = (req: Request): Request => {
  validateReqBodySchema(trafficSettingsProjectParamsSchema, req.params)
  return req
}

const runIdentificationJobApiValidation = (req: Request): Request => {
  validateReqBodySchema(trafficSettingsProjectParamsSchema, req.params)
  return req
}

const updateIdentificationJobStatusApiValidation = (req: Request): Request => {
  validateReqBodySchema(trafficSettingsProjectParamsSchema, req.params)
  req.body = parseReqSchema(updateIdentificationJobStatusBodySchema, req.body)
  return req
}

export {
  addExcludedReferrersApiValidation,
  createTrafficSettingApiValidation,
  deleteTrafficSettingApiValidation,
  getAttributionJobStatusApiValidation,
  getIdentificationJobStatusApiValidation,
  getTrafficSettingApiValidation,
  getTrafficSettingsCollectionApiValidation,
  getTrafficSettingsMetaApiValidation,
  previewExcludedUrlParamApiValidation,
  replaceTrafficSettingApiValidation,
  runAttributionJobApiValidation,
  runIdentificationJobApiValidation,
  setTrafficSettingActiveApiValidation,
  updateIdentificationJobStatusApiValidation,
  validateTrafficSettingApiValidation,
}
