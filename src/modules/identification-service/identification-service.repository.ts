import mongoose, { Document, Schema } from 'mongoose'
import {
  IDENTIFICATION_JOB_STATUSES,
  type IIdentificationJob,
} from './identification-service.interface'

export interface IIdentificationJobDoc extends Document, Omit<IIdentificationJob, 'id'> {}

const IdentificationJobSchema = new Schema({
  project_id: { type: Number, required: true },
  is_running: { type: Boolean, required: true },
  status: { type: String, required: true, enum: IDENTIFICATION_JOB_STATUSES },
  last_run: { type: Number, required: true },
  error_spec: { type: Object, required: false, default: null },
})

const IdentificationJobConn = mongoose.createConnection(
  process.env.IDENTITY_SERVICE_MONGO_CREDENTIALS as string,
)

const IdentificationJobRepository = IdentificationJobConn.model<IIdentificationJobDoc>(
  'identification_jobs',
  IdentificationJobSchema,
)

export { IdentificationJobRepository }
