# Backfill `applies_to_web` / Бэкфилл applies_to_web для SYSTEM origin/channel правил

После нового SQL атрибуции `null`/`false` означает synthetic-only; этот UPDATE ставит `TRUE` на 33 систем origin/channel правила, чтобы они продолжали классифицировать web-визиты. Custom-правила не входят в список id и не обновляются. Меняется только колонка `applies_to_web`.

Замените `<gcp_project>.<dataset>.traffic_rules` на реальную таблицу. Для project 7919 dataset берите из project resources. Не запускайте против всех клиентов.

```sql
UPDATE `<gcp_project>.<dataset>.traffic_rules`
SET applies_to_web = TRUE
WHERE stage IN ('origin', 'channel')
  AND target IN ('visit', 'both')
  AND (applies_to_web IS NULL OR applies_to_web = FALSE)
  AND rule_id IN UNNEST([
    'sys_origin_google_ads',
    'sys_origin_bing_ads',
    'sys_origin_meta_ads',
    'sys_origin_tiktok_ads',
    'sys_origin_linkedin_ads',
    'sys_origin_meta_ads_network',
    'sys_origin_google_ads_network',
    'sys_origin_tiktok_ads_network',
    'sys_origin_google',
    'sys_origin_bing',
    'sys_origin_yandex',
    'sys_origin_duckduckgo',
    'sys_origin_chatgpt',
    'sys_origin_telegram',
    'sys_origin_whatsapp',
    'sys_origin_viber',
    'sys_origin_youtube',
    'sys_origin_instagram',
    'sys_origin_facebook',
    'sys_origin_threads',
    'sys_origin_direct',
    'sys_origin_unknown',
    'sys_channel_paid_social',
    'sys_channel_paid_search',
    'sys_channel_ai_assistants',
    'sys_channel_organic_search',
    'sys_channel_messenger',
    'sys_channel_email',
    'sys_channel_organic_social_medium',
    'sys_channel_organic_social_origin',
    'sys_channel_organic_social_threads',
    'sys_channel_referral',
    'sys_channel_direct'
  ]);
```
