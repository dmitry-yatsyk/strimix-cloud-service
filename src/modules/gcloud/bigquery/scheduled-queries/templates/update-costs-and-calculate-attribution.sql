-- =====================================================================
-- ЕДИНАЯ ДЖОБА ПРОЕКТА: ЗАГРУЗКА РАСХОДОВ + АТРИБУЦИЯ И КЛАССИФИКАЦИЯ
-- =====================================================================
-- Бизнес-смысл: все пересчёты проекта выполняются В ОДНОЙ scheduled query
-- строго последовательно. Сначала обновляются расходы всех рекламных
-- коннекторов, затем этап атрибуции пересчитывает визиты, конверсии и
-- классификацию трафика уже по свежему снимку ad_costs. Раньше это были
-- отдельные джобы с независимыми расписаниями: атрибуция могла отработать
-- по расходам шестичасовой давности, а проекционные метки расходов и
-- синтетических визитов могли считаться от разных снимков и разъезжаться.
-- Единая джоба устраняет эту гонку по построению (раздел 11 ТЗ).
--
-- Порядок этапов:
--   1/5 Facebook Ads: загружает расходы Facebook в ad_costs через MERGE
--       (атомарно заменяет все строки этой сети).
--   2/5 Google Ads: то же для расходов Google Ads.
--   3/5 TikTok Ads: то же для расходов TikTok Ads.
--   4/5 Ручные расходы (Google Sheets): то же для ручных расходов; этап
--       выполняется только если в датасете есть таблица additional_ad_costs_gs
--       (она подключается клиенту индивидуально и есть не у всех проектов).
--   5/5 Атрибуция: пересобирает visits (веб + синтетика), атрибутирует
--       события/заказы/сделки и заполняет traffic_origin/traffic_channel
--       и landing_page у visits и ad_costs.
--
-- Техника: каждый этап оформлен как самостоятельный begin/end-блок со
-- своими declare-переменными, поэтому области видимости не пересекаются.
-- Ошибка любого этапа прерывает джобу целиком (падение видно в логах
-- Transfer runs). Следующий запуск по расписанию повторит все этапы с
-- нуля; каждый этап идемпотентен (MERGE / полная пересборка таблиц).
-- Плейсхолдеры GCP_PROJECT_NAME / GPC_BQ_DATASET_NAME / PROJECT_TIMEZONE
-- (в коде объявлены с префиксом @; подставляются при деплое через
-- processScheduledQueryTemplate). Точные токены вида @... в комментарии
-- намеренно не пишем: иначе процессор заменил бы их и здесь.
-- =====================================================================

-- ============================================================
-- ЭТАП 1/5: РАСХОДЫ FACEBOOK ADS
-- ============================================================

begin

declare _project_name string default '@GCP_PROJECT_NAME';
declare _dataset_name string default '@GPC_BQ_DATASET_NAME';

-- Загружаем расходы Facebook Ads в ad_costs.
begin

declare query string;
declare query_template string;

-- Атомарно заменяем все строки Facebook Ads в таблице ad_costs одним MERGE.
-- Зачем: отчёт, запущенный во время прогона, видит либо полностью старый,
-- либо полностью новый набор строк этой сети. Окна «строки уже удалены,
-- а новые ещё не вставлены» (как при прежнем DELETE+INSERT) больше нет.
-- Как устроен MERGE: условие соединения ON FALSE делает каждую строку
-- источника «не совпавшей с целью», поэтому она вставляется в ad_costs;
-- и каждую строку цели «не совпавшей с источником», поэтому строки этой
-- сети удаляются, а строки других сетей условие не затрагивает.
-- В BigQuery такой MERGE выполняется атомарно.
set query_template = """
merge `<project_name>.<dataset_name>.ad_costs` as t
using (

with 
-- Собираем ключ сопоставления из даты, рекламного аккаунта, всех UTM и ad_id.
-- По этому ключу ниже отслеживаем, сменились ли UTM объявления между выгрузками.
source_match_keys as (
  select
    concat(
      cast(date as string),
      ad_account_id,
      ifnull(trim(source), '_'),
      ifnull(trim(medium), '_'),
      ifnull(trim(campaign), '_'),
      ifnull(trim(content), '_'),
      ifnull(trim(term), '_'),
      ifnull(trim(strimix_refid), '_')
    , ad_id) match_key,
    *
  from `<project_name>.<dataset_name>.facebook_ads_ad_costs`
), 

-- Нумеруем строки каждого объявления за день в порядке выгрузки (inserted_at),
-- чтобы дальше выбрать нужную версию строки как источник метрик.
ordered_match_keys as (
  select row_number() over (partition by ad_id, date order by inserted_at asc) row_number, * from source_match_keys
), 

-- Находим объявления, у которых UTM сменились между выгрузками.
-- Нужно, чтобы не задваивать расходы: если объявление сначала выгрузилось
-- с UTM A, а потом пользователь сменил UTM на B, расход должен остаться
-- один раз (привязанным к актуальной метке).
find_ads_with_changed_utms as (
  select
    case when
      lead(match_key) over(partition by ad_id, date order by inserted_at asc) != match_key
      then row_number
      else null end primary_utm_row_number,
    match_key,
    ad_id,
    date
  from ordered_match_keys
),

ads_with_changed_utms as (
  select * from find_ads_with_changed_utms
  where primary_utm_row_number is not null
),

-- Для объявлений со сменившимися UTM определяем номер строки, из которой
-- ниже брать метрики (cost/impressions/...), чтобы подтянуть их к актуальным UTM.
ads_with_changed_utms_filtered as (
  select 
    first_value(primary_utm_row_number) over(partition by ad_id, date order by primary_utm_row_number asc) last_row,
    date,
    ad_id,
    first_value(match_key) over(partition by ad_id, date order by primary_utm_row_number asc) match_key
  from ads_with_changed_utms
),

ads_with_changed_utms_grouped as (
  select * from ads_with_changed_utms_filtered
  group by last_row, date, ad_id, match_key
),

latest_matched_rows as (
  select 
    if(
      match_key in (select i.match_key from ads_with_changed_utms_grouped i where i.match_key = t1.match_key),
      (select i.last_row from ads_with_changed_utms_grouped i where i.match_key = t1.match_key),
      if((select i.last_row from ads_with_changed_utms_grouped i where i.date = t1.date and i.ad_id = t1.ad_id) is null, max(row_number) over(partition by date, ad_id), null)
    ) last_row,
    * except(row_number, inserted_at, timezone, landing_page_url, url_params, cost, currency, impressions, reach, clicks, click_delay) 
  from ordered_match_keys t1
),

-- Схлопываем выбранные строки-источники в уникальные группы по match_key
-- и выбранным полям объявления.
latest_matched_rows_grouped as (
  select * from latest_matched_rows
  where last_row is not null
  group by match_key, date, ad_account_id, source, medium, campaign, content, term, strimix_refid, last_row, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, ad_destination
),

-- Подставляем в расходы актуальные UTM: метки берём из сгруппированной
-- строки (после смены UTM), а cost/impressions и landing — из выбранной
-- выгрузки с номером last_row.
rows_with_actual_utms as (
  select
    b.row_number,
    b.match_key,
    c.date, 
    c.source, 
    c.medium, 
    c.campaign, 
    c.content, 
    c.term, 
    c.strimix_refid, 
    b.landing_page_url, 
    cast(null as string) landing_hostname,
    cast(null as string) landing_page_path,
    b.cost, 
    b.currency, 
    b.impressions, 
    b.reach, 
    b.clicks, 
    b.click_delay, 
    'FACEBOOK_ADS' data_source,
    c.ad_destination,
    c.campaign_id,
    c.campaign_name,
    c.adset_id,
    c.adset_name,
    c.ad_id,
    c.ad_name
  from latest_matched_rows_grouped c
  inner join ordered_match_keys b
  on b.row_number = c.last_row
  and b.match_key = c.match_key
), 

-- Дополняем расходы актуальными url_params из исходной выгрузки
-- (join по row_number и match_key).
ad_costs as (
  select 
    d.date,
    'Facebook Ads' ad_platform,
    d.source,
    d.medium,
    d.campaign,
    d.content,
    d.term,
    d.strimix_refid,
    d.landing_page_url,
    d.landing_hostname,
    d.landing_page_path,
    b.url_params,
    d.cost,
    d.currency,
    d.impressions,
    d.reach,
    d.clicks,
    d.click_delay,
    d.data_source,
    ifnull(nullif(trim(d.ad_destination), ''), 'unknown') as ad_destination,
    d.campaign_id,
    d.campaign_name,
    d.adset_id adgroup_id,
    d.adset_name adgroup_name,
    d.ad_id,
    d.ad_name
  from rows_with_actual_utms d
  left join ordered_match_keys b
  on b.row_number = d.row_number
  and b.match_key = d.match_key
)

select * from ad_costs

) as s
on false
-- WHEN NOT MATCHED BY TARGET: каждая строка источника вставляется в ad_costs.
-- Колонки классификации traffic_origin/traffic_channel/landing_page на этом
-- этапе остаются пустыми — их заполнит этап атрибуции (5/5).
when not matched by target then insert (
  date,
  ad_platform,
  source,
  medium,
  campaign,
  content,
  term,
  strimix_refid,
  landing_page_url, 
  landing_hostname, 
  landing_page_path,
  url_params,
  cost,
  currency,
  impressions,
  reach,
  clicks,
  click_delay,
  data_source,
  ad_destination,
  campaign_id,
  campaign_name,
  adgroup_id,
  adgroup_name,
  ad_id,
  ad_name
) values (
  s.date,
  s.ad_platform,
  s.source,
  s.medium,
  s.campaign,
  s.content,
  s.term,
  s.strimix_refid,
  s.landing_page_url,
  s.landing_hostname,
  s.landing_page_path,
  s.url_params,
  s.cost,
  s.currency,
  s.impressions,
  s.reach,
  s.clicks,
  s.click_delay,
  s.data_source,
  s.ad_destination,
  s.campaign_id,
  s.campaign_name,
  s.adgroup_id,
  s.adgroup_name,
  s.ad_id,
  s.ad_name
)
-- WHEN NOT MATCHED BY SOURCE: каждую старую строку этой сети (FACEBOOK_ADS)
-- удаляем из ad_costs; строки других сетей условие не затрагивает.
when not matched by source and t.data_source = 'FACEBOOK_ADS' then delete""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

end;

end;

-- ============================================================
-- ЭТАП 2/5: РАСХОДЫ GOOGLE ADS
-- ============================================================

begin

declare _project_name string default '@GCP_PROJECT_NAME';
declare _dataset_name string default '@GPC_BQ_DATASET_NAME';

-- Загружаем расходы Google Ads в ad_costs.
begin

declare query string;
declare query_template string;

-- Атомарно заменяем все строки Google Ads в таблице ad_costs одним MERGE.
-- Зачем: отчёт, запущенный во время прогона, видит либо полностью старый,
-- либо полностью новый набор строк этой сети. Окна «строки уже удалены,
-- а новые ещё не вставлены» (как при прежнем DELETE+INSERT) больше нет.
-- Как устроен MERGE: условие соединения ON FALSE делает каждую строку
-- источника «не совпавшей с целью», поэтому она вставляется в ad_costs;
-- и каждую строку цели «не совпавшей с источником», поэтому строки этой
-- сети удаляются, а строки других сетей условие не затрагивает.
-- В BigQuery такой MERGE выполняется атомарно.
set query_template = """
merge `<project_name>.<dataset_name>.ad_costs` as t
using (

with 
-- Собираем ключ сопоставления из даты, рекламного аккаунта, всех UTM, ad_id
-- и ключевого слова (специфика Google: зерно расходов — ad_id × keyword).
-- По этому ключу ниже отслеживаем, сменились ли UTM между выгрузками.
source_match_keys as (
  select
    concat(cast(date as string),
    ad_account_id,
    ifnull(trim(source), '_'),
    ifnull(trim(medium), '_'),
    ifnull(trim(campaign), '_'),
    ifnull(trim(content), '_'), 
    ifnull(trim(term), '_'),
    ifnull(trim(strimix_refid), '_'),
    ad_id,
    ifnull(trim(keyword), '_')) match_key,
    *
  from `<project_name>.<dataset_name>.google_ads_ad_costs`
), 

-- Нумеруем строки каждой пары «объявление × ключевое слово» за день в
-- порядке выгрузки (inserted_at), чтобы дальше выбрать нужную версию
-- строки как источник метрик.
ordered_match_keys as (
  select row_number() over (partition by ad_id, keyword, date order by inserted_at asc) row_number, * from source_match_keys
), 

-- Находим объявления, у которых UTM сменились между выгрузками.
-- Нужно, чтобы не задваивать расходы: если объявление сначала выгрузилось
-- с UTM A, а потом пользователь сменил UTM на B, расход должен остаться
-- один раз (привязанным к актуальной метке).
find_ads_with_changed_utms as (
  select
    case when
      lead(match_key) over(partition by ad_id, keyword, date order by inserted_at asc) != match_key
      then row_number
      else null end primary_utm_row_number,
    match_key,
    ad_id,
    keyword,
    date
  from ordered_match_keys
),

ads_with_changed_utms as (
  select * from find_ads_with_changed_utms
  where primary_utm_row_number is not null
),

-- Для объявлений со сменившимися UTM определяем номер строки, из которой
-- ниже брать метрики (cost/impressions/...), чтобы подтянуть их к актуальным UTM.
ads_with_changed_utms_filtered as (
  select 
    first_value(primary_utm_row_number) over(partition by ad_id, keyword, date order by primary_utm_row_number asc) last_row,
    date,
    ad_id,
    keyword,
    first_value(match_key) over(partition by ad_id, keyword, date order by primary_utm_row_number asc) match_key
  from ads_with_changed_utms
),

ads_with_changed_utms_grouped as (
  select * from ads_with_changed_utms_filtered
  group by last_row, date, ad_id, keyword, match_key
),

latest_matched_rows as (
  select 
    if(
      match_key in (select i.match_key from ads_with_changed_utms_grouped i where i.match_key = t1.match_key),
      (select i.last_row from ads_with_changed_utms_grouped i where i.match_key = t1.match_key),
      if((select i.last_row from ads_with_changed_utms_grouped i where i.date = t1.date and i.ad_id = t1.ad_id and i.keyword = t1.keyword) is null, max(row_number) over(partition by date, ad_id, keyword), null)
    ) last_row,
    * except(row_number, inserted_at, timezone, landing_page_url, url_params, cost, currency, impressions, reach, clicks, click_delay) 
  from ordered_match_keys t1
),

-- Схлопываем выбранные строки-источники в уникальные группы по match_key
-- и размерным полям объявления.
latest_matched_rows_grouped as (
  select * from latest_matched_rows
  where last_row is not null
  group by match_key, date, ad_account_id, source, medium, campaign, content, term, strimix_refid, last_row, campaign_id, campaign_name, adgroup_id, adgroup_name, ad_id, ad_name, keyword, ad_destination
),

-- Подставляем в расходы актуальные UTM: метки берём из сгруппированной
-- строки (после смены UTM), а cost/impressions и landing — из размерной
-- выгрузки с номером last_row.
rows_with_actual_utms as (
  select
    b.row_number,
    b.match_key,
    c.date, 
    c.source, 
    c.medium, 
    c.campaign, 
    c.content, 
    c.term, 
    c.strimix_refid, 
    b.landing_page_url, 
    cast(null as string) landing_hostname,
    cast(null as string) landing_page_path,
    b.cost, 
    b.currency, 
    b.impressions, 
    b.reach, 
    b.clicks, 
    b.click_delay, 
    'GOOGLE_ADS' data_source,
    c.ad_destination,
    c.campaign_id,
    c.campaign_name,
    c.adgroup_id,
    c.adgroup_name,
    c.ad_id,
    c.ad_name,
  from latest_matched_rows_grouped c
  inner join ordered_match_keys b
  on b.row_number = c.last_row
  and b.match_key = c.match_key
), 

-- Дополняем расходы актуальными url_params из исходной выгрузки
-- (join по row_number и match_key).
ad_costs as (
  select 
    d.date,
    'Google Ads' ad_platform,
    d.source,
    d.medium,
    d.campaign,
    d.content,
    d.term,
    d.strimix_refid,
    d.landing_page_url,
    d.landing_hostname,
    d.landing_page_path,
    b.url_params,
    d.cost,
    d.currency,
    d.impressions,
    d.reach,
    d.clicks,
    d.click_delay,
    d.data_source,
    ifnull(nullif(trim(d.ad_destination), ''), 'unknown') as ad_destination,
    d.campaign_id,
    d.campaign_name,
    d.adgroup_id,
    d.adgroup_name,
    d.ad_id,
    d.ad_name
  from rows_with_actual_utms d
  left join ordered_match_keys b
  on b.row_number = d.row_number
  and b.match_key = d.match_key
)

select * from ad_costs

) as s
on false
-- WHEN NOT MATCHED BY TARGET: каждая строка источника вставляется в ad_costs.
-- Колонки классификации traffic_origin/traffic_channel/landing_page на этом
-- этапе остаются пустыми — их заполнит этап атрибуции (5/5).
when not matched by target then insert (
  date,
  ad_platform,
  source,
  medium,
  campaign,
  content,
  term,
  strimix_refid,
  landing_page_url, 
  landing_hostname, 
  landing_page_path,
  url_params,
  cost,
  currency,
  impressions,
  reach,
  clicks,
  click_delay,
  data_source,
  ad_destination,
  campaign_id,
  campaign_name,
  adgroup_id,
  adgroup_name,
  ad_id,
  ad_name
) values (
  s.date,
  s.ad_platform,
  s.source,
  s.medium,
  s.campaign,
  s.content,
  s.term,
  s.strimix_refid,
  s.landing_page_url,
  s.landing_hostname,
  s.landing_page_path,
  s.url_params,
  s.cost,
  s.currency,
  s.impressions,
  s.reach,
  s.clicks,
  s.click_delay,
  s.data_source,
  s.ad_destination,
  s.campaign_id,
  s.campaign_name,
  s.adgroup_id,
  s.adgroup_name,
  s.ad_id,
  s.ad_name
)
-- WHEN NOT MATCHED BY SOURCE: каждую старую строку этой сети (GOOGLE_ADS)
-- удаляем из ad_costs; строки других сетей условие не затрагивает.
when not matched by source and t.data_source = 'GOOGLE_ADS' then delete""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

end;

end;

-- ============================================================
-- ЭТАП 3/5: РАСХОДЫ TIKTOK ADS
-- ============================================================

begin

declare _project_name string default '@GCP_PROJECT_NAME';
declare _dataset_name string default '@GPC_BQ_DATASET_NAME';

-- Загружаем расходы TikTok Ads в ad_costs.
begin

declare query string;
declare query_template string;

