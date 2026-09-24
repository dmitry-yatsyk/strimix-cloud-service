export interface IProjectResources {
  project_id: number
  stream_id: string
  gcloud: {
    project_id: string
    bigquery: {
      dataset: {
        id: string | null
        location: 'EU' | 'US' | null
      }
      tables: {
        raw_events: string | null
        identified_events: string | null
        profile_merge_events: string | null
        excluded_referrers: string | null
        ad_costs: string | null
        facebook_ads_ad_costs: string | null
        google_ads_ad_costs: string | null
        tiktok_ads_ad_costs: string | null
        traffic_rules: string | null
        attribution_signal_mappings: string | null
        excluded_url_params: string | null
        /**
         * Служебная таблица ревизий четырёх конфигурационных таблиц трафика
         * и атрибуции. Создаётся контролируемым provisioning/миграцией;
         * бизнес-схемы конфигурационных таблиц не меняет.
         */
        traffic_settings_revisions: string | null
      }
      scheduled_queries: {
        /**
         * Единая джоба проекта: расходы всех коннекторов + атрибуция и
         * классификация трафика одной scheduled query (заменила четыре
         * легаси-джобы ниже).
         */
        update_costs_and_calculate_attribution: string | null
        /** @deprecated легаси-джобы до объединения; деплой удаляет их и обнуляет ссылки */
        calculate_events_attribution: string | null
        /** @deprecated легаси-джобы до объединения; деплой удаляет их и обнуляет ссылки */
        facebook_ads_ad_costs_update: string | null
        /** @deprecated легаси-джобы до объединения; деплой удаляет их и обнуляет ссылки */
        google_ads_ad_costs_update: string | null
        /** @deprecated легаси-джобы до объединения; деплой удаляет их и обнуляет ссылки */
        tiktok_ads_ad_costs_update: string | null
      }
    }
    pubsub: {
      topics: {
        event_collector: string | null
      }
      subscriptions: {
        bigquery_raw_events: string | null
        identity_service: string | null
      }
    }
  }
  identification_service: {
    job_id: string | null
  }
  data_processing_service: {
    project_config_id: string | null
  }
}
