import { Document, Schema, model } from 'mongoose'
import { IProjectResources } from './project-resources.interface'

export interface IProjectResourcesDoc extends Document, Omit<IProjectResources, 'id'> {}

const ProjectResourcesSchema = new Schema(
  {
    project_id: { type: Number, required: true },
    stream_id: { type: String, required: true },
    gcloud: {
      project_id: { type: String, default: null },
      bigquery: {
        dataset: {
          id: { type: String, default: null },
          location: { type: String, default: null, enum: ['EU', 'US'] },
        },
        tables: {
          raw_events: { type: String, default: null },
          identified_events: { type: String, default: null },
          profile_merge_events: { type: String, default: null },
          excluded_referrers: { type: String, default: null },
          ad_costs: { type: String, default: null },
          facebook_ads_ad_costs: { type: String, default: null },
          google_ads_ad_costs: { type: String, default: null },
          tiktok_ads_ad_costs: { type: String, default: null },
          traffic_rules: { type: String, default: null },
          attribution_signal_mappings: { type: String, default: null },
          excluded_url_params: { type: String, default: null },
          traffic_settings_revisions: { type: String, default: null },
        },
        scheduled_queries: {
          update_costs_and_calculate_attribution: { type: String, default: null },
          calculate_events_attribution: { type: String, default: null },
          facebook_ads_ad_costs_update: { type: String, default: null },
          google_ads_ad_costs_update: { type: String, default: null },
          tiktok_ads_ad_costs_update: { type: String, default: null },
        },
      },
      pubsub: {
        topics: {
          event_collector: { type: String, default: null },
        },
        subscriptions: {
          bigquery_raw_events: { type: String, default: null },
          identity_service: { type: String, default: null },
        },
      },
    },
    identification_service: {
      job_id: { type: String, default: null },
    },
    data_processing_service: {
      project_config_id: { type: String, default: null },
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  },
)

const ProjectResourcesRepository = model<IProjectResourcesDoc>(
  'project_resources',
  ProjectResourcesSchema,
)

export { ProjectResourcesRepository }