-- Атомарно заменяем все строки TikTok Ads в таблице ad_costs одним MERGE.
-- Зачем: отчёт, запущенный во время прогона, видит либо полностью старый,
-- либо полностью новый набор строк этой сети. Окна «строки уже удалены,
-- а новые ещё не вставлены» (как при прежнем DELETE+INSERT) больше нет.
-- Как устроен MERGE: условие соединения ON FALSE делает каждую строку
-- источника «не совпавшей с целью», поэтому она вставляется в ad_costs;
-- и каждую строку цели «не совпавшей с источником», поэтому строки этой
-- сети удаляются, а строки других сетей условие не затрагивает.
-- В BigQuery такой MERGE выполняется атомарно.
set query_template = """
merge `<project_name>.<dataset_name>.ad_costs` as t
using (

with 
-- Собираем ключ сопоставления из даты, рекламного аккаунта, всех UTM и ad_id.
-- По этому ключу ниже отслеживаем, сменились ли UTM объявления между выгрузками.
source_match_keys as (
  select
    concat(cast(date as string),
    ad_account_id,
    ifnull(trim(source), '_'),
    ifnull(trim(medium), '_'),
    ifnull(trim(campaign), '_'),
    ifnull(trim(content), '_'),
    ifnull(trim(term), '_'),
    ifnull(trim(strimix_refid), '_')
    , ad_id) match_key,
    *
  from `<project_name>.<dataset_name>.tiktok_ads_ad_costs`
), 

-- Нумеруем строки каждого объявления за день в порядке выгрузки (inserted_at),
-- чтобы дальше выбрать нужную версию строки как источник метрик.
ordered_match_keys as (
  select row_number() over (partition by ad_id, date order by inserted_at asc) row_number, * from source_match_keys
), 

-- Находим объявления, у которых UTM сменились между выгрузками.
-- Нужно, чтобы не задваивать расходы: если объявление сначала выгрузилось
-- с UTM A, а потом пользователь сменил UTM на B, расход должен остаться
-- один раз (привязанным к актуальной метке).
find_ads_with_changed_utms as (
  select
    case when
      lead(match_key) over(partition by ad_id, date order by inserted_at asc) != match_key
      then row_number
      else null end primary_utm_row_number,
    match_key,
    ad_id,
    date
  from ordered_match_keys
),

ads_with_changed_utms as (
  select * from find_ads_with_changed_utms
  where primary_utm_row_number is not null
),

-- Для объявлений со сменившимися UTM определяем номер строки, из которой
-- ниже брать метрики (cost/impressions/...), чтобы подтянуть их к актуальным UTM.
ads_with_changed_utms_filtered as (
  select 
    first_value(primary_utm_row_number) over(partition by ad_id, date order by primary_utm_row_number asc) last_row,
    date,
    ad_id,
    first_value(match_key) over(partition by ad_id, date order by primary_utm_row_number asc) match_key
  from ads_with_changed_utms
),

ads_with_changed_utms_grouped as (
  select * from ads_with_changed_utms_filtered
  group by last_row, date, ad_id, match_key
),

latest_matched_rows as (
  select 
    if(
      match_key in (select i.match_key from ads_with_changed_utms_grouped i where i.match_key = t1.match_key),
      (select i.last_row from ads_with_changed_utms_grouped i where i.match_key = t1.match_key),
      if((select i.last_row from ads_with_changed_utms_grouped i where i.date = t1.date and i.ad_id = t1.ad_id) is null, max(row_number) over(partition by date, ad_id), null)
    ) last_row,
    * except(row_number, inserted_at, timezone, landing_page_url, url_params, cost, currency, impressions, reach, clicks, click_delay) 
  from ordered_match_keys t1
),

-- Схлопываем размерные строки-источники в уникальные группы по match_key
-- и размерным полям объявления.
latest_matched_rows_grouped as (
  select * from latest_matched_rows
  where last_row is not null
  group by match_key, date, ad_account_id, source, medium, campaign, content, term, strimix_refid, last_row, campaign_id, campaign_name, adgroup_id, adgroup_name, ad_id, ad_name, ad_destination
),

-- Подставляем в расходы актуальные UTM: метки берём из сгруппированной
-- строки (после смены UTM), а cost/impressions и landing — из размерной
-- выгрузки с номером last_row.
rows_with_actual_utms as (
  select
    b.row_number,
    b.match_key,
    c.date, 
    c.source, 
    c.medium, 
    c.campaign, 
    c.content, 
    c.term, 
    c.strimix_refid, 
    b.landing_page_url, 
    cast(null as string) landing_hostname,
    cast(null as string) landing_page_path,
    b.cost, 
    b.currency, 
    b.impressions, 
    b.reach, 
    b.clicks, 
    b.click_delay, 
    'TIKTOK_ADS' data_source,
    c.ad_destination,
    c.campaign_id,
    c.campaign_name,
    c.adgroup_id,
    c.adgroup_name,
    c.ad_id,
    c.ad_name,
  from latest_matched_rows_grouped c
  inner join ordered_match_keys b
  on b.row_number = c.last_row
  and b.match_key = c.match_key
), 

-- Дополняем расходы актуальными url_params из исходной выгрузки
-- (join по row_number и match_key).
ad_costs as (
  select 
    d.date,
    'TikTok Ads' ad_platform,
    d.source,
    d.medium,
    d.campaign,
    d.content,
    d.term,
    d.strimix_refid,
    d.landing_page_url,
    d.landing_hostname,
    d.landing_page_path,
    b.url_params,
    d.cost,
    d.currency,
    d.impressions,
    d.reach,
    d.clicks,
    d.click_delay,
    d.data_source,
    ifnull(nullif(trim(d.ad_destination), ''), 'unknown') as ad_destination,
    d.campaign_id,
    d.campaign_name,
    d.adgroup_id,
    d.adgroup_name,
    d.ad_id,
    d.ad_name
  from rows_with_actual_utms d
  left join ordered_match_keys b
  on b.row_number = d.row_number
  and b.match_key = d.match_key
)

select * from ad_costs

) as s
on false
-- WHEN NOT MATCHED BY TARGET: каждая строка источника вставляется в ad_costs.
-- Колонки классификации traffic_origin/traffic_channel/landing_page на этом
-- этапе остаются пустыми — их заполнит этап атрибуции (5/5).
when not matched by target then insert (
  date,
  ad_platform,
  source,
  medium,
  campaign,
  content,
  term,
  strimix_refid,
  landing_page_url, 
  landing_hostname, 
  landing_page_path,
  url_params,
  cost,
  currency,
  impressions,
  reach,
  clicks,
  click_delay,
  data_source,
  ad_destination,
  campaign_id,
  campaign_name,
  adgroup_id,
  adgroup_name,
  ad_id,
  ad_name
) values (
  s.date,
  s.ad_platform,
  s.source,
  s.medium,
  s.campaign,
  s.content,
  s.term,
  s.strimix_refid,
  s.landing_page_url,
  s.landing_hostname,
  s.landing_page_path,
  s.url_params,
  s.cost,
  s.currency,
  s.impressions,
  s.reach,
  s.clicks,
  s.click_delay,
  s.data_source,
  s.ad_destination,
  s.campaign_id,
  s.campaign_name,
  s.adgroup_id,
  s.adgroup_name,
  s.ad_id,
  s.ad_name
)
-- WHEN NOT MATCHED BY SOURCE: каждую старую строку этой сети (TIKTOK_ADS)
-- удаляем из ad_costs; строки других сетей условие не затрагивает.
when not matched by source and t.data_source = 'TIKTOK_ADS' then delete""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

end;

end;

-- ============================================================
-- ЭТАП 4/5: РУЧНЫЕ РАСХОДЫ (GOOGLE SHEETS)
-- ============================================================

begin

declare _project_name string default '@GCP_PROJECT_NAME';
declare _dataset_name string default '@GPC_BQ_DATASET_NAME';
declare _manual_source_exists bool default false;

-- Таблица ручных расходов additional_ad_costs_gs (внешняя таблица поверх
-- Google Sheets) подключается клиенту индивидуально и существует не во всех
-- проектах. Проверяем её наличие через INFORMATION_SCHEMA и пропускаем этап,
-- если таблицы нет: иначе единая джоба падала бы у проектов без ручных
-- расходов. Проверка динамическая (execute immediate), чтобы отсутствие
-- таблицы не ломало компиляцию самого скрипта.
execute immediate format(
  "select count(*) > 0 from `%s.%s.INFORMATION_SCHEMA.TABLES` where table_name = 'additional_ad_costs_gs'",
  _project_name, _dataset_name
) into _manual_source_exists;

if _manual_source_exists then

-- Загружаем ручные расходы из Google Sheets в ad_costs.
begin

declare query string;
declare query_template string;

-- Атомарно заменяем все строки ручных расходов в таблице ad_costs одним MERGE.
-- Зачем: отчёт, запущенный во время прогона, видит либо полностью старый,
-- либо полностью новый набор строк этого источника. Окна «строки уже
-- удалены, а новые ещё не вставлены» (как при прежнем DELETE+INSERT)
-- больше нет.
-- Как устроен MERGE: условие соединения ON FALSE делает каждую строку
-- источника «не совпавшей с целью», поэтому она вставляется в ad_costs;
-- и каждую строку цели «не совпавшей с источником», поэтому строки этого
-- источника удаляются, а строки других источников условие не затрагивает.
-- В BigQuery такой MERGE выполняется атомарно.
-- У ручных расходов нет сетевых полей (названий/id) и лендинга, поэтому
-- ad_destination не заполняется: правила проекции названий на них не
-- распространяются, метки задаёт пользователь прямо в таблице.
set query_template = """
merge `<project_name>.<dataset_name>.ad_costs` as t
using (
  select
    date,
    'Manual' ad_platform,
    source,
    medium,
    campaign,
    content,
    term,
    strimix_refid,
    round(cost,2) cost,
    currency,
    impressions,
    reach,
    clicks,
    click_delay,
    'GOOGLE_SHEETS' data_source
  from `<project_name>.<dataset_name>.additional_ad_costs_gs`
  where date is not null
) as s
on false
-- WHEN NOT MATCHED BY TARGET: каждая строка источника вставляется в ad_costs.
-- Колонки классификации traffic_origin/traffic_channel на этом этапе
-- остаются пустыми — их заполнит этап атрибуции (5/5).
when not matched by target then insert (
  date,
  ad_platform,
  source,
  medium,
  campaign,
  content,
  term,
  strimix_refid,
  cost,
  currency,
  impressions,
  reach,
  clicks,
  click_delay,
  data_source
) values (
  s.date,
  s.ad_platform,
  s.source,
  s.medium,
  s.campaign,
  s.content,
  s.term,
  s.strimix_refid,
  s.cost,
  s.currency,
  s.impressions,
  s.reach,
  s.clicks,
  s.click_delay,
  s.data_source
)
-- WHEN NOT MATCHED BY SOURCE: каждую старую строку этого источника
-- (GOOGLE_SHEETS) удаляем из ad_costs; строки других источников условие
-- не затрагивает.
when not matched by source and t.data_source = 'GOOGLE_SHEETS' then delete""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

end;

end if;

end;

-- ============================================================
-- ЭТАП 5/5: АТРИБУЦИЯ И КЛАССИФИКАЦИЯ ТРАФИКА
-- ============================================================

begin

declare _project_name string default '@GCP_PROJECT_NAME';
declare _dataset_name string default '@GPC_BQ_DATASET_NAME';
declare _project_timezone string default '"@PROJECT_TIMEZONE"';

-- Декодирует значение query-параметра так же, как трекер на сайте
-- (URLSearchParams / form-encoding): сначала '+' заменяется на пробел,
-- затем декодируются процентные последовательности (литеральный плюс
-- приходит как '%2B'). Зачем: рекламные сети отдают метки в том же
-- формате, поэтому канонические метки визитов и url_params должны
-- совпадать с метками расходов побайтово — иначе визиты не сматчатся
-- с ad_costs.
create temporary function decode_uri_component(path string)
returns string
language js as """
if (path == null) return null;
try {
  return decodeURIComponent(path.replace(/\\+/g, ' '));
} catch (e) {
  return path;
}
""";

-- Подставляет плейсхолдеры в значение set_*-поля utm-правила (проекция
-- рекламной идентичности и копирование исходных канонических UTM-меток,
-- разделы 3.2 и 6 ТЗ). Пример: set_campaign='{campaign_name}' разворачивается
-- в реальное название кампании: на строке расходов — её собственное, на
-- синтетическом визите — однозначное значение зарезолвленной группы
-- (неоднозначное вызывающий код срезает в null; маркер '(combined)' сюда
-- не попадает). {source}/{medium}/{campaign}/{content}/{term} подставляют
-- входящие канонические метки той же строки, которую правило переписывает
-- (визит: v.*; ad_costs: t.*). Техника — цепочка replace: сначала семь
-- рекламных плейсхолдеров, затем пять UTM; отсутствующее значение (null)
-- становится пустой строкой, а полностью пустой результат нормализуется
-- в null, потому что пустых строк в метках не бывает.
create temporary function apply_placeholders(
  v string,
  ph_data_source string,
  ph_campaign_id string,
  ph_campaign_name string,
  ph_adgroup_id string,
  ph_adgroup_name string,
  ph_ad_id string,
  ph_ad_name string,
  ph_source string,
  ph_medium string,
  ph_campaign string,
  ph_content string,
  ph_term string
)
as (
  nullif(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(v,
    '{data_source}',   ifnull(ph_data_source, '')),
    '{campaign_id}',   ifnull(ph_campaign_id, '')),
    '{campaign_name}', ifnull(ph_campaign_name, '')),
    '{adgroup_id}',    ifnull(ph_adgroup_id, '')),
    '{adgroup_name}',  ifnull(ph_adgroup_name, '')),
    '{ad_id}',         ifnull(ph_ad_id, '')),
    '{ad_name}',       ifnull(ph_ad_name, '')),
    '{source}',        ifnull(ph_source, '')),
    '{medium}',        ifnull(ph_medium, '')),
    '{campaign}',      ifnull(ph_campaign, '')),
    '{content}',       ifnull(ph_content, '')),
    '{term}',          ifnull(ph_term, '')), '')
);

-- Возвращает true, если в значении set_*-поля есть хотя бы один плейсхолдер
-- вида {campaign_name}. Нужна, чтобы отличить правило проекции от правила
-- перевода: для проекции действует защита «всё или ничего» (правило
-- срабатывает на строку/визит, только если все пять канонических меток
-- пусты).
create temporary function has_placeholders(v string)
as (
  v is not null
  and regexp_contains(v, '[{](data_source|campaign_id|campaign_name|adgroup_id|adgroup_name|ad_id|ad_name)[}]')
);

------------------------------------------
--------- 1. СПИСОК IP-АДРЕСОВ БОТОВ ------
------------------------------------------
-- Бизнес-смысл: боты (краулеры Facebook, Google и т.п.) генерируют события,
-- которые раздували бы визиты и конверсию сайта. Здесь собираем список их
-- IP в temp-таблицу bot_ip, чтобы на шаге 2 исключить события ботов из
-- всего пайплайна. Техника: IP событий проекта сравниваем с общим
-- справочником ботовых сетей (bi-200.service_eu.web_bots_list) по первым
-- трём октетам (подсеть).

begin

declare query string;
declare query_template string;

set query_template = """
create temp table `bot_ip` as(
  select distinct(device_info.ip) ip
  from `<project_name>.<dataset_name>.identified_events`
  where
  -- Берём IP события в bot_ip, если его подсеть (первые три октета) есть
  -- в справочнике web_bots_list.
  regexp_extract(device_info.ip, r'^(\\\\d+\\\\.\\\\d+\\\\.\\\\d+)') in 
    (select distinct(regexp_extract(ip, r'^(\\\\d+\\\\.\\\\d+\\\\.\\\\d+)')) from `bi-200.service_eu.web_bots_list`
    where bot like '%facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)%'
    or bot like '%Googlebot%'
    /*or bot like '%YandexBot%' - временно отключено: список IP этого бота требует чистки*/
    or bot like '%Applebot%')
)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

end;

------------------------------------------------
------ 1.5 СКЛЕЙКА ОБЪЕДИНЁННЫХ ПРОФИЛЕЙ -------
------------------------------------------------
-- Бизнес-смысл: один человек может быть представлен несколькими профилями
-- (зашёл с телефона и с ноутбука, потом идентифицировался). События склейки
-- профилей приходят из event-processing-service; здесь строим карту
-- «влитый (дочерний) профиль → канонический профиль», чтобы вся атрибуция
-- ниже работала с единым человеком, а не с осколками.

begin

declare query string;
declare query_template string;

-- Создаём таблицу событий склейки, если её ещё нет, чтобы скрипт не падал
-- на проектах, где event-processing-service её ещё не создал.
set query_template = """
create table if not exists `<project_name>.<dataset_name>.profile_merge_events`
(
  merge_job_id       string not null,
  parent_profile_id  string not null,
  merged_profile_id  string not null,
  merge_timestamp    int64  not null,
  date               date   not null,
  inserted_at        int64  not null
)
partition by date
cluster by merged_profile_id""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

-- Строим карту «влитый (дочерний) профиль → итоговый (канонический)».
-- Транзитивные цепочки склеек (a→b, b→c) рекурсивно сворачиваем в a→c;
-- ограничение depth < 50 защищает от циклов в данных.
set query_template = """
create temp table `profile_id_mapping` as (
with recursive
edges as (
  select
    merged_profile_id,
    parent_profile_id,
    merge_timestamp
  from `<project_name>.<dataset_name>.profile_merge_events`
  where merged_profile_id != parent_profile_id
  -- При ретраях outbox оставляем одну актуальную запись на влитый профиль
  -- (самую свежую по merge_timestamp).
  qualify row_number() over (
    partition by merged_profile_id
    order by merge_timestamp desc, merge_job_id desc
  ) = 1
),

resolved as (
  select
    merged_profile_id,
    parent_profile_id as canonical_profile_id,
    1 as depth
  from edges

  union all

  select
    r.merged_profile_id,
    e.parent_profile_id as canonical_profile_id,
    r.depth + 1 as depth
  from resolved as r
  inner join edges as e
    on e.merged_profile_id = r.canonical_profile_id
  where r.depth < 50
)

select
  merged_profile_id,
  canonical_profile_id
from resolved
qualify row_number() over (
  partition by merged_profile_id
  order by depth desc
) = 1
)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

end;

-------------------------------------------------------------------------------
---- 2. ДЕДУПЛИКАЦИЯ СОБЫТИЙ И ПЕРЕИДЕНТИФИКАЦИЯ ПРОФИЛЕЙ НА УРОВНЕ ВИЗИТА ----
-------------------------------------------------------------------------------
-- Бизнес-смысл: готовим чистый поток событий — без дублей, без ботов,
-- с единым профилем человека. Всё, что дальше (визиты, синтетика,
-- атрибуция), строится поверх этой временной таблицы `identified_events`.

begin

declare query string;
declare query_template string;

set query_template = """
create temp table `identified_events` as(
-- Применяем склейки профилей до всего остального пайплайна: подменяем
-- profile_id события на канонический (если профиль был влит в другой).
-- Все оконные функции ниже (переидентификация сессий, визиты, атрибуция)
-- секционируются по profile_id и должны видеть уже единого человека.
with merge_resolved_events as (
  select
    e.* replace (coalesce(m.canonical_profile_id, e.profile_id) as profile_id)
  from `<project_name>.<dataset_name>.identified_events` as e
  left join `profile_id_mapping` as m
    on e.profile_id = m.merged_profile_id
),

delete_duplicated_events as (
  select * except(row_number)
  from (
    select
      -- Детерминированная дедупликация: для каждого event_id оставляем
      -- последнюю вставленную строку (ретраи доставки дают дубли).
      *, row_number() over (partition by event_id order by inserted_at desc) as row_number
    from merge_resolved_events
  )
  where row_number = 1
  -- Отбрасываем события ботов по User Agent.
  and (
    (device_info.web_info.user_agent not like '%facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)%'
    and device_info.web_info.user_agent not like '%Googlebot%'
    and device_info.web_info.user_agent not like '%YandexBot%'
    and device_info.web_info.user_agent not like '%Applebot%')
    or device_info.web_info.user_agent is null)
  -- Отбрасываем события ботов по IP (список из шага 1, temp-таблица bot_ip).
  and (device_info.ip is null or device_info.ip not in (select * from bot_ip))
),

-- Переидентифицируем события на уровне сессии браузера: все события с одним
-- strimix_avid должны принадлежать одному профилю. Берём profile_id
-- последнего события сессии и ниже растянем его на всю сессию.
detect_latest_session_profile_id as (
  select
    -- Если cookie сессии (strimix_avid) есть — ищем profile_id последнего
    -- события этой сессии; иначе оставляем исходный profile_id.
    if(strimix_avid is not null,
      -- Разрыв > 45 минут до следующего события: текущий profile_id —
      -- последний в сессии.
      case when lead(timestamp) over(partition by strimix_avid order by timestamp asc) - timestamp > 2700000 then profile_id
      -- Событие последнее в партиции strimix_avid: оно же закрывает сессию.
      else case when lead(event_id) over(partition by strimix_avid order by timestamp asc) is null then profile_id
      -- Следующее событие ещё есть: решение о «последнем» профиле примет оно.
      else null end end
    , profile_id) latest_session_profile_id,
    *
  from delete_duplicated_events
),

-- Перезаписываем profile_id каждого события найденным профилем сессии.
raw_events_with_overridden_profile_id as (
  select
    -- Если strimix_avid есть — ставим profile_id последнего события сессии
    -- на все события этой партиции; иначе оставляем исходный profile_id.
    if(strimix_avid is not null,
      first_value(latest_session_profile_id ignore nulls) over(partition by strimix_avid order by timestamp asc rows between current row and unbounded following)
    , profile_id) profile_id,
    * except(profile_id, latest_session_profile_id)
  from detect_latest_session_profile_id
)

select * from raw_events_with_overridden_profile_id)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

end;

--------------------------------------------------------------------------
---------- 2.5 КОНФИГ-ТАБЛИЦЫ КЛАССИФИКАЦИИ ТРАФИКА ------------------------
--------------------------------------------------------------------------
-- Бизнес-смысл: вся логика классификации и перезаписи меток настраивается
-- данными, а не кодом: клиент через CRUD правит правила под себя. Здесь
-- джоба лишь гарантирует, что три конфиг-таблицы существуют (для проектов,
-- задеплоенных до этой фичи) и содержат все актуальные колонки. Джоба
-- НИКОГДА не вставляет и не восстанавливает системные правила: сид делается
-- один раз при деплое проекта (buildTrafficRulesSeedQuery /
-- buildExcludedUrlParamsSeedQuery в cloud-management-service), после чего
-- клиент волен править и удалять любые правила, включая системные.

begin

declare query string;
declare query_template string;

-- Таблица правил классификации трафика. Три стадии обрабатывают строку так:
--  'utm'     — переписывает канонические метки (source, medium, campaign,
--              content, term, strimix_refid) у синтетических визитов и строк
--              расходов; при applies_to_web=true то же применяется и к
--              веб-визитам (UTM-алиасы). Каждое set_*-поле берётся из
--              первого по priority совпавшего правила, которое его задало.
--  'origin'  — вычисляет traffic_origin (конкретный источник, например
--              "Meta Ads"); побеждает первое совпавшее правило целиком.
--  'channel' — вычисляет traffic_channel (категория, например "Paid Social");
--              может опираться на уже вычисленный traffic_origin.
-- Все непустые условия правила соединяются через AND. Regex-условия
-- оцениваются С УЧЁТОМ регистра (как написано в правиле); регистро-
-- независимость включается только флагом (?i) внутри самого regex,
-- например '(?i)^(facebook|fb)$'.
-- Рекламные условия (data_source_regex, ad_destination_regex, сетевые
-- названия/id) на строках расходов проверяются по колонкам ad_costs,
-- а на синтетических визитах — по однозначному значению зарезолвленной
-- группы расходов.
set query_template = """
create table if not exists `<project_name>.<dataset_name>.traffic_rules`
(
  rule_id               string not null,
  priority              int64  not null,
  is_active             bool   not null,
  is_system             bool   not null,
  stage                 string not null, -- 'utm' | 'origin' | 'channel'
  target                string not null, -- 'visit' | 'ad_cost' | 'both'
  applies_to_web        bool,            -- только utm-стадия: применять правило и к веб-визитам (null = false)
  source_regex          string,
  medium_regex          string,
  campaign_regex        string,
  content_regex         string,
  term_regex            string,
  strimix_refid_regex   string,
  data_source_regex     string,
  campaign_id_regex     string,
  campaign_name_regex   string,
  adgroup_id_regex      string,
  adgroup_name_regex    string,
  ad_id_regex           string,
  ad_name_regex         string,
  ad_destination_regex  string,
  url_param_key         string,
  url_param_value_regex string,
  traffic_origin_regex  string,
  set_source            string,
  set_medium            string,
  set_campaign          string,
  set_content           string,
  set_term              string,
  set_strimix_refid     string,
  set_traffic_origin    string,
  set_traffic_channel   string,
  name                  string,  -- коротка підпис для UI, джоба не читає
  description           string   -- заметка оператора, джоба її не читає
)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

-- Догоняющая миграция схемы: добавляем колонки applies_to_web,
-- data_source_regex, name и description в проекты, где traffic_rules создали
-- до их появления. name и description — подписи для UI, расчёт их не читает.
set query_template = """
alter table `<project_name>.<dataset_name>.traffic_rules`
add column if not exists applies_to_web bool,
add column if not exists data_source_regex string,
add column if not exists name string,
add column if not exists description string""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

