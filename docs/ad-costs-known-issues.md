# Расходы (ad_costs) — известные расхождения и отложенные фиксы

**Статус:** отложено — зафиксировано для последующего разбора, в работу не взято.  
**Джоба:** `src/modules/gcloud/bigquery/scheduled-queries/templates/update-costs-and-calculate-attribution.sql`, этапы 1/5–3/5 (Facebook / Google / TikTok Ads).  
**Контекст:** найдено 2026-09-28 при разборе дублирования расходов.

По каждому пункту перед фиксом нужно подтвердить проблему на данных (диагностические запросы ниже), затем согласовать решение.

---

## Уже исправлено (для контекста)

**Дубль расходов при смене названий.** С коммитов `7363265` (Facebook) и `df43e13` (Google, TikTok) в `latest_matched_rows_grouped` группировка шла ещё и по `campaign_name`, `adset_name`/`adgroup_name`, `ad_name`, `ad_destination` и т.п. При переименовании между выгрузками одного объявления за день получалось несколько групп, и каждая присоединяла одну и ту же строку-источник метрик: расход умножался на число вариантов названия.

**Фикс (2026-09-28):**
- группировка только по полям `match_key` (как в старой логике);
- метки, `landing_page_url`, `url_params` берутся из первой версии меток за дату (по ним матчатся визиты этой даты);
- метрики, названия и id берутся из самой свежей выгрузки (`latest_download_rows`), чтобы подтягивались корректировки сети задним числом.

**Дубль расходов Google при `keyword = null` и смене UTM внутри даты (2026-10-05).** В `latest_matched_rows` (Google) поиск первой версии меток за дату сравнивал `i.keyword = t1.keyword`. Для строк без ключевого слова — PMax, Display, Demand Gen, Video, Smart, Shopping, App, DSA — `null = null` не истина, поэтому подзапрос не находил первую версию, последующие версии меток получали `last_row = max(row_number)` и оставались в выборке. Каждая из них присоединяла метрики `latest_download_rows` → расход, клики и показы умножались на число версий меток за дату. Стреляло, когда за дату из окна перевыгрузки (D-7..D-1) метки отличались от прошлой выгрузки: правка UTM в кампании или изменение разбора URL в `google-ads-worker`. Facebook / TikTok не затронуты (зерно `ad_id × date`, `ad_id` не бывает `null`).

**Фикс:** `i.keyword is not distinct from t1.keyword` (как в join с `latest_download_rows`). Для строк с непустым `keyword` и для дат без смены меток результат не меняется. MERGE пересобирает Google-расходы из всего staging, поэтому исторические даты с задвоением исправятся задним числом — расходы Google по ним уменьшатся до правильных.

**Раскатка:** деплой ресурсов создаёт scheduled query только для новых проектов; в существующих текст обновляет `npx tsx src/scripts/migrate-traffic-settings.ts --all` (сначала dry-run, затем `--apply`).

---

## KI-1. Google Ads: несколько строк одного `ad_id × keyword × date` в одной выгрузке

**Симптом.** В `google_ads_ad_costs` есть группы строк с одинаковыми `ad_id`, `keyword`, `date` и `inserted_at` (`inserted_at` проставляется один на пачку, а не на строку). Найдено на поисковой кампании (`ad_destination` не `catalog`).

**Что делает джоба.** Считает эти строки разными выгрузками: `row_number() over (partition by ad_id, keyword, date order by inserted_at)` при равном `inserted_at` упорядочивает их произвольно, дальше берётся одна строка, остальные отбрасываются. Итог — **недосчёт** расходов, причём какая строка выживет, недетерминировано (сумма может «плавать» между прогонами). Поведение унаследовано от старой логики.

**Что уже исключено.** Разные типы соответствия / регистр одного ключевого слова: коннектор (`google-ads-worker`, `__merge_duplicated_creative_keywords`) суммирует их до записи — но только **внутри одной группы объявлений**.

**Гипотезы:**
1. Один `ad_id` в нескольких группах объявлений / кампаниях (в Google Ads id объявления уникален только в паре с группой: `adGroupAds/{ad_group_id}~{ad_id}`) с одинаковым ключевым словом. Тогда джоба теряет расходы всех групп, кроме одной.
2. Точные копии строк (коннектор записал одно и то же дважды в одной выгрузке). Тогда джоба ведёт себя правильно.
3. Товарные (Shopping) кампании: `ad_id` = id товара, `keyword` = null; один товар в нескольких группах/кампаниях даёт то же самое. На текущих данных не проявилось, но риск тот же.

