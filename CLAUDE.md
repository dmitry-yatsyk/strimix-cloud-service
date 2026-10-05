# cloud-management-service

Ресурсы проектов в GCP (датасеты, таблицы BigQuery, scheduled query атрибуции), настройки трафика и атрибуции.

## Команды
- `npm run build`, `npm start`, `npm test` (node:test, `src/**/*.test.ts`), `npx tsc --noEmit -p .`.
- `npm run lint` сломан (ESLint 9 без `eslint.config.js`); проверять tsc и prettier.
- Миграции: `npm run migrate:traffic-settings`, `npm run migrate:ad-account-columns` — dry-run по умолчанию, `--apply` явно, `--project=<id>[,<id>]`.

## Структура
- Схемы таблиц BigQuery: `src/modules/gcloud/bigquery/schemas/v1/`. Staging-таблицы расходов (`{facebook,google,tiktok}_ads_ad_costs`) продублированы в воркерах (`*-ads-worker/.../bigquery/models`) — менять синхронно.
- Шаблон scheduled query: `src/modules/gcloud/bigquery/scheduled-queries/templates/update-costs-and-calculate-attribution.sql`.
- Новые проекты: `src/application/use-cases/project-resources/deploy-project-resources.ts` — таблицы и запрос создаются только если их нет; существующие проекты обновляются только скриптами миграции (`src/scripts/`).
- Контекст проекта (датасет, имя запроса): `resolveProjectContext` в `src/modules/traffic-settings/project-context.ts`; добавление колонок — `BigQueryApi.addMissingColumns` (идемпотентно).

## Подводные камни
- **Задеплоенный scheduled query проекта может содержать ручные доработки с метками `-- CUSTOM…`** (`CUSTOMIZATION`, `CUSTOMIZATION FOR DASHBOARD`, `CUSTOM RULE`; например, на 7924 и 7919 — доп. параметры заказа, на 7919 ещё правило первой оплаты по `status = 'completed'`). Перед миграцией запроса найти версию шаблона из `git log`, с которой он задеплоен (отрендерить версии и сравнить), и посмотреть разницу. Если есть метки `CUSTOM` или иные отличия — не перерендеривать запрос целиком (это сотрёт доработку), а точечно править задеплоенный текст. Образец: `src/application/use-cases/ad-costs/ad-account-query-patch.ts`. `migrate-traffic-settings` перерендеривает запрос целиком — на таких проектах его refresh-шаг затрёт доработку.
- Порядок миграции: сначала колонки во всех таблицах, потом запрос, который их читает — иначе ночной прогон упадёт.
- Проект с запросом старше `bf771fb` (24.09): после `migrate:traffic-settings` обязательно `src/scripts/backfill-applies-to-web-origin-channel.ts --project=<id>` (dry-run, затем `--apply`). Иначе правила origin/channel с `applies_to_web = null` не применяются к веб-визитам — все визиты уходят в канал Other (случилось на 7914). После миграции сверять разбивку визитов по каналам до/после (time travel).
- Staging-таблицы пишут воркеры streaming insert с `ignoreUnknownValues`: новое поле в строке не ломает вставку в немигрированную таблицу.
