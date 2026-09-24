import { z, ZodError } from 'zod'
import { HttpException } from '@presentation/exceptions/http.exception.js'
import { ERRORS } from '@presentation/constants/errors.constants.js'
import { Types } from 'mongoose'

const validateReqBodySchema = (schema: z.ZodObject<any, any>, body: any) => {
  try {
    schema.parse(body)
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpException({
        status: ERRORS.OTHER.REQUEST_VALIDATION_ERROR.status,
        code: ERRORS.OTHER.REQUEST_VALIDATION_ERROR.code,
        message: error.issues[0]?.message || 'Validation error',
      })
    } else {
      throw new HttpException(ERRORS.OTHER.INTERNAL_SERVER_ERROR)
    }
  }
}

/**
 * Same validation and same error shape as validateReqBodySchema, but returns the
 * parsed value instead of discarding it. Used where the schema also normalizes —
 * for instance where an omitted optional field has to become an explicit null
 * before it reaches the domain layer.
 */
const parseReqSchema = <TSchema extends z.ZodType>(
  schema: TSchema,
  payload: unknown,
): z.output<TSchema> => {
  try {
    return schema.parse(payload)
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpException({
        status: ERRORS.OTHER.REQUEST_VALIDATION_ERROR.status,
        code: ERRORS.OTHER.REQUEST_VALIDATION_ERROR.code,
        message: error.issues[0]?.message || 'Validation error',
      })
    }
    throw new HttpException(ERRORS.OTHER.INTERNAL_SERVER_ERROR)
  }
}

const requiredField = <T extends z.ZodTypeAny>(fieldName: string, schema: T) => {
  return z.preprocess((val) => {
    if (val === undefined) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: `Field "${fieldName}" is required`,
          path: [fieldName],
        },
      ])
    }
    return val
  }, schema)
}

const objectIdStringSchema = <T extends z.ZodTypeAny>(fieldName: string, schema: T) => {
  return z
    .string({ message: `"${fieldName}" must be a string` })
    .refine((val) => Types.ObjectId.isValid(val), {
      message: `"${fieldName}" must be a valid MongoDB ObjectId`,
      path: [fieldName],
    })
}

export { validateReqBodySchema, parseReqSchema, requiredField, objectIdStringSchema }