**Диагностика:**

```sql
select
  count(*) groups,
  countif(adgroups > 1) multi_adgroup,
  countif(campaigns > 1) multi_campaign,
  countif(distinct_rows = 1) exact_copies,
  round(sum(total_cost - max_cost), 2) min_lost_cost,
  round(sum(total_cost), 2) total_cost_in_groups
from (
  select ad_id, keyword, date, inserted_at,
    count(*) rows_cnt,
    count(distinct adgroup_id) adgroups,
    count(distinct campaign_id) campaigns,
    count(distinct to_json_string(struct(campaign_id, adgroup_id, source, medium, campaign, content, term,
      strimix_refid, landing_page_url, cost, impressions, clicks))) distinct_rows,
    sum(cost) total_cost,
    max(cost) max_cost
  from `PROJECT.DATASET.google_ads_ad_costs`
  group by 1, 2, 3, 4
  having rows_cnt > 1
)
```

**Возможный фикс:**
- гипотезы 1 и 3 → добавить `adgroup_id` в зерно Google: `match_key`, все `partition by`, `group by`, join с `latest_download_rows` (с `is not distinct from` для null). Для обычных объявлений результат не меняется;
- гипотеза 2 → дедуп в коннекторе, в джобе ничего не менять.

---

## KI-2. `match_key` нормализован, а группировка/партиции — нет

**Суть.** `match_key` строится из `ifnull(trim(...), '_')`, а `group by` в `latest_matched_rows_grouped` и `partition by` (у Google — по `keyword`) работают с сырыми значениями.

**Когда стреляет:** метка или keyword между выгрузками отличаются только пробелами (`'x'` / `'x '`) или `null` против литерала `'_'`.
- все сети: две группы с одинаковыми `match_key` и `last_row` → обе присоединяют одну строку → **дубль** расхода;
- Google: `'x'` и `'x '` попадают в разные партиции с одинаковым `match_key` → join с `b` находит строки обеих партиций (дубль), скалярный подзапрос в `latest_matched_rows` может упасть с «more than one element».

**Статус проверки:** диагностика на тестовых и реальных проектах ничего не вернула — риск теоретический.

**Диагностика (Facebook; для Google/TikTok — аналогично, для Google + `keyword`):**

```sql
select date, ad_id,
  count(distinct concat(ifnull(source,'∅'),'|',ifnull(medium,'∅'),'|',ifnull(campaign,'∅'),'|',ifnull(content,'∅'),'|',ifnull(term,'∅'),'|',ifnull(strimix_refid,'∅'))) raw_variants,
  count(distinct concat(ifnull(trim(source),'_'),ifnull(trim(medium),'_'),ifnull(trim(campaign),'_'),ifnull(trim(content),'_'),ifnull(trim(term),'_'),ifnull(trim(strimix_refid),'_'))) key_variants
from `PROJECT.DATASET.facebook_ads_ad_costs`
group by date, ad_id
having raw_variants > key_variants
```

**Возможный фикс:** группировать только по `match_key`, `date`, `ad_id` (+ `keyword`), `last_row`; метки брать из `b`, а не из `c`; для Google добавить в join с `b` условие `b.keyword is not distinct from c.keyword`.

---

## KI-3. Легаси-строки `data_source = 'Facebook Ads'`

**Суть.** Ручная джоба `old-ad-cost-job.sql` (проект `strimix_7770`) писала `data_source = 'Facebook Ads'`, а текущая удаляет в MERGE только `'FACEBOOK_ADS'`. Если такие строки остались в `ad_costs`, их никто не удаляет (этап классификации пересоздаёт таблицу из текущего содержимого), и они суммируются с новыми — **дубль**.

**Диагностика:**

```sql
select data_source, count(*), sum(cost)
from `PROJECT.DATASET.ad_costs`
group by data_source
```

**Фикс:** код не меняется; при наличии легаси-значений — разовый `delete` этих строк.

---

## KI-4. Метки в день смены UTM

**Суть (by design, не баг).** Для каждой даты сохраняется первая версия меток. Если UTM сменили в течение дня, вся строка расходов этого дня остаётся с метками A; визиты, пришедшие после смены с метками B, по ярусу UTM-меток с расходами не склеятся (могут сматчиться по id / названиям). Разделить дневной расход между A и B нельзя — сеть отдаёт одну сумму.

**Действие:** не требуется; зафиксировано, чтобы не принимать за баг.