-- Таблица маппингов сигналов атрибуции: описывает, где у клиента лежат
-- сигналы для конверсий мимо сайта. Пример строки: источник сделки из CRM
-- лежит в order.custom_params под ключом 'deal_source'
-- (entity='order', param_source='custom_params', source_param_key='deal_source',
-- остальные ключи null, mode='fallback').
set query_template = """
create table if not exists `<project_name>.<dataset_name>.attribution_signal_mappings`
(
  mapping_id              string not null,
  priority                int64  not null,
  is_active               bool   not null,
  entity                  string not null, -- 'order' | 'deal' | 'event'
  param_source            string not null, -- 'custom_params' | 'event_params'
  -- Ключи контейнера, откуда читать каждую метку визита ('deal_source',
  -- 'source'...). Null значит «метку не извлекаем»; неявных дефолтов нет.
  source_param_key        string,
  medium_param_key        string,
  campaign_param_key      string,
  content_param_key       string,
  term_param_key          string,
  strimix_refid_param_key string,
  -- Ключи контейнера с рекламной идентичностью (id и/или сетевые названия).
  -- По ним джоба ищет совпадения в ad_costs: однозначные id, названия и
  -- ad_destination пишет в visits.attributed_ad, а все найденные строки
  -- расходов кладёт во временную зарезолвленную группу визита.
  campaign_id_param_key   string,
  campaign_name_param_key string,
  adgroup_id_param_key    string,
  adgroup_name_param_key  string,
  ad_id_param_key         string,
  ad_name_param_key       string,
  -- Фильтры срабатывания: применим ли маппинг к конкретному извлечённому
  -- сигналу. Проверяются после извлечения (для order/deal — на значениях
  -- актуального состояния сущности), непустые условия соединяются через
  -- AND, regex оцениваются с учётом регистра ((?i) вписывается в сам
  -- regex). Если фильтр задан, а значение не извлеклось, фильтр считается
  -- непройденным. Null значит «условия нет». Не прошедший фильтры маппинг
  -- не участвует в розыгрыше priority.
  match_source_regex        string,
  match_medium_regex        string,
  match_campaign_regex      string,
  match_content_regex       string,
  match_term_regex          string,
  match_strimix_refid_regex string,
  match_campaign_id_regex   string,
  match_campaign_name_regex string,
  match_adgroup_id_regex    string,
  match_adgroup_name_regex  string,
  match_ad_id_regex         string,
  match_ad_name_regex       string,
  -- Граница резолюции: рекламную идентичность ищем только среди строк
  -- расходов с подходящим ad_destination (regex без учёта регистра).
  -- Null значит «без границы».
  ad_destination_regex    string,
  -- Вторая граница резолюции: только строки расходов подходящей рекламной
  -- сети (regex по data_source без учёта регистра). Защищает поиск по
  -- названиям от кросс-сетевых тёзок. Null значит «все сети».
  data_source_regex       string,
  event_name              string,          -- опционально: только события с этим именем
  mode                    string not null, -- 'fallback' | 'override'
  name                    string,          -- коротка підпис для UI, джоба не читає
  description             string           -- заметка оператора, джоба её не читает
)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

-- Догоняющая миграция схемы: добавляем границы резолюции
-- (ad_destination_regex, data_source_regex), фильтры срабатывания
-- match_*_regex и name в проекты, где таблица маппингов создана до появления
-- этих полей.
set query_template = """
alter table `<project_name>.<dataset_name>.attribution_signal_mappings`
add column if not exists ad_destination_regex string,
add column if not exists data_source_regex string,
add column if not exists match_source_regex string,
add column if not exists match_medium_regex string,
add column if not exists match_campaign_regex string,
add column if not exists match_content_regex string,
add column if not exists match_term_regex string,
add column if not exists match_strimix_refid_regex string,
add column if not exists match_campaign_id_regex string,
add column if not exists match_campaign_name_regex string,
add column if not exists match_adgroup_id_regex string,
add column if not exists match_adgroup_name_regex string,
add column if not exists match_ad_id_regex string,
add column if not exists match_ad_name_regex string,
add column if not exists name string,
add column if not exists description string""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

-- Таблица исключаемых url-параметров: список regex-ов трекинговых
-- query-параметров (gclid, fbclid, utm_*...), которые вырезаются при
-- нормализации landing_page у визитов и расходов. param_key_regex матчится
-- без учёта регистра на весь ключ параметра (якорится как ^(?:regex)$),
-- поэтому одна строка может покрывать целое семейство параметров.
set query_template = """
create table if not exists `<project_name>.<dataset_name>.excluded_url_params`
(
  param_id        string not null,
  param_key_regex string not null,
  is_active       bool   not null,
  is_system       bool   not null,
  description     string
)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

end;

--------------------------------------------------------------------------
----------------------- 3. ТАБЛИЦА ПРОСМОТРОВ СТРАНИЦ ---------------------
--------------------------------------------------------------------------
-- Бизнес-смысл: каждый просмотр страницы разбираем на составляющие
-- атрибуции: адрес, реферер, канонические метки (source/medium/...) и
-- query-параметры. Из этих просмотров на шаге 4 собираются визиты.
-- Техника: page_location события парсим regex-ами на host/path/query,
-- метки берём из event_params, а query разворачиваем в массив url_params
-- с декодированием как у трекера (см. decode_uri_component).

begin

declare query string;
declare query_template string;

set query_template = """
create or replace table `<project_name>.<dataset_name>.page_views`
partition by date options (require_partition_filter = false) as(
-- Извлекаем из page_view-событий адрес страницы, реферер и канонические
-- метки (source/medium/...) из event_params.
with t1 as (
  select
    timestamp,
    profile_id,
    event_id,
    (select value.string_value from unnest(event_params) where key like 'page_location') as page_location,
    regexp_extract((select value.string_value from unnest(event_params) where key like 'page_location'), r'(?:[a-za-z]+://)?([a-za-z0-9-.]+)/?') as host,
    regexp_extract((select value.string_value from unnest(event_params) where key like 'page_location'), r'(?:[a-za-z]+://)?(?:[a-za-z0-9-.]+)/{1}([a-za-z0-9-./]+)') as path,
    regexp_extract((select value.string_value from unnest(event_params) where key like 'page_location'), r'\\?(.*)') as query,
    (select value.string_value from unnest(event_params) where key like 'page_referrer') as page_referrer,
    (select regexp_extract(value.string_value, r'(?:[a-za-z]+://)?([a-za-z0-9-.]+)/?') from unnest(event_params) where key like 'page_referrer') as page_referrer_host,
    trim((select value.string_value from unnest(event_params) where key like 'source')) as source,
    trim((select value.string_value from unnest(event_params) where key like 'medium')) as medium,
    trim((select value.string_value from unnest(event_params) where key like 'campaign')) as campaign,
    trim((select value.string_value from unnest(event_params) where key like 'content')) as content,
    trim((select value.string_value from unnest(event_params) where key like 'term')) as term,
    trim((select value.string_value from unnest(event_params) where key like 'strimix_refid')) as strimix_refid,
    device_info,
  from `identified_events` as t1
  where event_name like 'page_view'
),

-- Выводим source/medium по веб-конвенции: явная метка из URL важнее
-- реферера; внешний реферер без меток даёт органический переход
-- (source = хост реферера, medium = 'referral'); если нет ни меток, ни
-- реферера — ставим '(direct)' / '(none)'.
t2 as (
  select
    timestamp,
    profile_id,
    event_id,
    page_location,
    host,
    path,
    query,
    page_referrer,
    page_referrer_host,
    case 
      when source is not null then source
      else case 
        when page_referrer is not null 
        and page_referrer_host not like host 
        and page_referrer_host not in (select host from `<project_name>.<dataset_name>.excluded_referrers` where is_active = true and host is not null)
        and medium is null
        then if(regexp_contains(page_referrer, r'^android-app:\\/\\/'), page_referrer, page_referrer_host)
      else case when medium is not null then '(not set)'
      else '(direct)' end end end as source,
    case 
      when medium is not null then medium 
      else case 
        when page_referrer is not null 
        and page_referrer_host not like host 
        and page_referrer_host not in (select host from `<project_name>.<dataset_name>.excluded_referrers` where is_active = true and host is not null)
        and source is null
        then 'referral'
      else case when source is not null then '(not set)'
      else '(none)' end end end as medium,
    campaign,
    content,
    term,
    strimix_refid,
    split(query, '&') url_params,
    device_info,
  from t1
)

-- Финальная выборка page_views: дата в таймзоне проекта и разобранный
-- массив url_params (ключи и значения декодируем как в трекере, чтобы
-- они совпадали с каноническими метками и метками рекламных сетей побайтово).
select
  extract(date from timestamp_millis(timestamp) at time zone <project_timezone>) date,
  timestamp,
  profile_id,
  page_location,
  host,
  path,
  page_referrer,
  page_referrer_host,
  event_id as page_view_event_id,
  source,
  medium,
  campaign,
  content,
  term,
  strimix_refid,
  array(
      select as struct 
        decode_uri_component(regexp_extract(up, r'(.*)\\=')) as key,
        struct(decode_uri_component(regexp_extract(up, r'\\=(.*)')) as string_value) as value
      from unnest(t2.url_params) as up
  ) url_params,
  device_info,
from t2)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);
set query = replace(query, '<project_timezone>', _project_timezone);

execute immediate (query);

end;

--------------------------------------------------------------------------
------------------- 4. СБОРКА ВЕБ-ВИЗИТОВ (STAGING) -----------------------
--------------------------------------------------------------------------
-- Бизнес-смысл: события браузера нарезаем на визиты (сессии с точки зрения
-- атрибуции). Новый визит начинается с непрямого входа или после 45 минут
-- тишины. Каждый визит несёт канонические метки своего первого page_view —
-- это точка касания для атрибуции конверсий.
-- Техника и атомарность: визиты собираем во ВРЕМЕННУЮ таблицу
-- `visits_staging`, а не сразу в пользовательскую `visits`. Дальше в неё
-- добавится синтетика (шаг 4.2), затем стадии utm/origin/channel (шаг 4.3),
-- и только полностью готовый результат одним атомарным `create or replace`
-- заменит `visits`. Поэтому отчёт, запущенный во время прогона, никогда
-- не увидит пустую или полупустую таблицу.
-- Примечание: пилотный блок «PROCESS UTM ALIASES» (нормализация меток через
-- отдельную таблицу utm_aliases) удалён; его функцию полностью поглотили
-- utm-правила traffic_rules с флагом applies_to_web (шаг 4.3).

begin

declare query string;
declare query_template string;
declare excluded_url_param_patterns array<string>;

-- Читаем активные паттерны конфиг-таблицы excluded_url_params как МАССИВ:
-- эти трекинговые параметры затем вырезаются из нормализованного
-- landing_page. Паттерны не склеиваются в один regex и не инлайнятся в текст
-- запроса — ниже они передаются параметром через execute immediate ... using,
-- поэтому кавычки и обратные слэши сохраняют смысл, а inline-флаг одного
-- паттерна не меняет поведение соседнего. Пустой или пробельный паттерн
-- пропускаем: он не описывает ключ, но матчил бы пустое имя. Пустой массив
-- BigQuery связывает как NULL, unnest(NULL) не даёт строк — при отсутствии
-- активных исключений не вырезается ничего.
set query_template = """
select ifnull(array_agg(param_key_regex order by param_id), [])
from `<project_name>.<dataset_name>.excluded_url_params`
where is_active = true
and param_key_regex is not null
and trim(param_key_regex) != ''""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query) into excluded_url_param_patterns;

set query_template = """
-- Staging-таблица визитов: живёт до конца прогона; пользовательскую
-- таблицу visits атомарно заменит шаг 4.3.
create temp table `visits_staging` as (
-- Берём все события браузера (визиты строим только из веб-событий).
with browser_events as (
  select
    timestamp,
    event_id,
    profile_id,
  from `identified_events`
  where device_info.web_info.user_agent is not null
),

-- Присоединяем к событиям браузера атрибуцию из page_views (метки, url_params,
-- host/path): у page_view-событий поля заполнятся, у остальных останутся null.
browser_events_with_utms_attr as (
  select
    t1.timestamp,
    t1.event_id,
    t1.profile_id,
    t2.page_view_event_id,
    t2.source,
    t2.medium,
    t2.campaign,
    t2.content,
    t2.term,
    t2.strimix_refid,
    t2.url_params,
    t2.host,
    t2.path,
    t2.page_location,
    t2.page_referrer_host,
    t2.device_info,
  from browser_events as t1
  left join `<project_name>.<dataset_name>.page_views` as t2
  on t1.event_id = t2.page_view_event_id
),

-- Проставляем visit_id на событии, которое открывает новый визит;
-- остальные события получат его ниже через оконные функции.
browser_events_with_visit_id as (
  select
    timestamp,
    event_id,
    profile_id,
    page_view_event_id,
    -- Новый visit_id генерируем только на page_view-событии.
    case when page_view_event_id is not null then 
      -- Непрямой вход и реферер не с сайта клиента (не возврат по истории
      -- на страницу с UTM): открываем новый визит.
      case when source != '(direct)' and (page_referrer_host is null or page_referrer_host != host) then generate_uuid()
      else
        -- Тишина > 45 минут с прошлого события: открываем новый визит.
        case when timestamp - lag(timestamp) over(partition by profile_id order by timestamp asc) > 2700000 then generate_uuid()
        -- Это первое событие у profile_id: открываем новый визит.
        else case when lag(event_id) over(partition by profile_id order by timestamp asc) is null then generate_uuid()
        -- До этого у profile_id ещё не было page_view: открываем новый визит.
        else case when last_value(page_view_event_id ignore nulls) over(partition by profile_id order by timestamp rows between unbounded preceding and 1 preceding) is null then generate_uuid()
    end end end end end visit_id,
    source,
    medium,
    campaign,
    content,
    term,
    strimix_refid,
    url_params,
    host,
    path,
    page_location,
    page_referrer_host,
    -- last_hostname: host последнего page_view визита (только на page_view).
    case when page_view_event_id is not null then
      -- Тишина > 45 минут до следующего события: текущий page_view — последний.
      case when timestamp - lead(timestamp) over(partition by profile_id order by timestamp asc) > 2700000 then host
      -- Это последнее событие у profile_id: текущий page_view — последний.
      else case when lead(event_id) over(partition by profile_id order by timestamp asc) is null then host
      -- Дальше у profile_id больше нет page_view: текущий page_view — последний.
      else case when last_value(page_view_event_id ignore nulls) over(partition by profile_id order by timestamp rows between 1 following and unbounded following) is null then host
    end end end end last_hostname,
    -- last_page_path: path последнего page_view визита (те же условия закрытия).
    case when page_view_event_id is not null then
      case when timestamp - lead(timestamp) over(partition by profile_id order by timestamp asc) > 2700000 then path
      else case when lead(event_id) over(partition by profile_id order by timestamp asc) is null then path
      else case when last_value(page_view_event_id ignore nulls) over(partition by profile_id order by timestamp rows between 1 following and unbounded following) is null then path
    end end end end last_page_path,
    -- last_page_url: полный URL последнего page_view визита (те же условия).
    case when page_view_event_id is not null then
      case when timestamp - lead(timestamp) over(partition by profile_id order by timestamp asc) > 2700000 then page_location
      else case when lead(event_id) over(partition by profile_id order by timestamp asc) is null then page_location
      else case when last_value(page_view_event_id ignore nulls) over(partition by profile_id order by timestamp rows between 1 following and unbounded following) is null then page_location
    end end end end last_page_url,
    device_info,
  from browser_events_with_utms_attr
),

-- Оставляем только события-открытия визитов (visit_id is not null) и
-- дотягиваем каждому визиту host/path/URL последней просмотренной страницы
-- того же профиля.
browser_events_with_last_page_info as (
  select
    extract(date from timestamp_millis(t1.timestamp) at time zone <project_timezone>) date,
    t1.timestamp,
    t1.profile_id,
    t1.visit_id,
    if (t1.source not like '(direct)' and (t1.page_referrer_host is null or t1.page_referrer_host != t1.host), t1.visit_id, null) as non_direct_visit_id,
    if (t1.source not like '(direct)' and t1.medium not like 'referral' and (t1.page_referrer_host is null or t1.page_referrer_host != t1.host), t1.visit_id, null) as marked_visit_id,
    t1.event_id,
    t1.source,
    t1.medium,
    t1.campaign,
    t1.content,
    t1.term,
    t1.strimix_refid,
    t1.url_params,
    t1.host first_hostname,
    t1.path first_page_path,
    t1.page_location first_page_url,
    first_value(t2.last_hostname ignore nulls) over(partition by t2.profile_id order by t2.timestamp rows between current row and unbounded following) last_hostname,
    first_value(t2.last_page_path ignore nulls) over(partition by t2.profile_id order by t2.timestamp rows between current row and unbounded following) last_page_path,
    first_value(t2.last_page_url ignore nulls) over(partition by t2.profile_id order by t2.timestamp rows between current row and unbounded following) last_page_url,
    t1.device_info,
  from browser_events_with_visit_id t1
  left join browser_events_with_visit_id t2
  on t1.profile_id = t2.profile_id
  and t2.last_hostname is not null
  where t1.visit_id is not null
),

visits_table as (
  select
    extract(date from timestamp_millis(timestamp) at time zone <project_timezone>) date,
    timestamp,
    profile_id,
    visit_id,
    case when first_value(visit_id) over(partition by profile_id order by timestamp asc rows between unbounded preceding and current row) = visit_id then true else false end is_first_visit,
    non_direct_visit_id,
    marked_visit_id,
    event_id as first_event_id,
    source,
    medium,
    campaign,
    content,
    term,
    strimix_refid,
    url_params,
    first_hostname,
    first_page_path,
    first_page_url,
    last_hostname,
    last_page_path,
    last_page_url,
    -- Нормализованный лендинг в формате "host/path?query" (нижний регистр,
    -- без протокола, "www." и хвостового слэша). Трекинговые query-параметры
    -- из excluded_url_params вырезаем, функциональные (категория, товар...)
    -- оставляем и сортируем по ключу, чтобы порядок параметров не дробил
    -- строки отчёта. Имя и нормализация совпадают с ad_costs.landing_page,
    -- поэтому в объединённых отчётах реклама и визиты режутся по одному ключу.
    -- Исключение проверяется по ИМЕНИ параметра (всё до первого '='), каждый
    -- активный паттерн — независимо и как полное совпадение без учёта
    -- регистра: 'utm_[a-z]+' покрывает utm_source и UTM_MEDIUM, но не
    -- custom_utm_source, а уже якоренный '^fbclid$' продолжает работать.
    -- Токен без '=' (например '?flag') рассматривается как ключ 'flag'
    -- одинаково здесь, в ветке ad_costs и в серверном preview.
    nullif(concat(
      regexp_replace(concat(
        regexp_replace(ifnull(lower(first_hostname), ''), '^www[.]', ''),
        '/',
        ifnull(lower(first_page_path), '')
      ), '/+$', ''),
      ifnull((
        select concat('?', string_agg(kv, '&' order by kv))
        from unnest(split(regexp_extract(lower(first_page_url), '[?]([^#]*)'), '&')) as kv
        where kv != ''
        and not exists (
          select 1
          from unnest(@excluded_url_param_patterns) as excluded_url_param_pattern
          where regexp_contains(
            regexp_extract(kv, r'^[^=]*'),
            concat('(?i)^(?:', excluded_url_param_pattern, r')$')
          )
        )
      ), '')
    ), '') as landing_page,
    -- Визиты из событий браузера всегда имеют visit_type='web';
    -- синтетические визиты создаются отдельно из attribution_signal_mappings
    -- (шаг 4.2).
    'web' as visit_type,
    cast(null as string) as traffic_origin,
    cast(null as string) as traffic_channel,
    -- attributed_ad заполняется только у синтетических визитов (шаг 4.2):
    -- туда попадают ТОЛЬКО однозначные значения (id, названия, назначение
    -- рекламы); неоднозначное поле остаётся null. Связка с расходами в
    -- отчётах идёт каскадом: сначала id, затем названия + ad_destination,
    -- затем канонические метки.
    cast(null as struct<
      data_source    string,
      campaign_id    string,
      campaign_name  string,
      adgroup_id     string,
      adgroup_name   string,
      ad_id          string,
      ad_name        string,
      ad_destination string
    >) as attributed_ad
  from browser_events_with_last_page_info
  where visit_id is not null
)

select * from visits_table)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);
set query = replace(query, '<project_timezone>', _project_timezone);

-- Паттерны исключений передаём ПАРАМЕТРОМ, а не подстановкой в текст запроса.
execute immediate (query) using excluded_url_param_patterns as excluded_url_param_patterns;

end;

--------------------------------------------------------------------------
-------- 4.2 СИНТЕТИЧЕСКИЕ ВИЗИТЫ ИЗ СИГНАЛОВ АТРИБУЦИИ --------------------
--------------------------------------------------------------------------
-- Бизнес-смысл: конверсии мимо сайта (переписки в Instagram Direct, лид-
-- формы, звонки, ручной источник сделки в CRM) не имеют веб-визита. Без
-- этого шага реклама не получила бы свою конверсию. Джоба читает сигналы
-- атрибуции из событий по маппингам `attribution_signal_mappings`
-- («где у этого клиента лежат сигналы»), по id/названиям из сигнала ищет
-- совпадения в таблице расходов ad_costs (восстанавливает рекламную
-- иерархию) и создаёт искусственные записи в visits
-- (visit_type='synthetic'), которые встраиваются в стандартную цепочку
-- атрибуции (first/last/linear) без специальных случаев.
-- Техника: три шага.
--  4.2.1 извлекаем сигналы и резолвим рекламную идентичность во временную
--        таблицу `synthetic_signals` (сигнал, метки, attributed_ad,
--        значения зарезолвленной группы);
--  4.2.2 кладём во временную таблицу `visit_ad_groups` связку
--        «визит ↔ значения его зарезолвленной группы» для рекламных
--        условий и плейсхолдеров правил на шаге 4.3 (таблица живёт только
--        до конца прогона);
--  4.2.3 вставляем синтетические визиты в staging-таблицу визитов.

begin

declare query string;
declare query_template string;

-- Шаг 4.2.1. Извлечение сигналов и резолюция рекламной идентичности.
--
-- Маппинг указывает на контейнер параметров (entity + param_source) и на
-- ключи внутри него: шесть ключей меток (m.<label>_param_key) и шесть
-- ключей рекламной идентичности (id/названия кампании, группы,
-- объявления). Null-ключ значит «не извлекать»; неявных дефолтов нет:
-- что настроено, то и извлекается. Опциональный m.event_name ограничивает
-- маппинг событиями с этим именем (например, выделенное событие
-- 'offline_attribution' от интеграции).
--
-- Фильтры срабатывания (m.match_*_regex, раздел 3.1 ТЗ): после извлечения
-- каждое непустое match-условие должно совпасть со своим извлечённым
-- значением (AND, с учётом регистра). Если фильтр задан, а значение не
-- извлеклось, фильтр не пройден и маппинг к этому сигналу не применяется.
-- Так один CRM-поток разводится на несколько маппингов с разными
-- границами резолюции: например, source_id=13 (Instagram/чат) попадает в
-- маппинг с несайтовым ad_destination_regex, а source_id=14 (сайт) — в
-- маппинг со скоупом '^web$', и одноимённые объявления разных назначений
-- не перепутываются.
--
-- Семантика заказов и сделок следует правилу «состояние, а не история»
-- (раздел 3.1 ТЗ). Заказ/сделка обновляются каждым новым событием,
-- поэтому метки и рекламную идентичность читаем из ПОСЛЕДНЕГО события
-- сущности (актуальное состояние; так же строятся таблицы orders/deals).
-- Якорь визита берём из СОЗДАНИЯ сущности (самое раннее её событие):
-- визит должен предшествовать конверсионному событию, к которому
-- привязана атрибуция заказа. Если CRM поправила атрибуцию поздним
-- событием, следующий прогон пересоздаёт синтетику с нуля, и визит
-- получает актуальные метки при неизменном якоре. Для entity='event'
-- событие неизменяемо: оно само служит и сигналом, и якорем.
--
-- Резолюция рекламной идентичности (раздел 7 ТЗ).
--
-- Что делает этот шаг: берёт из сигнала id и/или названия рекламных
-- объектов (то, что клиент передал в CRM) и ищет по ним строки в таблице
-- расходов ad_costs. Найденные строки и есть «какая это была реклама».
--
-- Порядок поиска — от самого точного уровня к более грубому. Сначала
-- пытаемся найти объявление, если не вышло — группу объявлений, если и
-- там пусто — кампанию. Как только какой-то уровень нашёл совпадения,
-- более грубые уровни для этого сигнала уже не нужны (глубже важнее).
--
-- На каждом уровне ключ поиска такой:
--   1) если в сигнале есть id этого уровня (sig_ad_id / sig_adgroup_id /
--      sig_campaign_id) — сравниваем его с колонкой id в ad_costs
--      (ad_id / adgroup_id / campaign_id);
--   2) если id в сигнале нет, но есть название — сравниваем название из
--      сигнала (sig_ad_name / sig_adgroup_name / sig_campaign_name) с
--      колонкой названия в ad_costs (ad_name / adgroup_name /
--      campaign_name). Это как раз «сетевое название»: имя объекта так,
--      как оно лежит в рекламном кабинете и выгружено коннектором в
--      ad_costs, а не каноническая UTM-метка source/campaign/…
--
-- Сравнение названий строго с учётом регистра: «Промо Март» и «промо март»
-- считаются разными объявлениями и не склеиваются.
--
-- Дополнительные ограничения поиска:
--   - если в маппинге задан ad_destination_regex, ищем только среди строк
--     ad_costs с подходящим назначением (чтобы чатовый сигнал не поймал
--     одноимённое сайтовое объявление);
--   - если задан data_source_regex, ищем только в строках подходящей
--     рекламной сети (чтобы тёзка из другой сети не размывал группу);
--   - даты расходов режутся по click_delay: при false расход и якорь
--     визита должны быть в один день, при true расход может быть в любой
--     день не позже якоря.
--
-- Что получается на выходе из найденных строк ad_costs:
--   - зарезолвленная группа визита (все совпавшие строки) — живёт во
--     временных таблицах прогона; из неё считаются g_*: единые значения
--     для правил utm/origin/channel и плейсхолдеров. Если внутри группы
--     по полю несколько разных значений, в g_* пишется '(combined)';
--     если значения нет — null;
--   - u_*: только однозначные id (с учётом сети) для записи в
--     visits.attributed_ad. Если тёзки сидят в разных сетях, ни id, ни
--     data_source в attributed_ad не пишутся;
--   - постоянный след в visits.attributed_ad: однозначные id, однозначные
--     названия (campaign_name/adgroup_name/ad_name) и однозначный
--     ad_destination. Поле с '(combined)' в группе остаётся null. Так
--     отчёты склеивают визит с расходами каскадом: id → названия +
--     ad_destination → канонические метки. Маркер '(combined)' в
--     постоянные таблицы не пишется нигде: неоднозначность бакета движок
--     отчётов показывает при чтении.
set query_template = """
create temp table `synthetic_signals` as (
-- Пары «событие × строка маппинга»: одно событие прогоняется через все
-- подошедшие маппинги, из каждой пары извлекается свой набор сигналов.
-- Метки нормализуем сразу: пустая строка превращается в null, пустых
-- строк в метках не бывает.
with mapped_events as (
  select
    e.timestamp,
    e.event_id,
    e.profile_id,
    m.mapping_id,
    m.priority,
    m.mode,
    m.entity,
    m.ad_destination_regex,
    m.data_source_regex,
    m.match_source_regex, m.match_medium_regex, m.match_campaign_regex,
    m.match_content_regex, m.match_term_regex, m.match_strimix_refid_regex,
    m.match_campaign_id_regex, m.match_campaign_name_regex,
    m.match_adgroup_id_regex, m.match_adgroup_name_regex,
    m.match_ad_id_regex, m.match_ad_name_regex,
    -- Для 'event'-маппингов каждый подходящий ивент сам становится
    -- экземпляром сущности: один синтетический визит на событие
    -- (дедупликация ниже).
    case m.entity
      when 'order' then e.`order`.id
      when 'deal' then e.deal.id
      else e.event_id end as entity_id,
    nullif(trim((select value.string_value from unnest(c.params) where key = m.source_param_key and value.string_value is not null limit 1)), '') as source,
    nullif(trim((select value.string_value from unnest(c.params) where key = m.medium_param_key and value.string_value is not null limit 1)), '') as medium,
    nullif(trim((select value.string_value from unnest(c.params) where key = m.campaign_param_key and value.string_value is not null limit 1)), '') as campaign,
    nullif(trim((select value.string_value from unnest(c.params) where key = m.content_param_key and value.string_value is not null limit 1)), '') as content,
    nullif(trim((select value.string_value from unnest(c.params) where key = m.term_param_key and value.string_value is not null limit 1)), '') as term,
    nullif(trim((select value.string_value from unnest(c.params) where key = m.strimix_refid_param_key and value.string_value is not null limit 1)), '') as strimix_refid,
    -- Сигналы рекламной идентичности: ниже по этим значениям ищем
    -- совпадения в таблице расходов ad_costs.
    nullif(trim((select value.string_value from unnest(c.params) where key = m.campaign_id_param_key and value.string_value is not null limit 1)), '') as sig_campaign_id,
    nullif(trim((select value.string_value from unnest(c.params) where key = m.campaign_name_param_key and value.string_value is not null limit 1)), '') as sig_campaign_name,
    nullif(trim((select value.string_value from unnest(c.params) where key = m.adgroup_id_param_key and value.string_value is not null limit 1)), '') as sig_adgroup_id,
    nullif(trim((select value.string_value from unnest(c.params) where key = m.adgroup_name_param_key and value.string_value is not null limit 1)), '') as sig_adgroup_name,
    nullif(trim((select value.string_value from unnest(c.params) where key = m.ad_id_param_key and value.string_value is not null limit 1)), '') as sig_ad_id,
    nullif(trim((select value.string_value from unnest(c.params) where key = m.ad_name_param_key and value.string_value is not null limit 1)), '') as sig_ad_name
  from `identified_events` as e
  inner join `<project_name>.<dataset_name>.attribution_signal_mappings` as m
  on m.is_active = true
  and (
    (m.entity = 'order' and m.param_source = 'custom_params' and e.`order`.id is not null)
    or (m.entity = 'deal' and m.param_source = 'custom_params' and e.deal.id is not null)
    or (m.entity = 'event' and m.param_source = 'event_params')
  )
  and (m.event_name is null or e.event_name = m.event_name)
  -- Однострочный lateral: подставляет нужный контейнер параметров маппинга,
  -- чтобы извлечение меток выше не зависело от типа контейнера.
  cross join unnest([struct(
    case
      when m.entity = 'order' then e.`order`.custom_params
      when m.entity = 'deal' then e.deal.custom_params
      else e.event_params end as params
  )]) as c
),

-- «Состояние, а не история»: на каждый экземпляр сущности внутри маппинга
-- оставляем одну строку. Метки и рекламные сигналы берём из ПОСЛЕДНЕГО
-- события сущности (актуальное состояние). Якорь визита (timestamp,
-- event_id, profile_id) берём из ПЕРВОГО события (момент создания
-- сущности). Для entity='event' партиция состоит из одного события,
-- поэтому эта строка совпадает сама с собой.
entity_signals as (
  select
    anchor_timestamp as timestamp,
    extract(date from timestamp_millis(anchor_timestamp) at time zone <project_timezone>) as event_date,
    anchor_event_id as event_id,
    anchor_profile_id as profile_id,
    -- Единица резолюции: пара «экземпляр сущности × строка маппинга».
    concat(anchor_event_id, ':', mapping_id) as signal_key,
    mapping_id, priority, mode, entity, entity_id, ad_destination_regex,
    data_source_regex,
    match_source_regex, match_medium_regex, match_campaign_regex,
    match_content_regex, match_term_regex, match_strimix_refid_regex,
    match_campaign_id_regex, match_campaign_name_regex,
    match_adgroup_id_regex, match_adgroup_name_regex,
    match_ad_id_regex, match_ad_name_regex,
    source, medium, campaign, content, term, strimix_refid,
    sig_campaign_id, sig_campaign_name, sig_adgroup_id, sig_adgroup_name, sig_ad_id, sig_ad_name
  from (
    select
      *,
      min(timestamp) over (partition by mapping_id, entity, entity_id) as anchor_timestamp,
      first_value(event_id) over (partition by mapping_id, entity, entity_id order by timestamp asc, event_id asc) as anchor_event_id,
      first_value(profile_id) over (partition by mapping_id, entity, entity_id order by timestamp asc, event_id asc) as anchor_profile_id,
      row_number() over (partition by mapping_id, entity, entity_id order by timestamp desc, event_id desc) as rn_last
    from mapped_events
  )
  where rn_last = 1
),

-- Фильтры срабатывания маппинга: проверяются на извлечённых значениях
-- актуального состояния сущности. Каждый заданный match_*_regex должен
-- совпасть со своим значением (AND, с учётом регистра); если значение не
-- извлеклось, фильтр считается непройденным и пара «сущность × маппинг»
-- выбывает. ВАЖНО: не прошедший фильтры маппинг не становится кандидатом
-- и не участвует в розыгрыше priority ниже — приоритет разыгрывается
-- только между сработавшими маппингами. Поэтому маппинг с непрошедшим
-- фильтром не блокирует другой маппинг того же экземпляра: два маппинга
-- со взаимоисключающими фильтрами (^13$ и ^14$) обслуживают свои потоки
-- независимо.
matched_signals as (
  select * from entity_signals
  where (match_source_regex is null or (source is not null and regexp_contains(source, match_source_regex)))
  and (match_medium_regex is null or (medium is not null and regexp_contains(medium, match_medium_regex)))
  and (match_campaign_regex is null or (campaign is not null and regexp_contains(campaign, match_campaign_regex)))
  and (match_content_regex is null or (content is not null and regexp_contains(content, match_content_regex)))
  and (match_term_regex is null or (term is not null and regexp_contains(term, match_term_regex)))
  and (match_strimix_refid_regex is null or (strimix_refid is not null and regexp_contains(strimix_refid, match_strimix_refid_regex)))
  and (match_campaign_id_regex is null or (sig_campaign_id is not null and regexp_contains(sig_campaign_id, match_campaign_id_regex)))
  and (match_campaign_name_regex is null or (sig_campaign_name is not null and regexp_contains(sig_campaign_name, match_campaign_name_regex)))
  and (match_adgroup_id_regex is null or (sig_adgroup_id is not null and regexp_contains(sig_adgroup_id, match_adgroup_id_regex)))
  and (match_adgroup_name_regex is null or (sig_adgroup_name is not null and regexp_contains(sig_adgroup_name, match_adgroup_name_regex)))
  and (match_ad_id_regex is null or (sig_ad_id is not null and regexp_contains(sig_ad_id, match_ad_id_regex)))
  and (match_ad_name_regex is null or (sig_ad_name is not null and regexp_contains(sig_ad_name, match_ad_name_regex)))
),

-- Сигнал считаем «присутствующим», когда извлеклась хотя бы одна метка
-- или один параметр рекламной идентичности. Полностью пустое извлечение
-- синтетический визит не создаёт.
present_signals as (
  select * from matched_signals
  where coalesce(
    source, medium, campaign, content, term, strimix_refid,
    sig_campaign_id, sig_campaign_name,
    sig_adgroup_id, sig_adgroup_name,
    sig_ad_id, sig_ad_name
  ) is not null
),

-- Дедупликация ВНУТРИ типа сущности: на один экземпляр (entity, entity_id)
-- остаётся один синтетический визит. Если на одном экземпляре сработало
-- (прошло фильтры срабатывания) несколько маппингов, выигрывает маппинг
-- с меньшим priority.
-- Кросс-сущностной дедупликации сознательно нет: событие, совпавшее с
-- маппингами разных сущностей, даёт визит на каждую (это управляется
-- настройкой event_name).
deduped_signals as (
  select * from present_signals
  qualify row_number() over (partition by entity, entity_id order by priority asc, mapping_id asc) = 1
),

-- mode='fallback': сигнал пропускается, если у профиля уже есть
-- маркированный веб-визит до якоря (ручной источник не должен красть
-- last-click у точного веб-визита). mode='override': визит создаётся
-- всегда и за счёт «минус 1 мс» становится последней маркированной точкой
-- касания перед конверсией. Проверка идёт по staging-визитам текущего
-- прогона (на этот момент там только веб-визиты)
allowed_signals as (
  select s.* from deduped_signals as s
  where s.mode = 'override'
  or not exists (
    select 1 from `visits_staging` as v
    where v.profile_id = s.profile_id
    and v.marked_visit_id is not null
    and v.timestamp <= s.timestamp
  )
),

-- Уровень объявления. Ищем строки ad_costs так:
--   - если в сигнале есть sig_ad_id — по колонке ad_costs.ad_id;
--   - иначе, если есть sig_ad_name — по колонке ad_costs.ad_name
--     (название объявления из кабинета, сравнение строго по регистру).
-- Все совпавшие строки — группа этого уровня; из них считаем g_* (для
-- правил) и u_* (однозначные id в attributed_ad).
ad_level as (
  select
    s.signal_key,
    if(count(distinct a.data_source) > 1, '(combined)', max(a.data_source)) as g_data_source,
    if(count(distinct a.campaign_id) > 1, '(combined)', max(a.campaign_id)) as g_campaign_id,
    if(count(distinct a.campaign_name) > 1, '(combined)', max(a.campaign_name)) as g_campaign_name,
    if(count(distinct a.adgroup_id) > 1, '(combined)', max(a.adgroup_id)) as g_adgroup_id,
    if(count(distinct a.adgroup_name) > 1, '(combined)', max(a.adgroup_name)) as g_adgroup_name,
    if(count(distinct a.ad_id) > 1, '(combined)', max(a.ad_id)) as g_ad_id,
    if(count(distinct a.ad_name) > 1, '(combined)', max(a.ad_name)) as g_ad_name,
    if(count(distinct a.ad_destination) > 1, '(combined)', max(a.ad_destination)) as g_ad_destination,
    -- Однозначные id: уникальность считается с учётом сети (ключ
    -- «data_source:id»); тёзки в разных сетях не дают ни id, ни data_source
    if(count(distinct a.data_source) = 1, max(a.data_source), null) as u_data_source,
    if(count(distinct concat(ifnull(a.data_source, ''), ':', ifnull(a.campaign_id, ''))) = 1, max(a.campaign_id), null) as u_campaign_id,
    if(count(distinct concat(ifnull(a.data_source, ''), ':', ifnull(a.adgroup_id, ''))) = 1, max(a.adgroup_id), null) as u_adgroup_id,
    if(count(distinct concat(ifnull(a.data_source, ''), ':', a.ad_id)) = 1, max(a.ad_id), null) as u_ad_id
  from allowed_signals as s
  inner join `<project_name>.<dataset_name>.ad_costs` as a
  on a.ad_id is not null
  and (
    (s.sig_ad_id is not null and a.ad_id = s.sig_ad_id)
    or (s.sig_ad_id is null and s.sig_ad_name is not null
        and a.ad_name is not null and a.ad_name = s.sig_ad_name)
  )
  and (s.ad_destination_regex is null or regexp_contains(ifnull(a.ad_destination, ''), concat('(?i)', s.ad_destination_regex)))
  and (s.data_source_regex is null or regexp_contains(ifnull(a.data_source, ''), concat('(?i)', s.data_source_regex)))
  and (
    (ifnull(a.click_delay, false) = false and a.date = s.event_date)
    or (a.click_delay = true and a.date <= s.event_date)
  )
  group by s.signal_key
),

-- Уровень группы объявлений. Ищем строки ad_costs так:
--   - если в сигнале есть sig_adgroup_id — по колонке ad_costs.adgroup_id;
--   - иначе, если есть sig_adgroup_name — по колонке ad_costs.adgroup_name
--     (название группы/adset из кабинета, строго по регистру).
adgroup_level as (
  select
    s.signal_key,
    if(count(distinct a.data_source) > 1, '(combined)', max(a.data_source)) as g_data_source,
    if(count(distinct a.campaign_id) > 1, '(combined)', max(a.campaign_id)) as g_campaign_id,
    if(count(distinct a.campaign_name) > 1, '(combined)', max(a.campaign_name)) as g_campaign_name,
    if(count(distinct a.adgroup_id) > 1, '(combined)', max(a.adgroup_id)) as g_adgroup_id,
    if(count(distinct a.adgroup_name) > 1, '(combined)', max(a.adgroup_name)) as g_adgroup_name,
    if(count(distinct a.ad_id) > 1, '(combined)', max(a.ad_id)) as g_ad_id,
    if(count(distinct a.ad_name) > 1, '(combined)', max(a.ad_name)) as g_ad_name,
    if(count(distinct a.ad_destination) > 1, '(combined)', max(a.ad_destination)) as g_ad_destination,
    if(count(distinct a.data_source) = 1, max(a.data_source), null) as u_data_source,
    if(count(distinct concat(ifnull(a.data_source, ''), ':', ifnull(a.campaign_id, ''))) = 1, max(a.campaign_id), null) as u_campaign_id,
    if(count(distinct concat(ifnull(a.data_source, ''), ':', a.adgroup_id)) = 1, max(a.adgroup_id), null) as u_adgroup_id
  from allowed_signals as s
  inner join `<project_name>.<dataset_name>.ad_costs` as a
  on a.adgroup_id is not null
  and (
    (s.sig_adgroup_id is not null and a.adgroup_id = s.sig_adgroup_id)
    or (s.sig_adgroup_id is null and s.sig_adgroup_name is not null
        and a.adgroup_name is not null and a.adgroup_name = s.sig_adgroup_name)
  )
  and (s.ad_destination_regex is null or regexp_contains(ifnull(a.ad_destination, ''), concat('(?i)', s.ad_destination_regex)))
  and (s.data_source_regex is null or regexp_contains(ifnull(a.data_source, ''), concat('(?i)', s.data_source_regex)))
  and (
    (ifnull(a.click_delay, false) = false and a.date = s.event_date)
    or (a.click_delay = true and a.date <= s.event_date)
  )
  group by s.signal_key
),

-- Уровень кампании. Ищем строки ad_costs так:
--   - если в сигнале есть sig_campaign_id — по колонке ad_costs.campaign_id;
--   - иначе, если есть sig_campaign_name — по колонке ad_costs.campaign_name
--     (название кампании из кабинета, строго по регистру).
campaign_level as (
  select
    s.signal_key,
    if(count(distinct a.data_source) > 1, '(combined)', max(a.data_source)) as g_data_source,
    if(count(distinct a.campaign_id) > 1, '(combined)', max(a.campaign_id)) as g_campaign_id,
    if(count(distinct a.campaign_name) > 1, '(combined)', max(a.campaign_name)) as g_campaign_name,
    if(count(distinct a.adgroup_id) > 1, '(combined)', max(a.adgroup_id)) as g_adgroup_id,
    if(count(distinct a.adgroup_name) > 1, '(combined)', max(a.adgroup_name)) as g_adgroup_name,
    if(count(distinct a.ad_id) > 1, '(combined)', max(a.ad_id)) as g_ad_id,
    if(count(distinct a.ad_name) > 1, '(combined)', max(a.ad_name)) as g_ad_name,
    if(count(distinct a.ad_destination) > 1, '(combined)', max(a.ad_destination)) as g_ad_destination,
    if(count(distinct a.data_source) = 1, max(a.data_source), null) as u_data_source,
    if(count(distinct concat(ifnull(a.data_source, ''), ':', a.campaign_id)) = 1, max(a.campaign_id), null) as u_campaign_id
  from allowed_signals as s
  inner join `<project_name>.<dataset_name>.ad_costs` as a
  on a.campaign_id is not null
  and (
    (s.sig_campaign_id is not null and a.campaign_id = s.sig_campaign_id)
    or (s.sig_campaign_id is null and s.sig_campaign_name is not null
        and a.campaign_name is not null and a.campaign_name = s.sig_campaign_name)
  )
  and (s.ad_destination_regex is null or regexp_contains(ifnull(a.ad_destination, ''), concat('(?i)', s.ad_destination_regex)))
  and (s.data_source_regex is null or regexp_contains(ifnull(a.data_source, ''), concat('(?i)', s.data_source_regex)))
  and (
    (ifnull(a.click_delay, false) = false and a.date = s.event_date)
    or (a.click_delay = true and a.date <= s.event_date)
  )
  group by s.signal_key
),

resolved_signals as (
  select
    s.timestamp,
    s.profile_id,
    s.event_id,
    -- Извлечённые метки становятся сырьём для стадии utm (шаг 4.3):
    -- правила могут их перезаписать; извлечённое значение остаётся только
    -- если ни одно правило это поле не задало.
    s.source,
    s.medium,
    s.campaign,
    s.content,
    s.term,
    s.strimix_refid,
    -- Берём группу с самого точного уровня, где поиск что-то нашёл:
    -- сначала уровень объявления, иначе группы, иначе кампании.
    -- Эти значения потом кладутся во временную visit_ad_groups и кормят
    -- рекламные условия правил и плейсхолдеры проекции до конца прогона.
    case
      when al.signal_key is not null then struct(
        al.g_data_source as data_source, al.g_campaign_id as campaign_id,
        al.g_campaign_name as campaign_name, al.g_adgroup_id as adgroup_id,
        al.g_adgroup_name as adgroup_name, al.g_ad_id as ad_id,
        al.g_ad_name as ad_name, al.g_ad_destination as ad_destination)
      when agl.signal_key is not null then struct(
        agl.g_data_source as data_source, agl.g_campaign_id as campaign_id,
        agl.g_campaign_name as campaign_name, agl.g_adgroup_id as adgroup_id,
        agl.g_adgroup_name as adgroup_name, agl.g_ad_id as ad_id,
        agl.g_ad_name as ad_name, agl.g_ad_destination as ad_destination)
      when cl.signal_key is not null then struct(
        cl.g_data_source as data_source, cl.g_campaign_id as campaign_id,
        cl.g_campaign_name as campaign_name, cl.g_adgroup_id as adgroup_id,
        cl.g_adgroup_name as adgroup_name, cl.g_ad_id as ad_id,
        cl.g_ad_name as ad_name, cl.g_ad_destination as ad_destination)
      else cast(null as struct<
        data_source string, campaign_id string, campaign_name string,
        adgroup_id string, adgroup_name string, ad_id string,
        ad_name string, ad_destination string>)
    end as ad_group,
    -- Постоянный след резолюции пишем в visits.attributed_ad: туда попадают
    -- ТОЛЬКО однозначные значения — id, названия и назначение рекламы
    -- (ad_destination). Неоднозначное в группе поле остаётся null,
    -- маркер '(combined)' в постоянную таблицу не попадает: nullif
    -- срезает его из групповых значений. Явно переданные клиентом id и
    -- названия сохраняем даже без совпадений в ad_costs: это факт от
    -- клиента, он «оживёт», когда расходы догрузятся (полная пересборка
    -- каждый прогон сматчит их задним числом). Отчёты склеивают визит с
    -- расходами каскадом: сначала id, затем названия + ad_destination.
    case
      when coalesce(
        al.u_data_source, agl.u_data_source, cl.u_data_source,
        al.u_ad_id, s.sig_ad_id,
        agl.u_adgroup_id, s.sig_adgroup_id,
        cl.u_campaign_id, s.sig_campaign_id,
        nullif(al.g_ad_name, '(combined)'), s.sig_ad_name,
        nullif(al.g_adgroup_name, '(combined)'), nullif(agl.g_adgroup_name, '(combined)'), s.sig_adgroup_name,
        nullif(al.g_campaign_name, '(combined)'), nullif(agl.g_campaign_name, '(combined)'), nullif(cl.g_campaign_name, '(combined)'), s.sig_campaign_name
      ) is null
      then cast(null as struct<
        data_source string, campaign_id string, campaign_name string,
        adgroup_id string, adgroup_name string, ad_id string,
        ad_name string, ad_destination string>)
      else struct(
        coalesce(al.u_data_source, agl.u_data_source, cl.u_data_source) as data_source,
        coalesce(al.u_campaign_id, agl.u_campaign_id, cl.u_campaign_id, s.sig_campaign_id) as campaign_id,
        coalesce(nullif(al.g_campaign_name, '(combined)'), nullif(agl.g_campaign_name, '(combined)'), nullif(cl.g_campaign_name, '(combined)'), s.sig_campaign_name) as campaign_name,
        coalesce(al.u_adgroup_id, agl.u_adgroup_id, s.sig_adgroup_id) as adgroup_id,
        coalesce(nullif(al.g_adgroup_name, '(combined)'), nullif(agl.g_adgroup_name, '(combined)'), s.sig_adgroup_name) as adgroup_name,
        coalesce(al.u_ad_id, s.sig_ad_id) as ad_id,
        coalesce(nullif(al.g_ad_name, '(combined)'), s.sig_ad_name) as ad_name,
        coalesce(nullif(al.g_ad_destination, '(combined)'), nullif(agl.g_ad_destination, '(combined)'), nullif(cl.g_ad_destination, '(combined)')) as ad_destination
      )
    end as attributed_ad
  from allowed_signals as s
  left join ad_level as al on al.signal_key = s.signal_key
  left join adgroup_level as agl on agl.signal_key = s.signal_key
  left join campaign_level as cl on cl.signal_key = s.signal_key
)

select *, generate_uuid() as visit_id
from resolved_signals
-- Отбрасываем сигналы, из которых не вышло ничего пригодного: ни меток, ни
-- рекламного объекта, ни зарезолвленной группы. Нерезолвнутое название без
-- меток появится на следующих прогонах, когда догрузятся расходы.
where coalesce(source, medium, campaign, content, term, strimix_refid) is not null
or attributed_ad is not null
or ad_group is not null)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);
set query = replace(query, '<project_timezone>', _project_timezone);

execute immediate (query);

-- Шаг 4.2.2. Кладём зарезолвленную группу каждого визита во временную
-- таблицу прогона. Бизнес-смысл: у синтетического визита нет колонок
-- data_source/ad_destination/сетевых названий, но правила стадий
-- utm/origin/channel должны уметь опираться на атрибуты его рекламы.
-- Связка «визит ↔ значения его группы» живёт до конца прогона и НЕ
-- записывается в visits: в постоянной таблице остаётся только
-- attributed_ad с однозначными id/названиями. Группа персональна: каждый визит
-- видит только строки расходов, найденные по ЕГО сигналу, поэтому
-- правила не «размазывают» чужие расходы.
set query_template = """
create temp table `visit_ad_groups` as (
  select visit_id, ad_group as g
  from `synthetic_signals`
  where ad_group is not null
)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

-- Шаг 4.2.3. Вставляем синтетические визиты в staging-таблицу.
-- Timestamp сдвигаем на якорь МИНУС 1 мс: точка касания семантически
-- предшествует конверсионному событию, поэтому last-click атрибуция
-- конверсии видит этот визит. Визит всегда непрямой и маркированный
-- (non_direct_visit_id и marked_visit_id заполнены), потому что сигнал
-- по определению несёт источник. url_params остаются пустыми: там лежат
-- только фактические query-параметры страницы, которой у синтетики нет.
set query_template = """
insert into `visits_staging`
(date, timestamp, profile_id, visit_id, is_first_visit, non_direct_visit_id, marked_visit_id, first_event_id,
 source, medium, campaign, content, term, strimix_refid, url_params,
 first_hostname, first_page_path, first_page_url, last_hostname, last_page_path, last_page_url,
 landing_page, visit_type, traffic_origin, traffic_channel, attributed_ad)
select
  extract(date from timestamp_millis(timestamp - 1) at time zone <project_timezone>) as date,
  timestamp - 1 as timestamp,
  profile_id,
  visit_id,
  false as is_first_visit,
  visit_id as non_direct_visit_id,
  visit_id as marked_visit_id,
  event_id as first_event_id,
  source,
  medium,
  campaign,
  content,
  term,
  strimix_refid,
  cast([] as array<struct<key string, value struct<string_value string>>>) as url_params,
  cast(null as string) as first_hostname,
  cast(null as string) as first_page_path,
  cast(null as string) as first_page_url,
  cast(null as string) as last_hostname,
  cast(null as string) as last_page_path,
  cast(null as string) as last_page_url,
  cast(null as string) as landing_page,
  'synthetic' as visit_type,
  cast(null as string) as traffic_origin,
  cast(null as string) as traffic_channel,
  attributed_ad
from `synthetic_signals`""";

set query = replace(query_template, '<project_timezone>', _project_timezone);

execute immediate (query);

end;

--------------------------------------------------------------------------
--------- 4.3 КЛАССИФИКАЦИЯ ВИЗИТОВ И ФИНАЛЬНАЯ ЗАПИСЬ ТАБЛИЦЫ -------------
--------------------------------------------------------------------------
-- Бизнес-смысл: визиты прогоняются через три стадии правил traffic_rules.
--  utm     : перезаписывает канонические метки. Здесь работают правила
--            перевода (сырой CRM-код '13' → 'instagram') и правила проекции
--            (плейсхолдеры {campaign_name} и т.п. разворачиваются в
--            ОДНОЗНАЧНЫЕ значения зарезолвленной группы визита; поле,
--            разошедшееся внутри группы, даёт null — маркер '(combined)'
--            в данные не пишется, его считает движок отчётов при чтении).
--            Склейка с расходами в отчётах идёт через attributed_ad;
--            метки — косметика и последний ярус связки.
--  origin  : вычисляет конкретный источник трафика («Meta Ads», «Google»,
--            «Telegram»).
--  channel : вычисляет категорию трафика («Paid Social», «Organic Search»).
-- Каскад межстадийный: origin видит уже переписанные utm-стадией метки,
-- channel видит вычисленный traffic_origin. Внутри стадии utm все правила
-- видят ИСХОДНОЕ состояние меток (внутристадийного каскада нет).
-- Семантика стадии utm работает ПО ПОЛЯМ: каждое из шести полей set_*
-- берётся из первого по priority совпавшего правила, задавшего это поле.
-- Так перевод и проекция свободно совмещаются на одном визите (перевод
-- выигрывает source, проекция заполняет остальное). Стадии origin/channel
-- берут «первое совпавшее правило целиком» (у них один выход).
-- Рекламные условия правил (data_source, ad_destination, сетевые
-- названия/id) на синтетических визитах проверяем по ОДНОЗНАЧНОМУ
-- значению зарезолвленной группы (visit_ad_groups из шага 4.2). Если
-- группы нет или значение в ней неоднозначно, условие не выполняется. На
-- веб-визитах рекламные условия не выполняются никогда.
-- Стадия utm применяется к синтетическим визитам; правило с
-- applies_to_web=true дополнительно применяется к веб-визитам (UTM-алиасы:
-- нормализация 'fb'/'facebook' → единое значение). Дефолт false защищает
-- веб-факты от случайной перезаписи.
-- Атомарность: все стадии работают по временным таблицам, пользовательская
-- таблица visits заменяется ОДНИМ create or replace в самом конце, поэтому
-- отчёты никогда не видят промежуточное состояние.

begin

declare query string;
declare query_template string;

-- Стадия utm. Техника: собираем совпавшие пары «визит × правило».
-- Условия по каноническим меткам проверяем на исходном состоянии визита
-- (внутристадийного каскада нет). Рекламные условия проверяем по
-- зарезолвленной группе визита. Правило проекции срабатывает по схеме
-- «всё или ничего»: только на визиты, у которых все пять канонических
-- меток пусты. Затем разворачиваем плейсхолдеры однозначными значениями
-- группы (неоднозначное поле → null) и разыгрываем каждое поле
-- независимо по priority.
set query_template = """
create temp table `visits_utm_rewritten` as (
with utm_rules as (
  select
    r.*,
    -- Правило считаем проекцией, если хотя бы один выход содержит плейсхолдер.
    (has_placeholders(r.set_source) or has_placeholders(r.set_medium)
      or has_placeholders(r.set_campaign) or has_placeholders(r.set_content)
      or has_placeholders(r.set_term) or has_placeholders(r.set_strimix_refid)) as is_projection,
    -- Правило с рекламными условиями требует наличия зарезолвленной группы.
    (r.data_source_regex is not null or r.campaign_id_regex is not null
      or r.campaign_name_regex is not null or r.adgroup_id_regex is not null
      or r.adgroup_name_regex is not null or r.ad_id_regex is not null
      or r.ad_name_regex is not null or r.ad_destination_regex is not null) as has_ad_conditions
  from `<project_name>.<dataset_name>.traffic_rules` as r
  where r.is_active = true
  and r.stage = 'utm'
  and r.target in ('visit', 'both')
  -- Условие channel-стадии на стадии utm не имеет смысла.
  and r.traffic_origin_regex is null
  and (r.set_source is not null or r.set_medium is not null
    or r.set_campaign is not null or r.set_content is not null
    or r.set_term is not null or r.set_strimix_refid is not null)
),

matched as (
  select
    v.visit_id,
    r.priority,
    -- Флаги «правило задало поле»: розыгрыш полей идёт по этим флагам, а
    -- не по развёрнутому значению. Плейсхолдер без значения даёт null, но
    -- поле всё равно считается заданным и перезаписывает извлечённое.
    r.set_source is not null as def_source,
    r.set_medium is not null as def_medium,
    r.set_campaign is not null as def_campaign,
    r.set_content is not null as def_content,
    r.set_term is not null as def_term,
    r.set_strimix_refid is not null as def_strimix_refid,
    -- Развёрнутые значения: литералы проходят как есть, плейсхолдеры
    -- подставляются из личной группы визита ТОЛЬКО однозначными
    -- значениями: разошедшееся внутри группы поле (в g_* лежит маркер
    -- '(combined)') срезается nullif-ом в null. В канонические метки
    -- визита попадают только настоящие значения; неоднозначность бакета
    -- показывает движок отчётов при чтении.
    apply_placeholders(r.set_source, nullif(g.g.data_source, '(combined)'), nullif(g.g.campaign_id, '(combined)'), nullif(g.g.campaign_name, '(combined)'), nullif(g.g.adgroup_id, '(combined)'), nullif(g.g.adgroup_name, '(combined)'), nullif(g.g.ad_id, '(combined)'), nullif(g.g.ad_name, '(combined)'), v.source, v.medium, v.campaign, v.content, v.term) as val_source,
    apply_placeholders(r.set_medium, nullif(g.g.data_source, '(combined)'), nullif(g.g.campaign_id, '(combined)'), nullif(g.g.campaign_name, '(combined)'), nullif(g.g.adgroup_id, '(combined)'), nullif(g.g.adgroup_name, '(combined)'), nullif(g.g.ad_id, '(combined)'), nullif(g.g.ad_name, '(combined)'), v.source, v.medium, v.campaign, v.content, v.term) as val_medium,
    apply_placeholders(r.set_campaign, nullif(g.g.data_source, '(combined)'), nullif(g.g.campaign_id, '(combined)'), nullif(g.g.campaign_name, '(combined)'), nullif(g.g.adgroup_id, '(combined)'), nullif(g.g.adgroup_name, '(combined)'), nullif(g.g.ad_id, '(combined)'), nullif(g.g.ad_name, '(combined)'), v.source, v.medium, v.campaign, v.content, v.term) as val_campaign,
    apply_placeholders(r.set_content, nullif(g.g.data_source, '(combined)'), nullif(g.g.campaign_id, '(combined)'), nullif(g.g.campaign_name, '(combined)'), nullif(g.g.adgroup_id, '(combined)'), nullif(g.g.adgroup_name, '(combined)'), nullif(g.g.ad_id, '(combined)'), nullif(g.g.ad_name, '(combined)'), v.source, v.medium, v.campaign, v.content, v.term) as val_content,
    apply_placeholders(r.set_term, nullif(g.g.data_source, '(combined)'), nullif(g.g.campaign_id, '(combined)'), nullif(g.g.campaign_name, '(combined)'), nullif(g.g.adgroup_id, '(combined)'), nullif(g.g.adgroup_name, '(combined)'), nullif(g.g.ad_id, '(combined)'), nullif(g.g.ad_name, '(combined)'), v.source, v.medium, v.campaign, v.content, v.term) as val_term,
    apply_placeholders(r.set_strimix_refid, nullif(g.g.data_source, '(combined)'), nullif(g.g.campaign_id, '(combined)'), nullif(g.g.campaign_name, '(combined)'), nullif(g.g.adgroup_id, '(combined)'), nullif(g.g.adgroup_name, '(combined)'), nullif(g.g.ad_id, '(combined)'), nullif(g.g.ad_name, '(combined)'), v.source, v.medium, v.campaign, v.content, v.term) as val_strimix_refid
  from `visits_staging` as v
  left join `visit_ad_groups` as g on g.visit_id = v.visit_id
  inner join utm_rules as r
  -- Стадия utm всегда применяется к синтетическим визитам; к веб-визитам
  -- применяется только правилами с applies_to_web=true.
  on (
    v.visit_type = 'synthetic'
    or (v.visit_type = 'web' and ifnull(r.applies_to_web, false) = true)
  )
  -- Условия по каноническим меткам проверяем на исходном состоянии визита.
  and (r.source_regex is null or regexp_contains(ifnull(v.source, ''), r.source_regex))
  and (r.medium_regex is null or regexp_contains(ifnull(v.medium, ''), r.medium_regex))
  and (r.campaign_regex is null or regexp_contains(ifnull(v.campaign, ''), r.campaign_regex))
  and (r.content_regex is null or regexp_contains(ifnull(v.content, ''), r.content_regex))
  and (r.term_regex is null or regexp_contains(ifnull(v.term, ''), r.term_regex))
  and (r.strimix_refid_regex is null or regexp_contains(ifnull(v.strimix_refid, ''), r.strimix_refid_regex))
  -- Рекламные условия проверяем только через зарезолвленную группу: без
  -- группы (веб-визит или сигнал без рекламной идентичности) правило не
  -- совпадает. Неоднозначное значение группы ('(combined)') тоже честно
  -- провалит условие по конкретному значению.
  and (r.has_ad_conditions = false or g.visit_id is not null)
  and (r.data_source_regex is null or regexp_contains(ifnull(g.g.data_source, ''), r.data_source_regex))
  and (r.campaign_id_regex is null or regexp_contains(ifnull(g.g.campaign_id, ''), r.campaign_id_regex))
  and (r.campaign_name_regex is null or regexp_contains(ifnull(g.g.campaign_name, ''), r.campaign_name_regex))
  and (r.adgroup_id_regex is null or regexp_contains(ifnull(g.g.adgroup_id, ''), r.adgroup_id_regex))
  and (r.adgroup_name_regex is null or regexp_contains(ifnull(g.g.adgroup_name, ''), r.adgroup_name_regex))
  and (r.ad_id_regex is null or regexp_contains(ifnull(g.g.ad_id, ''), r.ad_id_regex))
  and (r.ad_name_regex is null or regexp_contains(ifnull(g.g.ad_name, ''), r.ad_name_regex))
  and (r.ad_destination_regex is null or regexp_contains(ifnull(g.g.ad_destination, ''), r.ad_destination_regex))
  -- «Всё или ничего» для правил проекции: срабатывают только когда все
  -- пять канонических меток пусты. Частично прописанные UTM не смешиваются
  -- с проекцией, реальные метки не перезаписываются названиями из кабинета.
  and (r.is_projection = false or coalesce(v.source, v.medium, v.campaign, v.content, v.term) is null)
  -- Условие по url_params: у синтетики url_params пустые, поэтому оно не
  -- совпадает. Живёт в where, а не в on: BigQuery не разрешает
  -- exists-подзапрос в join-предикате, а для inner join where эквивалентен on.
  where (r.url_param_key is null or exists (
    select 1 from unnest(v.url_params) as up
    where up.key = r.url_param_key
    and regexp_contains(ifnull(up.value.string_value, ''), ifnull(r.url_param_value_regex, ''))
  ))
),

-- Розыгрыш по полям: для каждого поля берём значение из первого по
-- priority правила, задавшего его. Обёртка в struct отличает «поле никто
-- не задал» (null-структ → остаётся исходное значение) от «правило задало
-- null» (плейсхолдер без значения → поле перезаписывается в null).
winners as (
  select
    visit_id,
    array_agg(if(def_source, struct(val_source as v), null) ignore nulls order by priority asc limit 1)[safe_offset(0)] as w_source,
    array_agg(if(def_medium, struct(val_medium as v), null) ignore nulls order by priority asc limit 1)[safe_offset(0)] as w_medium,
    array_agg(if(def_campaign, struct(val_campaign as v), null) ignore nulls order by priority asc limit 1)[safe_offset(0)] as w_campaign,
    array_agg(if(def_content, struct(val_content as v), null) ignore nulls order by priority asc limit 1)[safe_offset(0)] as w_content,
    array_agg(if(def_term, struct(val_term as v), null) ignore nulls order by priority asc limit 1)[safe_offset(0)] as w_term,
    array_agg(if(def_strimix_refid, struct(val_strimix_refid as v), null) ignore nulls order by priority asc limit 1)[safe_offset(0)] as w_strimix_refid
  from matched
  group by visit_id
)

select
  v.* replace(
    if(w.w_source is null, v.source, w.w_source.v) as source,
    if(w.w_medium is null, v.medium, w.w_medium.v) as medium,
    if(w.w_campaign is null, v.campaign, w.w_campaign.v) as campaign,
    if(w.w_content is null, v.content, w.w_content.v) as content,
    if(w.w_term is null, v.term, w.w_term.v) as term,
    if(w.w_strimix_refid is null, v.strimix_refid, w.w_strimix_refid.v) as strimix_refid
  )
from `visits_staging` as v
left join winners as w on w.visit_id = v.visit_id
)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

-- Стадия origin: traffic_origin берём из первого совпавшего правила
-- (priority asc). Условия по меткам видят УЖЕ переписанные utm-стадией
-- значения (межстадийный каскад). Если ни одно правило не совпало,
-- подставляем фолбэк: '(direct)' → 'Direct', пустой source → 'Unknown',
-- иначе сам source.
set query_template = """
create temp table `visits_with_origin` as (
  select
    v.* replace(
      coalesce(
        m.traffic_origin,
        case
          when v.source = '(direct)' then 'Direct'
          when v.source is null then 'Unknown'
          else v.source end
      ) as traffic_origin
    )
  from `visits_utm_rewritten` as v
  left join (
    select
      t.visit_id,
      array_agg(r.set_traffic_origin order by r.priority asc limit 1)[offset(0)] as traffic_origin
    from `visits_utm_rewritten` as t
    left join `visit_ad_groups` as g on g.visit_id = t.visit_id
    inner join `<project_name>.<dataset_name>.traffic_rules` as r
    on r.is_active = true
    and r.stage = 'origin'
    and r.target in ('visit', 'both')
    -- Условие channel-стадии на стадии origin не имеет смысла.
    and r.traffic_origin_regex is null
    and (r.source_regex is null or regexp_contains(ifnull(t.source, ''), r.source_regex))
    and (r.medium_regex is null or regexp_contains(ifnull(t.medium, ''), r.medium_regex))
    and (r.campaign_regex is null or regexp_contains(ifnull(t.campaign, ''), r.campaign_regex))
    and (r.content_regex is null or regexp_contains(ifnull(t.content, ''), r.content_regex))
    and (r.term_regex is null or regexp_contains(ifnull(t.term, ''), r.term_regex))
    and (r.strimix_refid_regex is null or regexp_contains(ifnull(t.strimix_refid, ''), r.strimix_refid_regex))
    -- Рекламные условия проверяем через зарезолвленную группу (см. стадию utm).
    and (
      (r.data_source_regex is null and r.campaign_id_regex is null
        and r.campaign_name_regex is null and r.adgroup_id_regex is null
        and r.adgroup_name_regex is null and r.ad_id_regex is null
        and r.ad_name_regex is null and r.ad_destination_regex is null)
      or g.visit_id is not null
    )
    and (r.data_source_regex is null or regexp_contains(ifnull(g.g.data_source, ''), r.data_source_regex))
    and (r.campaign_id_regex is null or regexp_contains(ifnull(g.g.campaign_id, ''), r.campaign_id_regex))
    and (r.campaign_name_regex is null or regexp_contains(ifnull(g.g.campaign_name, ''), r.campaign_name_regex))
    and (r.adgroup_id_regex is null or regexp_contains(ifnull(g.g.adgroup_id, ''), r.adgroup_id_regex))
    and (r.adgroup_name_regex is null or regexp_contains(ifnull(g.g.adgroup_name, ''), r.adgroup_name_regex))
    and (r.ad_id_regex is null or regexp_contains(ifnull(g.g.ad_id, ''), r.ad_id_regex))
    and (r.ad_name_regex is null or regexp_contains(ifnull(g.g.ad_name, ''), r.ad_name_regex))
    and (r.ad_destination_regex is null or regexp_contains(ifnull(g.g.ad_destination, ''), r.ad_destination_regex))
    where r.set_traffic_origin is not null
    -- Условие по url_params живёт в where, а не в on: BigQuery не разрешает
    -- exists-подзапрос в join-предикате; для inner join where эквивалентен on.
    and (r.url_param_key is null or exists (
      select 1 from unnest(t.url_params) as up
      where up.key = r.url_param_key
      and regexp_contains(ifnull(up.value.string_value, ''), ifnull(r.url_param_value_regex, ''))
    ))
    group by t.visit_id
  ) as m
  on m.visit_id = v.visit_id
)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

-- Стадия channel и финальная АТОМАРНАЯ запись пользовательской таблицы.
-- traffic_channel берём из первого совпавшего правила (оно может опираться
-- на уже вычисленный traffic_origin через traffic_origin_regex). Если ни
-- одно правило не совпало, подставляем 'Other'. Полностью готовый результат
-- одним create or replace заменяет таблицу visits.
set query_template = """
create or replace table `<project_name>.<dataset_name>.visits`
partition by date options (require_partition_filter = false) as (
  select
    v.* replace(coalesce(m.traffic_channel, 'Other') as traffic_channel)
  from `visits_with_origin` as v
  left join (
    select
      t.visit_id,
      array_agg(r.set_traffic_channel order by r.priority asc limit 1)[offset(0)] as traffic_channel
    from `visits_with_origin` as t
    left join `visit_ad_groups` as g on g.visit_id = t.visit_id
    inner join `<project_name>.<dataset_name>.traffic_rules` as r
    on r.is_active = true
    and r.stage = 'channel'
    and r.target in ('visit', 'both')
    and (r.source_regex is null or regexp_contains(ifnull(t.source, ''), r.source_regex))
    and (r.medium_regex is null or regexp_contains(ifnull(t.medium, ''), r.medium_regex))
    and (r.campaign_regex is null or regexp_contains(ifnull(t.campaign, ''), r.campaign_regex))
    and (r.content_regex is null or regexp_contains(ifnull(t.content, ''), r.content_regex))
    and (r.term_regex is null or regexp_contains(ifnull(t.term, ''), r.term_regex))
    and (r.strimix_refid_regex is null or regexp_contains(ifnull(t.strimix_refid, ''), r.strimix_refid_regex))
    -- Условие по уже вычисленному traffic_origin (межстадийный каскад).
    and (r.traffic_origin_regex is null or regexp_contains(ifnull(t.traffic_origin, ''), r.traffic_origin_regex))
    -- Рекламные условия проверяем через зарезолвленную группу (см. стадию utm).
    and (
      (r.data_source_regex is null and r.campaign_id_regex is null
        and r.campaign_name_regex is null and r.adgroup_id_regex is null
        and r.adgroup_name_regex is null and r.ad_id_regex is null
        and r.ad_name_regex is null and r.ad_destination_regex is null)
      or g.visit_id is not null
    )
    and (r.data_source_regex is null or regexp_contains(ifnull(g.g.data_source, ''), r.data_source_regex))
    and (r.campaign_id_regex is null or regexp_contains(ifnull(g.g.campaign_id, ''), r.campaign_id_regex))
    and (r.campaign_name_regex is null or regexp_contains(ifnull(g.g.campaign_name, ''), r.campaign_name_regex))
    and (r.adgroup_id_regex is null or regexp_contains(ifnull(g.g.adgroup_id, ''), r.adgroup_id_regex))
    and (r.adgroup_name_regex is null or regexp_contains(ifnull(g.g.adgroup_name, ''), r.adgroup_name_regex))
    and (r.ad_id_regex is null or regexp_contains(ifnull(g.g.ad_id, ''), r.ad_id_regex))
    and (r.ad_name_regex is null or regexp_contains(ifnull(g.g.ad_name, ''), r.ad_name_regex))
    and (r.ad_destination_regex is null or regexp_contains(ifnull(g.g.ad_destination, ''), r.ad_destination_regex))
    where r.set_traffic_channel is not null
    -- Условие по url_params живёт в where, а не в on: BigQuery не разрешает
    -- exists-подзапрос в join-предикате; для inner join where эквивалентен on.
    and (r.url_param_key is null or exists (
      select 1 from unnest(t.url_params) as up
      where up.key = r.url_param_key
      and regexp_contains(ifnull(up.value.string_value, ''), ifnull(r.url_param_value_regex, ''))
    ))
    group by t.visit_id
  ) as m
  on m.visit_id = v.visit_id
)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

end;

--------------------------------------------------------------------------
--------------- 5. ПРИВЯЗКА СОБЫТИЙ К ИДЕНТИФИКАТОРАМ ВИЗИТОВ --------------
--------------------------------------------------------------------------
-- Бизнес-смысл: каждому событию проставляем визит, внутри которого оно
-- произошло. На этом держится вся атрибуция конверсий к источникам.
-- Техника: события-открытия визитов уже знают свой visit_id (join по
-- first_event_id), остальные события получают visit_id последнего
-- открытого визита профиля оконной функцией.

begin

declare query string;
declare query_template string;

set query_template = """
-- Насыщаем все события идентификатором визита.
create temp table `identified_events_with_visits` as (
with marked_first_visit_events as (
  select
    e.timestamp,
    v.visit_id,
    e.event_id,
    e.event_name,
    e.event_params,
    e.user_data,
    e.user_properties,
    e.user_external_ids,
    e.profile_id,
    e.strimix_avid,
    e.ad_data,
    e.deal,
    e.offers,
    e.order,
    e.products,
    e.transaction,
    e.geo,
    e.device_info,
    e.is_test_event,
  from `identified_events` as e
  left join `<project_name>.<dataset_name>.visits` v
  on e.event_id = v.first_event_id
)

select
  timestamp,
  case 
    when device_info.web_info.user_agent is not null
    then last_value(visit_id ignore nulls) over(partition by profile_id order by timestamp asc rows between unbounded preceding and current row) 
    -- Небраузерное событие является якорем синтетического визита
    -- (visits.first_event_id): передаём id синтетического визита, чтобы
    -- окна атрибуции его подхватили.
    when visit_id is not null then visit_id
    else null end as visit_id,
  event_id,
  event_name,
  event_params,
  user_data,
  user_properties,
  user_external_ids,
  profile_id,
  strimix_avid,
  ad_data,
  deal,
  offers,
  `order`,
  products,
  transaction,
  geo,
  device_info,
  is_test_event
from marked_first_visit_events)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

end;

--------------------------------------------------------------------------
------------------ 6. АТРИБУЦИЯ СОБЫТИЙ (attributed_events) ---------------
--------------------------------------------------------------------------
-- Бизнес-смысл: для каждого события вычисляем атрибуционные визиты по
-- всем моделям: first-click, last-click, last non-direct, last marked и
-- linear. Синтетические визиты участвуют наравне с веб-визитами: за счёт
-- timestamp «минус 1 мс» синтетика встаёт в цепочку касаний ПЕРЕД своим
-- конверсионным событием. Результат пишем в таблицу attributed_events,
-- из которой потом строятся orders и deals.
-- Атомарность: один create or replace, промежуточных состояний нет.

begin

declare query string;
declare query_template string;

set query_template = """
create or replace table `<project_name>.<dataset_name>.attributed_events`
partition by date options (require_partition_filter = false) as (
-- Подготовка всех событий: присоединяем классификацию визитов.
with all_events as (
  select
    e.timestamp,
    e.visit_id,
    v.non_direct_visit_id,
    v.marked_visit_id,
    e.event_id,
    e.event_name,
    e.event_params,
    e.user_data,
    e.user_properties,
    e.user_external_ids,
    e.profile_id,
    e.strimix_avid,
    e.ad_data,
    e.deal,
    e.offers,
    e.order,
    e.products,
    e.transaction,
    e.geo,
    e.device_info,
    e.is_test_event
  from `identified_events_with_visits` as e
  left join `<project_name>.<dataset_name>.visits` as v
  on e.event_id = v.first_event_id
), 

-- Считаем first-click и last-click атрибуционные визиты для каждого события.
all_events_attributed_by_first_and_last_click as (
    select
        timestamp,
        event_id,
        event_name,
        event_params,
        user_data,
        user_properties,
        user_external_ids,
        profile_id,
        strimix_avid,
        ad_data,  
        deal,
        offers,
        `order`,
        products,
        transaction,
        geo,
        device_info,
        visit_id,
        first_value(visit_id ignore nulls) 
            over (partition by profile_id order by timestamp asc rows between unbounded preceding and current row)
        as first_attr_visit,
        last_value(visit_id ignore nulls) 
            over (partition by profile_id order by timestamp asc rows between unbounded preceding and current row)
        as last_attr_visit,
        last_value(non_direct_visit_id ignore nulls) 
            over (partition by profile_id order by timestamp asc rows between unbounded preceding and current row)
        as last_non_direct_attr_visit,
        last_value(marked_visit_id ignore nulls) 
            over (partition by profile_id order by timestamp asc rows between unbounded preceding and current row)
        as last_marked_attr_visit,
        null as linear_attr_visits,
        is_test_event
    from all_events
),

----------------------------------------
-- Линейная атрибуция: доли визитов ----
----------------------------------------

-- Непрямые атрибуционные визиты.
indirect_visits as (
  select
    t1.timestamp,
    t1.profile_id,
    t1.visit_id
  from `<project_name>.<dataset_name>.visits` as t1
  where source not like '(direct)'
),

-- Прямые атрибуционные визиты.
direct_visits as (
  select
    t1.timestamp,
    t1.profile_id,
    t1.visit_id
  from `<project_name>.<dataset_name>.visits` as t1
  where
    t1.source like '(direct)'
    -- Исключаем профили, у которых до этого были непрямые визиты.
    and (
      select count(t2.visit_id) 
      from `<project_name>.<dataset_name>.visits` as t2
      where
        t2.profile_id = t1.profile_id
        and t2.source not like '(direct)'
        and t2.timestamp < t1.timestamp
    ) = 0
),

-- Объединяем атрибуционные визиты.
visits_log as (
  select * from indirect_visits
  union all select * from direct_visits
),

-- Прикрепляем атрибуционные визиты к каждому событию.
visits_lin_attr_events as (
  select
    t1.timestamp,
    t1.profile_id,
    t1.event_id,
    t1.event_name,
    array_agg(struct(t2.timestamp as timestamp, t2.visit_id as visit_id) ignore nulls order by t2.timestamp asc) as lin_attr_visits
  from all_events as t1
  left join visits_log as t2
  on t1.profile_id = t2.profile_id
  and t2.timestamp <= t1.timestamp
  group by t1.timestamp, t1.profile_id, t1.event_id, t1.event_name
  order by t1.timestamp asc
),

-- Считаем долю линейной атрибуции каждого визита (1 / число визитов).
visits_lin_attr_rates as (
  select
    timestamp,
    profile_id,
    event_id,
    event_name,
    array(
      select as struct 
        p.timestamp, 
        p.visit_id,
        round((1 / count(distinct p.visit_id) over()), 3) as lin_attr_rate
      from unnest(lin_attr_visits) as p
      where p.visit_id is not null
      order by timestamp asc
    ) as visits_lin_attr_rates
  from visits_lin_attr_events
)

-- Объединяем доли линейной атрибуции с событиями.
select
  extract(date from timestamp_millis(t1.timestamp) at time zone <project_timezone>) date,
  t1.timestamp,
  t1.visit_id,
  t1.event_id,
  t1.event_name,
  t1.event_params,
  t1.user_data,
  t1.user_properties,
  t1.user_external_ids,
  t1.profile_id,
  t1.strimix_avid,
  t1.ad_data,
  t1.deal,
  t1.offers,
  t1.order,
  t1.products,
  t1.transaction,
  t1.geo,
  t1.device_info,
  t1.first_attr_visit,
  t1.last_attr_visit,
  ifnull(t1.last_non_direct_attr_visit, t1.last_attr_visit) last_non_direct_attr_visit,
  ifnull(t1.last_marked_attr_visit, ifnull(t1.last_non_direct_attr_visit, t1.last_attr_visit)) last_marked_attr_visit,
  t3.visits_lin_attr_rates as linear_attr_visits,
  t1.is_test_event
from all_events_attributed_by_first_and_last_click as t1
left join visits_lin_attr_rates as t3
on t1.event_id = t3.event_id)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);
set query = replace(query, '<project_timezone>', _project_timezone);

execute immediate (query);

end;

-------------------------------------------
--------- 7. ТАБЛИЦА ЗАКАЗОВ (orders) -----
-------------------------------------------
-- Бизнес-смысл: заказ собираем из всех его событий по принципу
-- «состояние = последнее событие»: каждое поле берём через last_value.
-- Атрибуцию заказа фиксируем по ПЕРВОМУ его событию (создание): к этому
-- моменту уже известна вся цепочка касаний, включая синтетические визиты,
-- которые за счёт «минус 1 мс» стоят перед созданием заказа.
-- Атомарность: один create or replace.

begin

declare query string;
declare query_template string;

set query_template = """
create or replace table `<project_name>.<dataset_name>.orders`
partition by date options (require_partition_filter = false) as(
with all_orders_events as (
  select
    timestamp,
    event_id,
    profile_id,
    `order`,
    products,
    -- Атрибуцию источника заказа берём из первого события заказа.
    if(timestamp = min(timestamp) over (partition by profile_id, `order`.id order by timestamp asc rows between unbounded preceding and unbounded following), first_attr_visit, null) first_attr_visit,
    if(timestamp = min(timestamp) over (partition by profile_id, `order`.id order by timestamp asc rows between unbounded preceding and unbounded following), last_attr_visit, null) last_attr_visit,
    if(timestamp = min(timestamp) over (partition by profile_id, `order`.id order by timestamp asc rows between unbounded preceding and unbounded following), last_non_direct_attr_visit, null) last_non_direct_attr_visit,
    if(timestamp = min(timestamp) over (partition by profile_id, `order`.id order by timestamp asc rows between unbounded preceding and unbounded following), last_marked_attr_visit, null) last_marked_attr_visit,
    if(timestamp = min(timestamp) over (partition by profile_id, `order`.id order by timestamp asc rows between unbounded preceding and unbounded following), linear_attr_visits, null) linear_attr_visits,
    if(timestamp = min(timestamp) over (partition by profile_id, `order`.id order by timestamp asc rows between unbounded preceding and unbounded following), event_id, null) attribution_event_id,
    last_value(event_id) over(partition by `order`.id order by timestamp asc rows between unbounded preceding and unbounded following) last_event_id
  from `<project_name>.<dataset_name>.attributed_events` where `order`.id is not null
), 

orders_last_info_ungroupped as (
  select
    `order`.id as id,
    last_value(profile_id) over(partition by `order`.id order by timestamp asc rows between unbounded preceding and unbounded following) _profile_id,
    last_value(`order`.status) over(partition by `order`.id order by timestamp asc rows between unbounded preceding and unbounded following) as status,
    last_value(`order`.manager) over(partition by `order`.id order by timestamp asc rows between unbounded preceding and unbounded following) as manager,
    last_value(`order`.value) over(partition by `order`.id order by timestamp asc rows between unbounded preceding and unbounded following) as value,
    last_value(`order`.paid_value) over(partition by `order`.id order by timestamp asc rows between unbounded preceding and unbounded following) as paid_value,
    last_value(`order`.refund_value) over(partition by `order`.id order by timestamp asc rows between unbounded preceding and unbounded following) as refund_value,
    last_value(`order`.currency) over(partition by `order`.id order by timestamp asc rows between unbounded preceding and unbounded following) as currency,
    last_value(`order`.shipping) over(partition by `order`.id order by timestamp asc rows between unbounded preceding and unbounded following) as shipping,
    last_value(`order`.tax) over(partition by `order`.id order by timestamp asc rows between unbounded preceding and unbounded following) as tax,
    last_value(`order`.promo_action) over(partition by `order`.id order by timestamp asc rows between unbounded preceding and unbounded following) as promo_action,
    last_value(`order`.discount_amount) over(partition by `order`.id order by timestamp asc rows between unbounded preceding and unbounded following) as discount_amount,
    last_value(`order`.discount_percentage) over(partition by `order`.id order by timestamp asc rows between unbounded preceding and unbounded following) as discount_percentage,
    last_value(`order`.payment_method) over(partition by `order`.id order by timestamp asc rows between unbounded preceding and unbounded following) as payment_method,
    min(timestamp) over (partition by `order`.id order by timestamp asc rows between unbounded preceding and unbounded following) creation_timestamp,
    max(timestamp) over (partition by `order`.id order by timestamp asc rows between unbounded preceding and unbounded following) last_update_timestamp
  from all_orders_events
  group by 
    event_id, 
    id, 
    profile_id, 
    `order`.status, 
    `order`.manager, 
    `order`.value, 
    `order`.paid_value, 
    `order`.refund_value,
    `order`.currency, 
    `order`.shipping,
    `order`.tax,
    `order`.promo_action, 
    `order`.discount_amount, 
    `order`.discount_percentage, 
    `order`.payment_method, 
    timestamp
),

orders_last_info_groupped as (
  select
    id,
    _profile_id profile_id, 
    status,
    manager,
    value,
    paid_value,
    refund_value,
    currency,
    shipping,
    tax,
    promo_action,
    discount_amount,
    discount_percentage,
    payment_method,
    creation_timestamp,
    last_update_timestamp
  from orders_last_info_ungroupped
  group by 
    id,
    profile_id, 
    status, 
    manager, 
    value, 
    paid_value,
    refund_value, 
    currency, 
    shipping,
    tax,
    promo_action, 
    discount_amount, 
    discount_percentage, 
    payment_method, 
    creation_timestamp,
    last_update_timestamp
),

orders_last_info_with_single_attribution_ungroupped as (
  select
    t1.id,
    t1.profile_id, 
    last_value(t2.first_attr_visit ignore nulls) over(partition by t2.order.id order by t2.timestamp asc rows between unbounded preceding and unbounded following) as first_attr_visit,
    last_value(t2.last_attr_visit ignore nulls) over(partition by t2.order.id order by t2.timestamp asc rows between unbounded preceding and unbounded following) as last_attr_visit,
    last_value(t2.last_non_direct_attr_visit ignore nulls) over(partition by t2.order.id order by t2.timestamp asc rows between unbounded preceding and unbounded following) as last_non_direct_attr_visit,
    last_value(t2.last_marked_attr_visit ignore nulls) over(partition by t2.order.id order by t2.timestamp asc rows between unbounded preceding and unbounded following) as last_marked_attr_visit,
    t1.status,
    t1.manager,
    t1.value,
    t1.paid_value,
    t1.refund_value,
    t1.currency,
    t1.shipping,
    t1.tax,
    t1.promo_action,
    t1.discount_amount,
    t1.discount_percentage,
    t1.payment_method,
    t1.creation_timestamp,
    t1.last_update_timestamp,
    t2.last_event_id,
    last_value(t2.attribution_event_id ignore nulls) over(partition by t2.order.id order by t2.timestamp asc rows between unbounded preceding and unbounded following) as attribution_event_id,
  from orders_last_info_groupped t1
  left join all_orders_events t2
  on t1.id = t2.order.id
),

orders_last_info_with_single_attribution_groupped as (
  select
    id,
    profile_id, 
    first_attr_visit,
    last_attr_visit,
    last_non_direct_attr_visit,
    last_marked_attr_visit,
    status,
    manager,
    value,
    paid_value,
    refund_value,
    currency,
    shipping,
    tax,
    promo_action,
    discount_amount,
    discount_percentage,
    payment_method,
    creation_timestamp,
    last_update_timestamp,
    attribution_event_id,
    last_event_id
  from orders_last_info_with_single_attribution_ungroupped
  group by
    id,
    profile_id, 
    first_attr_visit,
    last_attr_visit,
    last_non_direct_attr_visit,
    last_marked_attr_visit,
    status,
    manager,
    value,
    paid_value,
    refund_value,
    currency,
    shipping,
    tax,
    promo_action,
    discount_amount,
    discount_percentage,
    payment_method,
    creation_timestamp,
    last_update_timestamp,
    attribution_event_id,
    last_event_id
),

orders_result as (
  select
    extract(date from timestamp_millis(t1.creation_timestamp) at time zone <project_timezone>) date,
    t1.id,
    t1.profile_id,
    case when
        -- Если это первый заказ профиля
        first_value(t1.id) over(partition by t1.profile_id order by t1.creation_timestamp asc rows between unbounded preceding and current row) = t1.id
        then true
        else false end is_first_order,
    case when
        -- Если это первый заказ профиля
        (first_value(t1.id) over(partition by t1.profile_id order by t1.creation_timestamp asc rows between unbounded preceding and current row) = t1.id
        -- Или не первый, но оплаченных заказов до него не было
        or (select count(distinct t3.id) from orders_last_info_with_single_attribution_groupped t3 where t3.profile_id = t1.profile_id and t3.paid_value > 0 and t3.creation_timestamp < t1.creation_timestamp) = 0)
        and t1.paid_value > 0
        then true
        else false end is_first_paid_order,
    t1.first_attr_visit, 
    t1.last_attr_visit, 
    t1.last_non_direct_attr_visit, 
    t1.last_marked_attr_visit,
    t2.linear_attr_visits,
    t1.status,
    t1.manager,
    t1.value,
    t1.paid_value,
    t1.refund_value,
    t1.currency,
    t1.shipping,
    t1.tax,
    t1.promo_action,
    t1.discount_amount,
    t1.discount_percentage,
    t1.payment_method,
    (select it.products from all_orders_events it where it.event_id = t1.last_event_id) products,
    (select it.`order`.custom_params from all_orders_events it where it.event_id = t1.last_event_id) custom_params,
    t1.creation_timestamp,
    t1.last_update_timestamp,
  from orders_last_info_with_single_attribution_groupped as t1
  left join all_orders_events as t2
  on t1.attribution_event_id = t2.event_id
)

select
  t1.date,
  t1.id,
  t1.profile_id,
  t1.is_first_order,
  t1.is_first_paid_order,
  t1.first_attr_visit,
  t1.last_attr_visit,
  t1.last_non_direct_attr_visit,
  t1.last_marked_attr_visit,
  t1.linear_attr_visits,
  t1.status,
  t1.manager,
  t1.value,
  t1.paid_value,
  t1.refund_value,
  t1.currency,
  t1.shipping,
  t1.tax,
  t1.promo_action,
  t1.discount_amount,
  t1.discount_percentage,
  t1.payment_method,
  t1.products,
  array_concat(
    custom_params,
    [
      struct( 
        'order_source' as key,
        struct(
          if(t2.visit_id is null, '(not found)', t2.source) as string_value,
          cast(null as int64) as int_value,
          cast(null as float64) as  double_value,
          cast(null as bool) as boolean_value
        ) as value
      ),
      struct( 
        'order_medium' as key,
        struct(
          if(t2.visit_id is null, '(not found)', t2.medium) as string_value,
          cast(null as int64) as int_value,
          cast(null as float64) as  double_value,
          cast(null as bool) as boolean_value
        ) as value
      ),
      struct( 
        'order_campaign' as key,
        struct(
          if(t2.visit_id is null, '(not found)', t2.campaign) as string_value,
          cast(null as int64) as int_value,
          cast(null as float64) as  double_value,
          cast(null as bool) as boolean_value
        ) as value
      ),
      struct( 
        'order_content' as key,
        struct(
          if(t2.visit_id is null, '(not found)', t2.content) as string_value,
          cast(null as int64) as int_value,
          cast(null as float64) as  double_value,
          cast(null as bool) as boolean_value
        ) as value
      ),
      struct( 
        'order_term' as key,
        struct(
          if(t2.visit_id is null, '(not found)', t2.term) as string_value,
          cast(null as int64) as int_value,
          cast(null as float64) as  double_value,
          cast(null as bool) as boolean_value
        ) as value
      ),
      struct( 
        'order_fbclid' as key,
        struct(
          if((select vp.value.string_value from unnest(t2.url_params) vp where vp.key = 'fbclid') is null, '(not found)', (select vp.value.string_value from unnest(t2.url_params) vp where vp.key = 'fbclid')) as string_value,
          cast(null as int64) as int_value,
          cast(null as float64) as  double_value,
          cast(null as bool) as boolean_value
        ) as value
      )
    ]
  ) as custom_params,
  t1.creation_timestamp,
  t1.last_update_timestamp
from orders_result t1
left join `<project_name>.<dataset_name>.visits` t2
on t1.last_marked_attr_visit = t2.visit_id
)
""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);
set query = replace(query, '<project_timezone>', _project_timezone);

execute immediate (query);

end;

------------------------------------------
--------- 8. ТАБЛИЦА СДЕЛОК (deals) ------
------------------------------------------
-- Бизнес-смысл: аналогично заказам. Состояние сделки берём из последнего
-- события, атрибуцию фиксируем по первому (создание сделки).
-- Атомарность: один create or replace.

begin

declare query string;
declare query_template string;

set query_template = """
create or replace table `<project_name>.<dataset_name>.deals`
partition by date options (require_partition_filter = false) as(
with all_deals_events as (
  select
    timestamp,
    event_id,
    deal,
    profile_id,
    -- Атрибуцию источника сделки берём из первого события сделки.
    if(timestamp = min(timestamp) over (partition by profile_id, deal.id order by timestamp asc rows between unbounded preceding and unbounded following), first_attr_visit, null) first_attr_visit,
    if(timestamp = min(timestamp) over (partition by profile_id, deal.id order by timestamp asc rows between unbounded preceding and unbounded following), last_attr_visit, null) last_attr_visit,
    if(timestamp = min(timestamp) over (partition by profile_id, deal.id order by timestamp asc rows between unbounded preceding and unbounded following), last_non_direct_attr_visit, null) last_non_direct_attr_visit,
    if(timestamp = min(timestamp) over (partition by profile_id, deal.id order by timestamp asc rows between unbounded preceding and unbounded following), last_marked_attr_visit, null) last_marked_attr_visit,
    if(timestamp = min(timestamp) over (partition by profile_id, deal.id order by timestamp asc rows between unbounded preceding and unbounded following), linear_attr_visits, null) linear_attr_visits,
    if(timestamp = min(timestamp) over (partition by profile_id, deal.id order by timestamp asc rows between unbounded preceding and unbounded following), event_id, null) attribution_event_id,
    last_value(event_id) over(partition by deal.id order by timestamp asc rows between unbounded preceding and unbounded following) last_event_id
  from `<project_name>.<dataset_name>.attributed_events` where deal.id is not null
), 

deals_last_info_ungroupped as (
  select
    deal.id as id,
    last_value(profile_id) over(partition by deal.id order by timestamp asc rows between unbounded preceding and unbounded following) _profile_id,
    last_value(deal.status) over(partition by deal.id order by timestamp asc rows between unbounded preceding and unbounded following) as status,
    last_value(deal.manager) over(partition by deal.id order by timestamp asc rows between unbounded preceding and unbounded following) as manager,
    last_value(deal.value) over(partition by deal.id order by timestamp asc rows between unbounded preceding and unbounded following) as value,
    last_value(deal.paid_value) over(partition by deal.id order by timestamp asc rows between unbounded preceding and unbounded following) as paid_value,
    last_value(deal.refund_value) over(partition by deal.id order by timestamp asc rows between unbounded preceding and unbounded following) as refund_value,
    last_value(deal.currency) over(partition by deal.id order by timestamp asc rows between unbounded preceding and unbounded following) as currency,
    last_value(deal.promo_action) over(partition by deal.id order by timestamp asc rows between unbounded preceding and unbounded following) as promo_action,
    last_value(deal.discount_amount) over(partition by deal.id order by timestamp asc rows between unbounded preceding and unbounded following) as discount_amount,
    last_value(deal.discount_percentage) over(partition by deal.id order by timestamp asc rows between unbounded preceding and unbounded following) as discount_percentage,
    last_value(deal.payment_method) over(partition by deal.id order by timestamp asc rows between unbounded preceding and unbounded following) as payment_method,
    min(timestamp) over (partition by deal.id order by timestamp asc rows between unbounded preceding and unbounded following) creation_timestamp,
    max(timestamp) over (partition by deal.id order by timestamp asc rows between unbounded preceding and unbounded following) last_update_timestamp
  from all_deals_events
  group by 
    event_id, 
    id, 
    profile_id, 
    deal.status, 
    deal.manager, 
    deal.value, 
    deal.paid_value, 
    deal.refund_value,
    deal.currency, 
    deal.promo_action, 
    deal.discount_amount, 
    deal.discount_percentage, 
    deal.payment_method,
    timestamp
),

deals_last_info_groupped as (
  select
    id,
    _profile_id profile_id, 
    status,
    manager,
    value,
    paid_value,
    refund_value,
    currency,
    promo_action,
    discount_amount,
    discount_percentage,
    payment_method,
    creation_timestamp,
    last_update_timestamp
  from deals_last_info_ungroupped
  group by 
    id,
    profile_id, 
    status, 
    manager, 
    value, 
    paid_value, 
    refund_value,
    currency, 
    promo_action, 
    discount_amount, 
    discount_percentage, 
    payment_method, 
    creation_timestamp,
    last_update_timestamp
),

deals_last_info_with_single_attribution_ungroupped as (
  select
    t1.id,
    t1.profile_id, 
    last_value(t2.first_attr_visit ignore nulls) over(partition by t2.deal.id order by t2.timestamp asc rows between unbounded preceding and unbounded following) as first_attr_visit,
    last_value(t2.last_attr_visit ignore nulls) over(partition by t2.deal.id order by t2.timestamp asc rows between unbounded preceding and unbounded following) as last_attr_visit,
    last_value(t2.last_non_direct_attr_visit ignore nulls) over(partition by t2.deal.id order by t2.timestamp asc rows between unbounded preceding and unbounded following) as last_non_direct_attr_visit,
    last_value(t2.last_marked_attr_visit ignore nulls) over(partition by t2.deal.id order by t2.timestamp asc rows between unbounded preceding and unbounded following) as last_marked_attr_visit,
    t1.status,
    t1.manager,
    t1.value,
    t1.paid_value,
    t1.refund_value,
    t1.currency,
    t1.promo_action,
    t1.discount_amount,
    t1.discount_percentage,
    t1.payment_method,
    t1.creation_timestamp,
    t1.last_update_timestamp,
    t2.last_event_id,
    last_value(t2.attribution_event_id ignore nulls) over(partition by t2.deal.id order by t2.timestamp asc rows between unbounded preceding and unbounded following) as attribution_event_id,
  from deals_last_info_groupped t1
  left join all_deals_events t2
  on t1.id = t2.deal.id
),

deals_last_info_with_single_attribution_groupped as (
  select
    id,
    profile_id, 
    first_attr_visit,
    last_attr_visit,
    last_non_direct_attr_visit,
    last_marked_attr_visit,
    status,
    manager,
    value,
    paid_value,
    refund_value,
    currency,
    promo_action,
    discount_amount,
    discount_percentage,
    payment_method,
    creation_timestamp,
    last_update_timestamp,
    attribution_event_id,
    last_event_id
  from deals_last_info_with_single_attribution_ungroupped
  group by
    id,
    profile_id, 
    first_attr_visit,
    last_attr_visit,
    last_non_direct_attr_visit,
    last_marked_attr_visit,
    status,
    manager,
    value,
    paid_value,
    refund_value,
    currency,
    promo_action,
    discount_amount,
    discount_percentage,
    payment_method,
    creation_timestamp,
    last_update_timestamp,
    attribution_event_id,
    last_event_id
)

select
  extract(date from timestamp_millis(t1.creation_timestamp) at time zone <project_timezone>) date,
  t1.id,
  t1.profile_id,
  t1.first_attr_visit, 
  t1.last_attr_visit, 
  t1.last_non_direct_attr_visit, 
  t1.last_marked_attr_visit,
  t2.linear_attr_visits,
  t1.status,
  t1.manager,
  t1.value,
  t1.paid_value,
  t1.refund_value,
  t1.currency,
  t1.promo_action,
  t1.discount_amount,
  t1.discount_percentage,
  t1.payment_method,
  (select it.deal.custom_params from all_deals_events it where it.event_id = t1.last_event_id) custom_params,
  t1.creation_timestamp,
  t1.last_update_timestamp,
from deals_last_info_with_single_attribution_groupped as t1
left join all_deals_events as t2
on t1.attribution_event_id = t2.event_id)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);
set query = replace(query, '<project_timezone>', _project_timezone);

execute immediate (query);

end;

--------------------------------------------------------------------------
------------------ 9. КЛАССИФИКАЦИЯ РАСХОДОВ (ad_costs) -------------------
--------------------------------------------------------------------------
-- Бизнес-смысл: строки расходов проходят те же три стадии traffic_rules,
-- что и визиты (шаг 4.3): utm -> origin -> channel, плюс нормализация
-- landing_page. Правила проекции (плейсхолдеры {campaign_name} и т.п.)
-- заполняют пустые канонические метки не-web объявлений из их собственных
-- сетевых полей.
-- Отличия от визитов:
--  - рекламные условия правил (data_source, ad_destination, сетевые
--    названия/id) проверяем напрямую по колонкам строки: зарезолвленная
--    группа не нужна, строка сама всё о себе знает;
--  - плейсхолдеры разворачиваются ПОСТРОЧНО (раздел 6 ТЗ): каждая строка
--    получает свои собственные настоящие значения. Метки строки всегда
--    истинны для этой строки; маркер '(combined)' в persist-таблицы не
--    пишется — неоднозначность бакета считает движок отчётов при чтении.
--    Склейка визита с расходами идёт через attributed_ad (ярусы id и
--    названий), а не через побайтовое совпадение меток;
--  - applies_to_web к расходам не относится (это флаг веб-визитов).
-- Кост-джобы пересобирают строки без меток классификации, поэтому джоба
-- переклассифицирует всю таблицу целиком на каждом прогоне. Так результат
-- всегда соответствует актуальным правилам.
-- Атомарность: стадии работают по временным таблицам, пользовательская
-- таблица ad_costs заменяется ОДНИМ create or replace в самом конце.

begin

declare query string;
declare query_template string;
declare excluded_url_param_patterns array<string>;

-- Читаем активные паттерны конфиг-таблицы excluded_url_params как МАССИВ: эти
-- трекинговые query-параметры (gclid, fbclid, utm_* и т.п.) вырезаются при
-- нормализации landing_page. Загрузка, фильтр и порядок совпадают с ветвью
-- визитов; паттерны передаются параметром через execute immediate ... using,
-- а не подстановкой в текст запроса.
set query_template = """
select ifnull(array_agg(param_key_regex order by param_id), [])
from `<project_name>.<dataset_name>.excluded_url_params`
where is_active = true
and param_key_regex is not null
and trim(param_key_regex) != ''""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query) into excluded_url_param_patterns;

-- Гарантируем наличие колонок классификации на ad_costs (миграция
-- проектов, созданных до этой функциональности; для новых проектов
-- операция no-op благодаря if not exists).
set query_template = """
alter table `<project_name>.<dataset_name>.ad_costs`
add column if not exists traffic_origin string,
add column if not exists traffic_channel string,
add column if not exists landing_page string""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

-- Присваиваем строкам стабильные суррогатные id: у ad_costs нет
-- естественного ключа (одна и та же реклама может иметь несколько строк за
-- день), а join-ы стадий правил должны возвращать результат ровно той
-- строке, с которой матчились условия.
set query_template = """
create temp table `ad_costs_with_row_id` as (
  select *, generate_uuid() as _row_id
  from `<project_name>.<dataset_name>.ad_costs`
)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

-- Стадия utm. Техника: собираем совпавшие пары «строка × правило».
-- Условия по каноническим меткам проверяем на исходном состоянии строки
-- (внутристадийного каскада нет). Рекламные условия проверяем напрямую по
-- колонкам строки расходов. Правило проекции срабатывает по схеме
-- «всё или ничего»: только на строки, у которых все пять канонических
-- меток пусты. Плейсхолдеры разворачиваются построчно значениями сетевых
-- колонок самой строки, каждое поле разыгрывается независимо по priority.
-- Это ровно та же пометочная семантика, что у визитов на шаге 4.3.
set query_template = """
create temp table `ad_costs_utm_rewritten` as (
with utm_rules as (
  select
    r.*,
    -- Правило считаем проекцией, если хотя бы один выход содержит плейсхолдер.
    (has_placeholders(r.set_source) or has_placeholders(r.set_medium)
      or has_placeholders(r.set_campaign) or has_placeholders(r.set_content)
      or has_placeholders(r.set_term) or has_placeholders(r.set_strimix_refid)) as is_projection
  from `<project_name>.<dataset_name>.traffic_rules` as r
  where r.is_active = true
  and r.stage = 'utm'
  and r.target in ('ad_cost', 'both')
  -- Условие channel-стадии на стадии utm не имеет смысла.
  and r.traffic_origin_regex is null
  and (r.set_source is not null or r.set_medium is not null
    or r.set_campaign is not null or r.set_content is not null
    or r.set_term is not null or r.set_strimix_refid is not null)
),

matched as (
  select
    t._row_id,
    r.priority,
    -- Флаги «правило задало поле»: розыгрыш полей идёт по этим флагам, а
    -- не по развёрнутому значению. Плейсхолдер без значения даёт null, но
    -- поле всё равно считается заданным и перезаписывает исходное.
    r.set_source is not null as def_source,
    r.set_medium is not null as def_medium,
    r.set_campaign is not null as def_campaign,
    r.set_content is not null as def_content,
    r.set_term is not null as def_term,
    r.set_strimix_refid is not null as def_strimix_refid,
    -- Развёрнутые значения: литералы проходят как есть, плейсхолдеры
    -- подставляются ПОСТРОЧНО из сетевых колонок самой строки. Каждая
    -- тёзка получает своё настоящее название кампании/группы: метки строки
    -- всегда истинны для этой строки, '(combined)' не материализуется.
    apply_placeholders(r.set_source, t.data_source, t.campaign_id, t.campaign_name, t.adgroup_id, t.adgroup_name, t.ad_id, t.ad_name, t.source, t.medium, t.campaign, t.content, t.term) as val_source,
    apply_placeholders(r.set_medium, t.data_source, t.campaign_id, t.campaign_name, t.adgroup_id, t.adgroup_name, t.ad_id, t.ad_name, t.source, t.medium, t.campaign, t.content, t.term) as val_medium,
    apply_placeholders(r.set_campaign, t.data_source, t.campaign_id, t.campaign_name, t.adgroup_id, t.adgroup_name, t.ad_id, t.ad_name, t.source, t.medium, t.campaign, t.content, t.term) as val_campaign,
    apply_placeholders(r.set_content, t.data_source, t.campaign_id, t.campaign_name, t.adgroup_id, t.adgroup_name, t.ad_id, t.ad_name, t.source, t.medium, t.campaign, t.content, t.term) as val_content,
    apply_placeholders(r.set_term, t.data_source, t.campaign_id, t.campaign_name, t.adgroup_id, t.adgroup_name, t.ad_id, t.ad_name, t.source, t.medium, t.campaign, t.content, t.term) as val_term,
    apply_placeholders(r.set_strimix_refid, t.data_source, t.campaign_id, t.campaign_name, t.adgroup_id, t.adgroup_name, t.ad_id, t.ad_name, t.source, t.medium, t.campaign, t.content, t.term) as val_strimix_refid
  from `ad_costs_with_row_id` as t
  inner join utm_rules as r
  -- Условия по каноническим меткам проверяем на исходном состоянии строки
  -- (внутристадийного каскада нет, как и у визитов).
  on (r.source_regex is null or regexp_contains(ifnull(t.source, ''), r.source_regex))
  and (r.medium_regex is null or regexp_contains(ifnull(t.medium, ''), r.medium_regex))
  and (r.campaign_regex is null or regexp_contains(ifnull(t.campaign, ''), r.campaign_regex))
  and (r.content_regex is null or regexp_contains(ifnull(t.content, ''), r.content_regex))
  and (r.term_regex is null or regexp_contains(ifnull(t.term, ''), r.term_regex))
  and (r.strimix_refid_regex is null or regexp_contains(ifnull(t.strimix_refid, ''), r.strimix_refid_regex))
  -- Рекламные условия проверяем напрямую по колонкам строки расходов.
  and (r.data_source_regex is null or regexp_contains(ifnull(t.data_source, ''), r.data_source_regex))
  and (r.campaign_id_regex is null or regexp_contains(ifnull(t.campaign_id, ''), r.campaign_id_regex))
  and (r.campaign_name_regex is null or regexp_contains(ifnull(t.campaign_name, ''), r.campaign_name_regex))
  and (r.adgroup_id_regex is null or regexp_contains(ifnull(t.adgroup_id, ''), r.adgroup_id_regex))
  and (r.adgroup_name_regex is null or regexp_contains(ifnull(t.adgroup_name, ''), r.adgroup_name_regex))
  and (r.ad_id_regex is null or regexp_contains(ifnull(t.ad_id, ''), r.ad_id_regex))
  and (r.ad_name_regex is null or regexp_contains(ifnull(t.ad_name, ''), r.ad_name_regex))
  and (r.ad_destination_regex is null or regexp_contains(ifnull(t.ad_destination, ''), r.ad_destination_regex))
  -- «Всё или ничего» для правил проекции: UTM, прописанные таргетологом в
  -- трекинге объявления, неприкосновенны. Проекция срабатывает только на
  -- строки, где все пять канонических меток пусты; частично прописанные
  -- UTM не смешиваются с названиями из кабинета.
  and (r.is_projection = false or coalesce(
    nullif(trim(t.source), ''), nullif(trim(t.medium), ''),
    nullif(trim(t.campaign), ''), nullif(trim(t.content), ''),
    nullif(trim(t.term), '')) is null)
  -- Условие по url_params (фактические параметры landing_page_url). Живёт
  -- в where, а не в on: BigQuery не разрешает exists-подзапрос в
  -- join-предикате, а для inner join where эквивалентен on.
  where (r.url_param_key is null or exists (
    select 1 from unnest(t.url_params) as up
    where up.key = r.url_param_key
    and regexp_contains(ifnull(up.value.string_value, ''), ifnull(r.url_param_value_regex, ''))
  ))
),

-- Розыгрыш по полям: для каждого поля берём значение из первого по
-- priority правила, задавшего его. Обёртка в struct отличает «поле никто
-- не задал» (null-структ → остаётся исходное значение) от «правило задало
-- null» (плейсхолдер без значения → поле перезаписывается в null).
winners as (
  select
    _row_id,
    array_agg(if(def_source, struct(val_source as v), null) ignore nulls order by priority asc limit 1)[safe_offset(0)] as w_source,
    array_agg(if(def_medium, struct(val_medium as v), null) ignore nulls order by priority asc limit 1)[safe_offset(0)] as w_medium,
    array_agg(if(def_campaign, struct(val_campaign as v), null) ignore nulls order by priority asc limit 1)[safe_offset(0)] as w_campaign,
    array_agg(if(def_content, struct(val_content as v), null) ignore nulls order by priority asc limit 1)[safe_offset(0)] as w_content,
    array_agg(if(def_term, struct(val_term as v), null) ignore nulls order by priority asc limit 1)[safe_offset(0)] as w_term,
    array_agg(if(def_strimix_refid, struct(val_strimix_refid as v), null) ignore nulls order by priority asc limit 1)[safe_offset(0)] as w_strimix_refid
  from matched
  group by _row_id
)

select
  t.* replace(
    if(w.w_source is null, t.source, w.w_source.v) as source,
    if(w.w_medium is null, t.medium, w.w_medium.v) as medium,
    if(w.w_campaign is null, t.campaign, w.w_campaign.v) as campaign,
    if(w.w_content is null, t.content, w.w_content.v) as content,
    if(w.w_term is null, t.term, w.w_term.v) as term,
    if(w.w_strimix_refid is null, t.strimix_refid, w.w_strimix_refid.v) as strimix_refid
  )
from `ad_costs_with_row_id` as t
left join winners as w on w._row_id = t._row_id
)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

-- Стадия origin: traffic_origin берём из первого совпавшего правила
-- (priority asc). Условия по меткам видят УЖЕ переписанные utm-стадией
-- значения (межстадийный каскад): спроецированный source='facebook_ads'
-- ловится origin-сидом по имени сети. Если ни одно правило не совпало,
-- подставляем фолбэк: '(direct)' → 'Direct', пустой source → 'Unknown',
-- иначе сам source.
set query_template = """
create temp table `ad_costs_with_origin` as (
  select
    a.* except(traffic_origin),
    coalesce(
      m.traffic_origin,
      case
        when a.source = '(direct)' then 'Direct'
        when a.source is null then 'Unknown'
        else a.source end
    ) as traffic_origin
  from `ad_costs_utm_rewritten` as a
  left join (
    select
      t._row_id,
      array_agg(r.set_traffic_origin order by r.priority asc limit 1)[offset(0)] as traffic_origin
    from `ad_costs_utm_rewritten` as t
    inner join `<project_name>.<dataset_name>.traffic_rules` as r
    on r.is_active = true
    and r.stage = 'origin'
    and r.target in ('ad_cost', 'both')
    -- Условие channel-стадии на стадии origin не имеет смысла.
    and r.traffic_origin_regex is null
    and (r.source_regex is null or regexp_contains(ifnull(t.source, ''), r.source_regex))
    and (r.medium_regex is null or regexp_contains(ifnull(t.medium, ''), r.medium_regex))
    and (r.campaign_regex is null or regexp_contains(ifnull(t.campaign, ''), r.campaign_regex))
    and (r.content_regex is null or regexp_contains(ifnull(t.content, ''), r.content_regex))
    and (r.term_regex is null or regexp_contains(ifnull(t.term, ''), r.term_regex))
    and (r.strimix_refid_regex is null or regexp_contains(ifnull(t.strimix_refid, ''), r.strimix_refid_regex))
    -- Рекламные условия проверяем напрямую по колонкам строки расходов.
    and (r.data_source_regex is null or regexp_contains(ifnull(t.data_source, ''), r.data_source_regex))
    and (r.campaign_id_regex is null or regexp_contains(ifnull(t.campaign_id, ''), r.campaign_id_regex))
    and (r.campaign_name_regex is null or regexp_contains(ifnull(t.campaign_name, ''), r.campaign_name_regex))
    and (r.adgroup_id_regex is null or regexp_contains(ifnull(t.adgroup_id, ''), r.adgroup_id_regex))
    and (r.adgroup_name_regex is null or regexp_contains(ifnull(t.adgroup_name, ''), r.adgroup_name_regex))
    and (r.ad_id_regex is null or regexp_contains(ifnull(t.ad_id, ''), r.ad_id_regex))
    and (r.ad_name_regex is null or regexp_contains(ifnull(t.ad_name, ''), r.ad_name_regex))
    and (r.ad_destination_regex is null or regexp_contains(ifnull(t.ad_destination, ''), r.ad_destination_regex))
    where r.set_traffic_origin is not null
    -- Условие по url_params живёт в where, а не в on: BigQuery не разрешает
    -- exists-подзапрос в join-предикате; для inner join where эквивалентен on.
    and (r.url_param_key is null or exists (
      select 1 from unnest(t.url_params) as up
      where up.key = r.url_param_key
      and regexp_contains(ifnull(up.value.string_value, ''), ifnull(r.url_param_value_regex, ''))
    ))
    group by t._row_id
  ) as m
  on a._row_id = m._row_id
)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

-- Стадия channel и финальная АТОМАРНАЯ запись пользовательской таблицы.
-- traffic_channel берём из первого совпавшего правила (оно может опираться
-- на уже вычисленный traffic_origin через traffic_origin_regex:
-- межстадийный каскад). Если ни одно правило не совпало, подставляем
-- 'Other'. Здесь же считаем нормализованный landing_page. Полностью
-- готовый результат одним create or replace заменяет ad_costs: отчёты
-- никогда не видят промежуточное состояние.
set query_template = """
create or replace table `<project_name>.<dataset_name>.ad_costs`
partition by date options (require_partition_filter = false) as (
  select
    a.* except(_row_id, traffic_channel) replace(
      -- Нормализованный лендинг: "host/path?query" в нижнем регистре, без
      -- протокола, "www." и хвостового слэша. Трекинговые query-параметры
      -- (из конфиг-таблицы excluded_url_params) вырезаются, функциональные
      -- (категория, товар...) остаются и сортируются по ключу, чтобы
      -- порядок параметров не дробил строки отчёта. Имя и нормализация
      -- общие с visits.landing_page: объединённые отчёты разбивают рекламу
      -- и визиты по одному ключу и показывают «не считаемые» лендинги.
      -- Важно: ad_destination тут НЕ фолбэк. В нём лежат константы типа
      -- назначения (chat, web, lead_form), а не URL.
      -- Исключение проверяется по ИМЕНИ параметра (всё до первого '='),
      -- каждый активный паттерн независимо и как полное совпадение без учёта
      -- регистра — та же семантика, что у визитов и у серверного preview.
      nullif(concat(
        regexp_replace(concat(
          regexp_replace(ifnull(regexp_extract(lower(a.landing_page_url), '^(?:[a-z]+://)?([^/?#]+)'), ''), '^www[.]', ''),
          '/',
          ifnull(regexp_extract(lower(a.landing_page_url), '^(?:[a-z]+://)?[^/?#]+/([^?#]*)'), '')
        ), '/+$', ''),
        ifnull((
          select concat('?', string_agg(kv, '&' order by kv))
          from unnest(split(regexp_extract(lower(a.landing_page_url), '[?]([^#]*)'), '&')) as kv
          where kv != ''
          and not exists (
            select 1
            from unnest(@excluded_url_param_patterns) as excluded_url_param_pattern
            where regexp_contains(
              regexp_extract(kv, r'^[^=]*'),
              concat('(?i)^(?:', excluded_url_param_pattern, r')$')
            )
          )
        ), '')
      ), '') as landing_page
    ),
    coalesce(m.traffic_channel, 'Other') as traffic_channel
  from `ad_costs_with_origin` as a
  left join (
    select
      t._row_id,
      array_agg(r.set_traffic_channel order by r.priority asc limit 1)[offset(0)] as traffic_channel
    from `ad_costs_with_origin` as t
    inner join `<project_name>.<dataset_name>.traffic_rules` as r
    on r.is_active = true
    and r.stage = 'channel'
    and r.target in ('ad_cost', 'both')
    and (r.source_regex is null or regexp_contains(ifnull(t.source, ''), r.source_regex))
    and (r.medium_regex is null or regexp_contains(ifnull(t.medium, ''), r.medium_regex))
    and (r.campaign_regex is null or regexp_contains(ifnull(t.campaign, ''), r.campaign_regex))
    and (r.content_regex is null or regexp_contains(ifnull(t.content, ''), r.content_regex))
    and (r.term_regex is null or regexp_contains(ifnull(t.term, ''), r.term_regex))
    and (r.strimix_refid_regex is null or regexp_contains(ifnull(t.strimix_refid, ''), r.strimix_refid_regex))
    -- Рекламные условия проверяем напрямую по колонкам строки расходов.
    and (r.data_source_regex is null or regexp_contains(ifnull(t.data_source, ''), r.data_source_regex))
    and (r.campaign_id_regex is null or regexp_contains(ifnull(t.campaign_id, ''), r.campaign_id_regex))
    and (r.campaign_name_regex is null or regexp_contains(ifnull(t.campaign_name, ''), r.campaign_name_regex))
    and (r.adgroup_id_regex is null or regexp_contains(ifnull(t.adgroup_id, ''), r.adgroup_id_regex))
    and (r.adgroup_name_regex is null or regexp_contains(ifnull(t.adgroup_name, ''), r.adgroup_name_regex))
    and (r.ad_id_regex is null or regexp_contains(ifnull(t.ad_id, ''), r.ad_id_regex))
    and (r.ad_name_regex is null or regexp_contains(ifnull(t.ad_name, ''), r.ad_name_regex))
    and (r.ad_destination_regex is null or regexp_contains(ifnull(t.ad_destination, ''), r.ad_destination_regex))
    -- Условие по уже вычисленному traffic_origin (межстадийный каскад).
    and (r.traffic_origin_regex is null or regexp_contains(ifnull(t.traffic_origin, ''), r.traffic_origin_regex))
    where r.set_traffic_channel is not null
    -- Условие по url_params живёт в where, а не в on: BigQuery не разрешает
    -- exists-подзапрос в join-предикате; для inner join where эквивалентен on.
    and (r.url_param_key is null or exists (
      select 1 from unnest(t.url_params) as up
      where up.key = r.url_param_key
      and regexp_contains(ifnull(up.value.string_value, ''), ifnull(r.url_param_value_regex, ''))
    ))
    group by t._row_id
  ) as m
  on a._row_id = m._row_id
)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

-- Паттерны исключений передаём ПАРАМЕТРОМ, а не подстановкой в текст запроса.
execute immediate (query) using excluded_url_param_patterns as excluded_url_param_patterns;

end;

--------------------------------------------------------------------------
------ 10. ВЕРДИКТ МАТЧИНГА ВИЗИТ <-> РАСХОДЫ (visits.ad_match_type) ------
--------------------------------------------------------------------------
-- Бизнес-смысл: отчёт по рекламе склеивает визиты со строками расходов
-- каскадом ярусов (strimix_refid → id рекламы → сетевые названия →
-- канонические метки). Вопрос «какой ярус съел визит» раньше решался в
-- движке отчётов цепочкой not exists по предыдущим ярусам, но BigQuery
-- инлайнит CTE в каждом месте ссылки, поэтому план запроса рос
-- экспоненциально от глубины каскада и падал с resourcesExceeded. Теперь
-- вердикт считается здесь ОДИН раз за прогон и хранится в колонке
-- visits.ad_match_type (потребитель — только отчёт по рекламе):
--   'strimix_refid' — ярус 1: целочисленный strimix_refid совпал со
--                     строкой расходов той же даты;
--   'ad_id' | 'adgroup_id' | 'campaign_id' — ярусы 2-4: однозначный id из
--                     attributed_ad (data_source — мягкий лок: id,
--                     переданный клиентом явно, может прийти без сети);
--   'ad_name' | 'adgroup_name' | 'campaign_name' — ярусы 5-7: сетевое
--                     название из attributed_ad со строгими локами
--                     data_source + ad_destination (голое имя вне одной
--                     сети и одного назначения не имеет смысла);
--   'utm_labels'    — ярус 8: полный набор канонических меток совпал
--                     побайтово (с учётом null);
--   null            — визит не матчится ни с одной строкой расходов
--                     (uncosted: органика и т.п.).
-- Условия ярусов зеркалят join-ы движка отчётов: только строки расходов с
-- click_delay=false, дата в дату. Свежесть не страдает: visits и ad_costs
-- меняются только этой джобой, значит вердикт всегда синхронен данным.
-- Шаг обязан идти ПОСЛЕ классификации ad_costs (шаг 9): ярус 8 сверяет
-- ФИНАЛЬНЫЕ канонические метки обеих сторон.

begin

declare query string;
declare query_template string;

-- Колонка добавляется заново каждый прогон: create or replace на шаге 4.3
-- пересоздаёт visits без неё.
set query_template = """
alter table `<project_name>.<dataset_name>.visits`
add column if not exists ad_match_type string""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

-- Вердикт: первый совпавший ярус на визит. Каждый ярус — маленький
-- distinct-набор visit_id, ссылки между CTE не рекурсивны, план линейный.
set query_template = """
create temp table `visit_ad_match_assignment` as (
with costs as (
  select
    date, data_source, ad_destination,
    campaign_id, campaign_name, adgroup_id, adgroup_name, ad_id, ad_name,
    source, medium, campaign, content, term, strimix_refid
  from `<project_name>.<dataset_name>.ad_costs`
  where click_delay is false
),

v as (
  select
    visit_id, date, source, medium, campaign, content, term,
    strimix_refid, attributed_ad
  from `<project_name>.<dataset_name>.visits`
),

-- Ярус 1: целочисленный strimix_refid, дата в дату.
t_refid as (
  select distinct v.visit_id
  from v
  inner join costs as a
  on a.date = v.date
  and a.strimix_refid = v.strimix_refid
  where safe_cast(v.strimix_refid as int64) is not null
),

-- Ярусы 2-4: однозначные id из attributed_ad. data_source — мягкий лок.
t_ad_id as (
  select distinct v.visit_id
  from v
  inner join costs as a
  on a.date = v.date
  and a.ad_id = v.attributed_ad.ad_id
  and (v.attributed_ad.data_source is null or v.attributed_ad.data_source = a.data_source)
),

t_adgroup_id as (
  select distinct v.visit_id
  from v
  inner join costs as a
  on a.date = v.date
  and a.adgroup_id = v.attributed_ad.adgroup_id
  and (v.attributed_ad.data_source is null or v.attributed_ad.data_source = a.data_source)
),

t_campaign_id as (
  select distinct v.visit_id
  from v
  inner join costs as a
  on a.date = v.date
  and a.campaign_id = v.attributed_ad.campaign_id
  and (v.attributed_ad.data_source is null or v.attributed_ad.data_source = a.data_source)
),

-- Ярусы 5-7: сетевые названия, строгие локи data_source + ad_destination
-- (null на любой стороне честно проваливает матч — equality с null не
-- совпадает).
t_ad_name as (
  select distinct v.visit_id
  from v
  inner join costs as a
  on a.date = v.date
  and a.ad_name = v.attributed_ad.ad_name
  and a.data_source = v.attributed_ad.data_source
  and a.ad_destination = v.attributed_ad.ad_destination
),

t_adgroup_name as (
  select distinct v.visit_id
  from v
  inner join costs as a
  on a.date = v.date
  and a.adgroup_name = v.attributed_ad.adgroup_name
  and a.data_source = v.attributed_ad.data_source
  and a.ad_destination = v.attributed_ad.ad_destination
),

t_campaign_name as (
  select distinct v.visit_id
  from v
  inner join costs as a
  on a.date = v.date
  and a.campaign_name = v.attributed_ad.campaign_name
  and a.data_source = v.attributed_ad.data_source
  and a.ad_destination = v.attributed_ad.ad_destination
),

-- Ярус 8: полный набор канонических меток. Строки расходов с целочисленным
-- strimix_refid принадлежат ярусу 1 и здесь не участвуют (зеркало
-- движка отчётов).
t_utm_labels as (
  select distinct v.visit_id
  from v
  inner join costs as a
  on a.date = v.date
  and ifnull(a.source, '_') = ifnull(v.source, '_')
  and ifnull(a.medium, '_') = ifnull(v.medium, '_')
  and ifnull(a.campaign, '_') = ifnull(v.campaign, '_')
  and ifnull(a.content, '_') = ifnull(v.content, '_')
  and ifnull(a.term, '_') = ifnull(v.term, '_')
  and ifnull(a.strimix_refid, '_') = ifnull(v.strimix_refid, '_')
  where safe_cast(a.strimix_refid as int64) is null
)

select
  v.visit_id,
  case
    when t1.visit_id is not null then 'strimix_refid'
    when t2.visit_id is not null then 'ad_id'
    when t3.visit_id is not null then 'adgroup_id'
    when t4.visit_id is not null then 'campaign_id'
    when t5.visit_id is not null then 'ad_name'
    when t6.visit_id is not null then 'adgroup_name'
    when t7.visit_id is not null then 'campaign_name'
    else 'utm_labels'
  end as ad_match_type
from v
left join t_refid         as t1 on t1.visit_id = v.visit_id
left join t_ad_id         as t2 on t2.visit_id = v.visit_id
left join t_adgroup_id    as t3 on t3.visit_id = v.visit_id
left join t_campaign_id   as t4 on t4.visit_id = v.visit_id
left join t_ad_name       as t5 on t5.visit_id = v.visit_id
left join t_adgroup_name  as t6 on t6.visit_id = v.visit_id
left join t_campaign_name as t7 on t7.visit_id = v.visit_id
left join t_utm_labels    as t8 on t8.visit_id = v.visit_id
where coalesce(
  t1.visit_id, t2.visit_id, t3.visit_id, t4.visit_id,
  t5.visit_id, t6.visit_id, t7.visit_id, t8.visit_id
) is not null
)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

-- Несматченные визиты остаются с ad_match_type = null (колонка только что
-- создана пустой), поэтому обновляем только совпавшие строки.
set query_template = """
merge `<project_name>.<dataset_name>.visits` as t
using `visit_ad_match_assignment` as m
on t.visit_id = m.visit_id
when matched then update set t.ad_match_type = m.ad_match_type""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

end;

--------------------------------------------------------------------------
------ 11. СЛОВАРЬ КОМБИНАЦИЙ МЕТОК (traffic_label_combinations) ----------
--------------------------------------------------------------------------
-- Бизнес-смысл: селекторы фильтров отчётов работают каскадом (пользователь
-- выбрал source → варианты medium/campaign/content/term/strimix_refid и
-- traffic_origin/traffic_channel пересчитываются под выбор). Чтобы не
-- сканировать тяжёлые таблицы на каждый чих фильтра, материализуем
-- компактный словарь: уникальные комбинации канонических меток и
-- origin/channel по датам. Берём из ОБЕИХ таблиц — visits и ad_costs:
-- у расходов без кликов визитов нет, но их кампании обязаны быть доступны
-- в фильтрах для анализа.
begin

declare query string;
declare query_template string;

set query_template = """
create or replace table `<project_name>.<dataset_name>.traffic_label_combinations`
partition by date options (require_partition_filter = false) as (
  select
    date, source, medium, campaign, content, term, strimix_refid,
    traffic_origin, traffic_channel
  from `<project_name>.<dataset_name>.visits`
  union distinct
  select
    date, source, medium, campaign, content, term, strimix_refid,
    traffic_origin, traffic_channel
  from `<project_name>.<dataset_name>.ad_costs`
)""";

set query = replace(query_template, '<project_name>', _project_name);
set query = replace(query, '<dataset_name>', _dataset_name);

execute immediate (query);

end;

-- Закрываем внешний begin этапа 5/5 (атрибуция и классификация).
end;
