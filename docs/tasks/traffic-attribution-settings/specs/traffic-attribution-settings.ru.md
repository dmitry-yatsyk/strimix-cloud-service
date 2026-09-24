# Техническое задание: управление трафиком и атрибуцией Strimix

Версия: 1.0. Язык документа: русский. Документ предназначен для AI-агента, реализующего одну функцию в трёх репозиториях.

## 1. Задание исполнителю

Реализуй полноценный раздел **«Проєкт → Трафік та атрибуція»** в Strimix. Пользователь должен через frontend просматривать и изменять настройки четырёх существующих BigQuery-таблиц своего проекта:

1. `excluded_url_params` — исключения параметров из нормализованных посадочных страниц.
2. `excluded_referrers` — домены, исключаемые из реферальной атрибуции.
3. `traffic_rules` — правила нормализации меток и классификации трафика.
4. `attribution_signal_mappings` — извлечение сигналов атрибуции из заказов, сделок и событий.

Выполни согласованные изменения frontend, API gateway и cloud management service, реализуй миграцию существующих проектов, проверки и инструкции выпуска. Результат должен работать с реальными API и BigQuery. Наличие HTML-макета, моков или только одного готового репозитория не означает выполнение задания.

Сначала прочитай этот документ целиком, применимые `AGENTS.md` и перечисленные исходники. Зафиксируй текущее состояние трёх репозиториев. Сохраняй чужие изменения. Поддерживай существующие соглашения каждого репозитория; переписывать gateway на TypeScript или заменять frontend stack не нужно.

При наличии нескольких агентов можно поручить им frontend, gateway и cloud management после фиксации общего API-контракта. Один исполнитель отвечает за совместную интеграцию и конечные проверки. Последовательная работа одного агента также допустима.

Приоритет требований: последующие указания владельца → это ТЗ → актуальные схемы и подтверждённая бизнес-семантика SQL → дизайн-прототип. При расхождении прототипа с ТЗ реализовать ТЗ. Небольшие изменения файловой структуры допустимы, публичный контракт и поведение должны остаться согласованными.

### 1.1. Репозитории и рабочие каталоги

| Компонент | Локальный корень | Git remote |
| --- | --- | --- |
| Frontend | [app-frontend](/Users/dmytro_yatsenko/Projects/Strimix/app-frontend) | [strimix-app-client-ts](https://github.com/dmitry-yatsyk/strimix-app-client-ts) |
| API gateway, далее Gateway | [app-api-gateway](/Users/dmytro_yatsenko/Projects/Strimix/app-api-gateway) | [strimix-app-backend](https://github.com/DmitryYatsyk/strimix-app-backend) |
| Cloud management service, далее CMS | [cloud-management-service](/Users/dmytro_yatsenko/Projects/Strimix/cloud-management-service) | [strimix-cloud-service](https://github.com/DmitryYatsyk/strimix-cloud-service) |

Под названием API-шлюз в этом задании понимается **`app-api-gateway`**, а не `data-service-api`. Изменения остальных сервисов не входят в базовый объём.

Состояние исходников при подготовке ТЗ: frontend `0e913a98edf3abc2b0042e84abd497dda5288ddf`, gateway `8135c6c4ec0dc0e6894bb2d79193309b151e6795`, CMS `d2e209bdce39916790003b2587d1e0aff6c1a648`. Это ориентиры для анализа изменений, а не требование откатывать репозитории к этим коммитам.

### 1.2. Дизайн и пояснения

- [Галерея семи экранов](/Users/dmytro_yatsenko/Projects/Strimix/cloud-management-service/docs/design/traffic-attribution/gallery.html).
- [Интерактивный HTML-прототип](/Users/dmytro_yatsenko/Projects/Strimix/cloud-management-service/docs/design/traffic-attribution/index.html).
- [Исходники прототипа](/Users/dmytro_yatsenko/Projects/Strimix/cloud-management-service/docs/design/traffic-attribution).
- [Первичный анализ дизайна и схем](/Users/dmytro_yatsenko/Projects/Strimix/cloud-management-service/docs/design/traffic-attribution/README.md).
- [PNG всех экранов](/Users/dmytro_yatsenko/Projects/Strimix/cloud-management-service/docs/design/traffic-attribution/screenshots).
- [ZIP-комплект дизайна](/Users/dmytro_yatsenko/Projects/Strimix/cloud-management-service/docs/design/strimix-traffic-attribution.zip).

HTML показывает композицию и взаимодействия. Его `data.js` содержит демонстрационные домены, mappings и собственные правила: **их нельзя загружать в реальные проекты**. Правила `custom_instagram_*` и CRM-код `16` — примеры, не общесистемные defaults. Не подключать HTML через iframe и не переносить его DOM-манипуляции в React. Использовать действующие React/MUI-компоненты frontend.

## 2. Зафиксированные решения и границы первой версии

1. Один пункт в группе «Проєкт», четыре вкладки внутри. Новая верхнеуровневая группа сайдбара не нужна.
2. Базовый UI — по эскизам: списки, drawer для URL-исключений/доменов, отдельные страницы для правил/mappings.
3. Системные URL-исключения и traffic rules можно редактировать, выключать и удалять. `is_system` означает происхождение, а не запрет редактирования.
4. Не добавлять доменные поля `name`, `description`, `created_at`, `updated_at`, `is_system` туда, где их нет в соответствующих четырёх схемах. Производные подписи строк вычисляются в UI.
5. BigQuery остаётся источником истины для настроек. Не создавать параллельную основную копию конфигурации в MySQL/Mongo с последующей фоновой синхронизацией.
6. Все записи проходят через Gateway и CMS. Frontend и Gateway не выполняют SQL к этим таблицам напрямую.
7. После успешной записи конфигурация сохранена, но отчёты изменятся после следующего успешного расчёта атрибуции. Не обещать мгновенный пересчёт или применение ко всей истории.
8. В первую версию входят серверный предпросмотр URL-исключения и валидация всех конфигураций. Полный симулятор атрибуции, UI запуска пересчёта, drag-and-drop приоритетов, импорт/экспорт конфигураций и восстановление системных defaults не входят.
9. Версионирование изменений и обработка конфликтов обязательны. Для этого разрешена одна служебная таблица BigQuery; она описана ниже и не меняет бизнес-схемы четырёх таблиц.
10. Реализовать локализации **uk/en/ru**, существующие в frontend. Русский язык ТЗ не означает перевод всего продукта на русский.

## 3. Исходники, которые нужно изучить

Все пути ниже относительны к корню указанного репозитория.

### 3.1. Frontend

| Файл/каталог | Для чего |
| --- | --- |
| `src/config/link-map.ts`, `src/routes/auth/project.tsx` | Новые маршруты и lazy-loading |
| `src/shared/ui/widgets/MainLayout/components/PrimarySideBar/components/Navigation/index.tsx` | Новый пункт меню |
| `src/shared/ui/widgets/MainLayout/components/PrimarySideBar/Layout.tsx` | Видимость и selected-состояние вложенных маршрутов |
| `src/themes/index.ts`, `src/shared/ui/widgets/MainLayout/Layout.tsx` | Тема, фон, размеры, адаптивность |
| `src/views/reports/MetricsDefinitions/` | Стиль каталога, таблицы, поиск, вкладки |
| `src/shared/ui/components/` | Кнопки, поля, dialogs, feedback |
| `src/api/index.ts`, `src/api/project/index.ts` | RTK Query, reauth, cache tags, URL проекта |
| `src/hooks/useProjectPermissions.ts`, `src/constants/roles.constants.ts` | Права и отображаемая матрица ролей |
| `src/i18n/index.ts`, `src/i18n/locales/{uk,en,ru}/` | Регистрация переводов |
| `Dockerfile`, `cloudbuild.yaml`, `.github/workflows/gcr-deploy-multi-env.yaml` | Передача build-time feature flag |

Важно: `canEditReports` даёт `project.user` право изменять отчёты. Для новой конфигурации эти права **не подходят**: завести отдельные `canReadTrafficSettings` и `canEditTrafficSettings`.

### 3.2. Gateway

| Файл/каталог | Для чего |
| --- | --- |
| `src/router/index.js`, `src/router/organization/index.js` | Публичный auth-контур и mount нового router |
| `src/router/project/index.js` | Соглашения о URL проектов |
| `src/middlewares/auth.js`, `src/middlewares/check-email-confirmation.js` | Аутентификация |
| `src/middlewares/grant-access.js` | Принадлежность проекта организации, роли и permissions |
| `src/middlewares/demo-user-restriction.js` | Запрет изменения настроек демопользователем |
| `src/config/roles-and-permissions.js` | Новые permissions |
| `src/services/report-engine/metric/index.js` | Существующий стиль проксирования, не копировать его обработку ошибок вслепую |
| `src/exceptions/http.exception.js`, `src/middlewares/error.js` | Поддерживаемая вложенная форма ошибки с `details` |
| `src/app.js`, `src/docs/v1/`, `.github/workflows/gcr-deploy.yaml` | Env validation, OpenAPI, выпуск |

Gateway уже проверяет в `GrantAccess`, что `project.organizationId` совпадает с `organizationId` в URL. Новый router должен использовать этот механизм, а не ограничиваться наличием JWT.

### 3.3. CMS

| Файл/каталог | Для чего |
| --- | --- |
| `src/modules/gcloud/bigquery/schemas/v1/bigquery.excluded_url_params.schema.ts` | Схема и системный seed URL-исключений |
| `src/modules/gcloud/bigquery/schemas/v1/bigquery.excluded_referrers.schema.ts` | Массив hosts |
| `src/modules/gcloud/bigquery/schemas/v1/bigquery.traffic_rules.schema.ts` | Все поля, семантика и seed правил |
| `src/modules/gcloud/bigquery/schemas/v1/bigquery.attribution_signal_mappings.schema.ts` | Все поля mappings |
| `src/modules/gcloud/bigquery/scheduled-queries/templates/update-costs-and-calculate-attribution.sql` | Фактическое применение настроек |
| `src/modules/gcloud/bigquery/api/bigquery.api.ts` | Клиент BigQuery, dataset location, работа с scheduled queries |
| `src/modules/project-resources/project-resources.interface.ts`, `project-resources.repository.ts` в том же каталоге | Project → GCP project/dataset/tables |
| `src/application/use-cases/project-resources/deploy-project-resources.ts` | Создание ресурсов и seed, новые проекты |
| `src/presentation/router/project-resources.router.ts`, `src/presentation/controllers/project-resources.controller.ts` | Соглашения внутренних маршрутов |
| `src/presentation/api-schemas/`, `src/presentation/api-validation/` | Zod-валидация |
| `src/presentation/middleware/auth.middleware.ts`, `src/presentation/exceptions/http.exception.ts` | Авторизация сервисов, ошибки |
| `src/presentation/utils/validate-env.util.ts`, `src/index.ts`, `src/presentation/docs/v1/` | Подключение feature, router, документации |

## 4. Архитектура и ответственность

```text
React frontend
  → authenticated Gateway endpoint с organizationId/projectId
    → проверка tenant и permissions
      → CMS endpoint с доверенным projectId и сервисной авторизацией
        → ProjectResourcesRepository
          → BigQuery нужного GCP project, dataset и location
```

**Frontend:** представление, локальный черновик, зависимые поля, клиентские подсказки, вызов API, отображение серверных ошибок. Успешная локальная проверка не заменяет серверную.

**Gateway:** пользовательская аутентификация, проверка организации/проекта/ролей, деморежим, ограничение доступных операций, проксирование запроса/результата/ошибок. Не дублировать SQL и бизнес-правила CMS в Gateway.

**CMS:** полная валидация, определение BigQuery-ресурсов, параметризованное чтение/изменение, контроль ревизий, предпросмотр URL, миграции, обновление SQL deployed scheduled query.

Project ID брать из проверенного path parameter. Не принимать от клиента `gcp_project_id`, `dataset_id`, `table_id`, dataset location, SQL, service account или actor ID. Имена четырёх ресурсов сопоставлять таблицам через фиксированный allowlist. Вычисленные identifiers проверять и экранировать отдельно; query parameters используются для значений, а не имён таблиц.

Не вызывать полный `deployProjectResources` при GET или сохранении настройки: этот use case обслуживает и другие ресурсы проекта. Не полагаться на вычисление dataset по шаблону имени, если уже есть `ProjectResourcesRepository`.

## 5. Права доступа

Принять для первой версии следующую матрицу. Права организации относятся только к принадлежащим ей проектам.

| Роль | Просмотр, validate, URL preview | Создание/изменение/выключение/удаление |
| --- | --- | --- |
| `organization.owner` | Да | Да |
| `organization.admin` | Да | Да |
| `project.admin` | Да | Да |
| `project.user` | Да | Нет |
| `project.viewer` | Да | Нет |
| `project.sharedReportViewer` | Нет | Нет |
| `organization.user` без подходящей роли проекта | Нет | Нет |
| Демопользователь | По обычным правам чтения | Нет |

Добавить `organization.projects.trafficSettings.read/update` и `project.trafficSettings.read/update`. `update` покрывает все мутации четырёх ресурсов. Использовать `GrantAccess.checkPermission('any', [...])` для соответствующей пары organization/project permissions. Широкое `project.project.read` не подходит: оно есть и у `sharedReportViewer`.

Проверять положительные целочисленные `organizationId/projectId`, активность проекта/организации и membership до обращения в CMS. На мутации применять существующий запрет демопользователя. Обновить frontend-матрицу описаний ролей вместе с реальными permissions.

На frontend скрывать пункт меню при отсутствии чтения, защищать прямой переход на route, а при read-only показывать данные и форму просмотра без сохранения, переключателей и удаления. Ошибка 403 API должна корректно обрабатываться даже если frontend считал право разрешённым.

Для новых CMS endpoints сервисный код должен принадлежать Gateway: использовать существующий `APP_AUTHORIZATION_CODES`, дополнить middleware идентификацией `appName` или специализированной проверкой доверенного приложения. Существующие маршруты остальных сервисов не ломать. Добавить для этого явную запись приложения `app-api-gateway` при настройке окружения. Не пересылать пользовательский Bearer token в CMS вместо сервисного кода.

## 6. Модель данных и инварианты

### 6.1. Общие правила

- DTO сохраняют имена полей BigQuery в `snake_case`. Frontend может иметь отдельную внутреннюю модель формы.
- `rule_id`, `mapping_id`, `param_id` неизменяемы. При создании CMS генерирует `custom_<uuid>`; клиент не задаёт ID и `is_system`. Сервер выставляет `is_system=false` там, где оно существует.
- При чтении и изменении существующих записей сохранять `is_system`, даже если пользователь отредактировал системное правило. Не выдавать его за вновь созданное собственное.
- Все поля схемы должны проходить round-trip. Нельзя при редактировании сбрасывать скрытый заполненный optional field только потому, что он находится в свёрнутом блоке.
- `null` означает отсутствие настройки. Не вводить неявные значения source/medium/ключей параметров.
- Не применять общее `trim/lowercase/emptyToNull` ко всем строкам. Regex, буквальные outputs, имена рекламных сущностей и ключи могут быть чувствительны к регистру и содержимому.
- UI должен различать «не задавать» и значение. Пустые незаполненные optional controls нового объекта дают `null`; намеренное удаление условия даёт `null`. Уже существующий `""` нельзя незаметно заменить на `null` при обычном сохранении; обеспечить явное представление/редактирование пустого значения в расширенном режиме. Это особенно важно для `match_*` и `set_*`.
- Для всех новых/изменяемых полей проверять типы, enum и длину. Число приоритета — целое, представимое без потерь в JavaScript; не принимать строки, `NaN`, дроби. Отрицательные значения схемой не запрещены; ограничение «только 1…999» не вводить.
- Предлагаемые прикладные пределы первой версии: regex 4096 символов; описание 4096; строковый output 2048; event name/param key 256; максимум 1000 hosts в списке; HTTP body в рамках существующего лимита 100 KiB с понятной ошибкой 413. Существующие значения вне лимитов не обрезать: выявить preflight и выдать диагностируемое состояние.
- Новая конфигурация не должна снимать/перезаписывать schema columns, а запись одного объекта не должна менять соседние объекты.
- Неизвестные поля mutation DTO отклонять. ID и `is_system` возвращать в read DTO, но не принимать как изменяемые поля.

### 6.2. `excluded_url_params`

| Поле | Редактирование | Требования |
| --- | --- | --- |
| `param_id` | Нет | Генерируется CMS, уникально в проекте |
| `param_key_regex` | Да | Обязательный RE2-выраз, новая запись не может иметь пустой/пробельный шаблон |
| `is_active` | Да | Boolean |
| `is_system` | Нет | Происхождение, не блокирует CRUD |
| `description` | Да | Nullable string |

Сопоставление — по **всему ключу URL-параметра, без регистра**, а не по значению и не по произвольной подстроке URL. `utm_[a-z]+` соответствует `utm_source`/`UTM_MEDIUM`, но не `custom_utm_source`. Явно якоренный `^fbclid$` также должен работать.

Исключаются только компоненты нормализованного `landing_page` у visits/ad_costs. Не удалять исходный URL, извлечённые UTM, `url_params` и рекламные идентификаторы из остальных колонок. При отсутствии активных исключений все query-параметры сохраняются согласно текущей нормализации URL.

### 6.3. `excluded_referrers`

Физическая схема — только `hosts: STRING REPEATED`. API представляет её как один список доменов, UI — как строки этого списка.

1. При чтении объединить массивы всех имеющихся строк, убрать повторы и вернуть детерминированный порядок.
2. При записи сохранять одну строку с массивом всех hosts, включая `hosts=[]` для пустого списка. Замена атомарная.
3. Добавление/изменение/удаление отдельного домена frontend выполняет через отправку нового полного списка с ожидаемой ревизией.
4. Никаких вымышленных row ID, description, is_active, priority, is_system для доменов.
5. Только hostname: без протокола, порта, `/path`, query, fragment и wildcard. Поддомены добавляются отдельно. В первой версии IP-адреса и single-label hosts не поддерживать; возвращать понятную ошибку.
6. Нормализовать ввод доменов: trim, lowercase, IDN → ASCII punycode, удаление единственной завершающей DNS-точки, deduplicate. Проверять длину hostname и labels. Применять одинаковую нормализацию и на сервере.
7. При миграции нормализация старого списка не должна незаметно менять множество исключений. Несовместимые старые значения показать в отчёте миграции и требовать отдельного решения; не отбрасывать их автоматически.
8. Сохранить точную host-семантику текущего SQL. Исключённый реферал не становится новым referral-источником; явные UTM продолжат работать. Не обещать этим экраном конкретную модель наследования предыдущего источника.

### 6.4. `traffic_rules`

Обязательные поля: `rule_id`, `priority`, `is_active`, `is_system`, `stage`, `target`.

Enums: `stage = utm | origin | channel`; `target = visit | ad_cost | both`.

Редактор должен поддерживать **все** optional fields:

| Группа | Поля |
| --- | --- |
| Вебприменение | `applies_to_web` |
| Условия по меткам | `source_regex`, `medium_regex`, `campaign_regex`, `content_regex`, `term_regex`, `strimix_refid_regex` |
| Условия по рекламе | `data_source_regex`, `campaign_id_regex`, `campaign_name_regex`, `adgroup_id_regex`, `adgroup_name_regex`, `ad_id_regex`, `ad_name_regex`, `ad_destination_regex` |
| URL | `url_param_key`, `url_param_value_regex` |
| Уже определённый источник | `traffic_origin_regex` |
| UTM outputs | `set_source`, `set_medium`, `set_campaign`, `set_content`, `set_term`, `set_strimix_refid` |
| Классификация | `set_traffic_origin`, `set_traffic_channel` |

Обязательная бизнес-семантика:

- Все ненулевые условия соединяются через AND. Визуальных произвольных OR-групп нет; альтернативы внутри одного regex разрешены.
- Условия regex чувствительны к регистру как записаны. Для нечувствительности автор вводит `(?i)`.
- Меньший `priority` выполняется раньше.
- UTM: каждый выходной `set_*` берётся из первого по приоритету совпавшего правила, которое задаёт **это поле**. Разные поля может задать несколько правил. Записанное значение перезаписывает извлечённую метку.
- Origin/channel: выигрывает первое совпавшее правило. `traffic_origin_regex` допустим только у channel.
- `utm`: хотя бы одно из шести UTM outputs задано не `null`; classification outputs — `null`.
- `origin`: требуется `set_traffic_origin`; `channel`: требуется `set_traffic_channel`. Outputs другого этапа — `null`.
- `applies_to_web=true` допустимо только для utm и target, включающего visit. `null` равнозначен false по существующей семантике.
- При изменении stage UI предупреждает об очистке несовместимых условий/outputs и отправляет согласованный объект. Сервер не должен молча игнорировать непустые несовместимые поля.
- `url_param_key` — точный ключ; optional regex значения требует непустого ключа. Наличие ключа без regex означает проверку существования. Для synthetic visits `url_params` пуст: это явно объясняется пользователю.
- Ad-derived условия применяются к строке расходов либо однозначным данным resolved group синтетического визита. На web visits они не срабатывают даже при `applies_to_web=true`. Показывать предупреждение о фактической области действия.

Placeholders разрешены в UTM outputs: `{data_source}`, `{campaign_id}`, `{campaign_name}`, `{adgroup_id}`, `{adgroup_name}`, `{ad_id}`, `{ad_name}`. Не добавлять произвольные макросы или исполнение выражений. Правило с placeholders применяется только если все пять канонических меток source/medium/campaign/content/term пусты. Для cost row подставляются её собственные значения; для synthetic visit — однозначные значения группы. Не менять эту семантику и не записывать `(combined)` как постоянную метку.

**Совпадающие приоритеты:** SQL traffic rules не задаёт явный tie-break по ID. Новая мутация не должна вводить конфликт активных правил одного этапа с одинаковым priority и пересекающимся target (`both` пересекается с обоими). Вернуть 409 `TRAFFIC_RULE_PRIORITY_CONFLICT` со списком ID. Разные этапы и непересекающиеся `visit`/`ad_cost` допускаются. Проверка — внутри той же транзакции, что и запись. Старые конфликты не удалять; показать предупреждение. Разрешить отключение, удаление и изменения, не вводящие новый конфликт, чтобы legacy-конфигурацию можно было исправить. Анализ пересечения произвольных regex не требуется.

Не заменять это правило общим запретом равных приоритетов по всей таблице. Собственным правилам предлагать свободное значение меньше 1000, но разрешать явный другой выбор.

### 6.5. `attribution_signal_mappings`

Обязательные поля: `mapping_id`, `priority`, `is_active`, `entity`, `param_source`, `mode`.

| Группа | Поля |
| --- | --- |
| Метки | `source_param_key`, `medium_param_key`, `campaign_param_key`, `content_param_key`, `term_param_key`, `strimix_refid_param_key` |
| Рекламная идентичность | `campaign_id_param_key`, `campaign_name_param_key`, `adgroup_id_param_key`, `adgroup_name_param_key`, `ad_id_param_key`, `ad_name_param_key` |
| Фильтры меток | `match_source_regex`, `match_medium_regex`, `match_campaign_regex`, `match_content_regex`, `match_term_regex`, `match_strimix_refid_regex` |
| Фильтры рекламных сигналов | `match_campaign_id_regex`, `match_campaign_name_regex`, `match_adgroup_id_regex`, `match_adgroup_name_regex`, `match_ad_id_regex`, `match_ad_name_regex` |
| Границы поиска | `data_source_regex`, `ad_destination_regex` |
| Ограничение события | `event_name` |

Требования:

1. `entity=order|deal` → `param_source=custom_params`; `entity=event` → `event_params`. Другие комбинации отклонять. UI вычисляет контейнер из entity и показывает его read-only.
2. `mode=fallback|override`. Fallback создаёт synthetic visit только при отсутствии размеченной вебатрибуции профиля до якорного времени; override создаёт независимо от неё. Не трактовать fallback как «разрешено только когда нет ни одного web visit вообще».
3. Хотя бы одно `*_param_key` должно быть задано. Это **имя входного ключа**, а не значение и не JSONPath.
4. `null` означает не извлекать. Никаких fallback на стандартный ключ по умолчанию. Synthetic visit создаётся только при реально непустом извлечённом сигнале.
5. `match_*` проверяются после извлечения; ненулевые фильтры AND; отсутствующее извлечённое значение не проходит соответствующий фильтр. Для новой настройки или добавляемого фильтра требовать соответствующий настроенный `*_param_key`. Старые противоречия диагностировать без скрытой модификации.
6. Приоритет выбирается между прошедшими фильтры mappings для одного `(entity, entity_id)`. При равном priority текущий SQL сортирует по `mapping_id`. Показать предупреждение о равном приоритете, но не вводить новый запрет или менять tie-break.
7. `data_source_regex`/`ad_destination_regex` ограничивают поиск строк ad_costs. Это отдельный блок, не элементы группы `match_*`. В этих двух ограничениях регистр игнорируется по существующему SQL; в `match_*` — только если автор явно добавил `(?i)`.
8. Имена рекламных сущностей сравниваются с учётом регистра; неоднозначность resolved group не устраняется догадкой UI.
9. Для order/deal читать последнее состояние параметров, synthetic visit привязан к созданию сущности (минус 1 мс в реализации). Для event источник и якорь — сама immutable event. Сохранить фактическую семантику SQL.
10. `event_name` — optional точное имя события. Смена entity не должна незаметно превращать custom_params-ключи в подтверждённые event_params-ключи: сохранить черновик, объяснить смену контейнера и потребовать осмысленного сохранения.
11. У mappings нет `is_system`, `name` и `description`. Не добавлять их как обязательные новые поля схемы.

## 7. API-контракт

### 7.1. Базовые URL

Публичный base Gateway:

```text
/api/v1/organization/:organizationId/projects/:projectId/traffic-settings
```

Внутренний base CMS:

```text
/api/v1/project-resources/:projectId/traffic-settings
```

Suffix, HTTP method, domain payload и успешный response совпадают. Gateway добавляет проверенные actor/context, а в `/meta` — эффективные пользовательские права. Внутренние credentials в публичный ответ не попадают.

### 7.2. Endpoints

`resource` ниже — ровно `excluded-url-params`, `traffic-rules` или `attribution-signal-mappings`.

| Метод и suffix | Назначение | Ответ |
| --- | --- | --- |
| `GET /meta` | Готовность ресурсов, способ применения, права | 200 |
| `GET /:resource` | Вся коллекция одного вида | 200 `{items, revision}` |
| `GET /:resource/:id` | Один объект и ревизия коллекции | 200 `{item, revision}` |
| `POST /:resource` | Создание | 201 `{item, revision, application}` |
| `PUT /:resource/:id` | Полная замена изменяемой конфигурации объекта | 200 `{item, revision, application}` |
| `PATCH /:resource/:id/active` | Только is_active | 200 `{item, revision, application}` |
| `DELETE /:resource/:id` | Удаление одного объекта | 200 `{deleted_id, revision, application}` |
| `GET /excluded-referrers` | Логический список доменов | 200 `{hosts, revision}` |
| `PUT /excluded-referrers` | Атомарная замена списка | 200 `{hosts, revision, application}` |
| `POST /validate` | Проверка черновика, без записи | 200 validation result |
| `POST /excluded-url-params/preview` | Пример действия одного URL-исключения | 200 preview result |

Literal routes `/meta`, `/validate`, `/preview` зарегистрировать так, чтобы их не перехватывал `/:id`. Не создавать универсальный доступ к произвольной BigQuery-таблице через `:resource`.

Коллекции первой версии небольшие: загрузить весь список, использовать клиентские поиск/фильтры/пагинацию. Не вводить неоговорённый серверный LIMIT, который скрывает часть правил. Сортировка детерминированная: rules по stage order (utm/origin/channel), priority, rule_id; mappings по priority, mapping_id; URL exclusions по ID; hosts по ASCII hostname. UI может менять представление, не изменяя priority в базе.

### 7.3. DTO записи и ревизия

```json
{
  "expected_revision": "12",
  "item": {
    "param_key_regex": "utm_[a-z]+",
    "description": "Стандартные UTM-метки",
    "is_active": true
  }
}
```

Этот envelope используется для POST/PUT трёх сущностей. PUT содержит все изменяемые поля, включая явные `null`; пропущенные optional fields трактуются как `null`, а не как patch. Frontend обязан собрать полный DTO из исходного объекта и текущей формы. Read-only ID/is_system в `item` записи не входят.

Для PATCH active: `{ "expected_revision": "12", "is_active": false }`. Для DELETE: `{ "expected_revision": "12" }`. Для referrers: `{ "expected_revision": "12", "hosts": ["example.com", "www.example.com"] }`.

`revision` — непрозрачная для frontend десятичная строка, относящаяся ко **всей коллекции данного вида** внутри проекта. Это не timestamp и не ревизия строки. Она возвращается вместе с данными из согласованного snapshot. Без `expected_revision` mutation отклоняется с 400, при устаревшем значении — 409.

Любая успешная mutation увеличивает ревизию один раз и возвращает сохранённый нормализованный объект, а не копию request body. `application = {"mode":"next_scheduled_run"}` означает отложенное применение в отчётах; не возвращать выдуманные `applied_at`/`next_run_at`.

Для прямой ссылки на редактирование использовать detail endpoint. Данные draft содержат исходную ревизию, которую нельзя автоматически заменять новой при фоновом refetch.

### 7.4. Meta

Пример публичного ответа; поля `can_read/can_write` вычисляет Gateway:

```json
{
  "project_id": 123,
  "can_read": true,
  "can_write": true,
  "application": { "mode": "next_scheduled_run", "scheduled_query_configured": true },
  "resources": {
    "excluded-url-params": { "readable": true, "writable": true, "state": "ready" },
    "excluded-referrers": { "readable": true, "writable": false, "state": "migration_required" },
    "traffic-rules": { "readable": true, "writable": true, "state": "ready" },
    "attribution-signal-mappings": { "readable": true, "writable": true, "state": "ready" }
  }
}
```

Допустимые состояния: `ready`, `not_provisioned`, `migration_required`, `invalid_configuration`. При неготовности добавить стабильный `reason_code` и безопасное сообщение. Отсутствующая таблица не равнозначна существующему пустому списку.

Фактическая возможность изменения = пользовательское `can_write` AND `resource.writable`. Сервер перепроверяет готовность на mutation, frontend-флаг её не заменяет. Ошибки сети/IAM не выдавать за успешную meta с пустыми настройками.

`invalid_configuration` не всегда означает запрет всех операций: при корректной схеме/ревизиях отдельный invalid regex должен допускать исправление, отключение и удаление строки. Для такого случая `writable=true` и диагностика объясняет ограничение на включение/сохранение невалидного объекта. Если отсутствует безопасная адресация строки (например, дубли ID) или протокол ревизий, возвращать `writable=false` и требовать административного исправления.

### 7.5. Валидация

Request: `{ "resource": "traffic-rules", "item": { ... }, "id": "существующий ID или null" }`. Существующий ID нужен для контекста проверки, а не для изменения ID. Проверять его принадлежность данному проекту.

Response при проверяемом, но невалидном черновике:

```json
{
  "valid": false,
  "errors": [
    { "field": "source_regex", "code": "INVALID_REGEX", "message": "Invalid RE2 expression" }
  ],
  "warnings": []
}
```

Поле `field` использует имя доменного поля или понятный путь (`hosts[2]`). Структурно некорректный envelope — 400. Предварительный validate не гарантирует успешную запись: на save CMS заново проверяет итоговую конфигурацию и конкурентные ограничения. Отключение и удаление проблемной legacy-записи не блокировать из-за её невалидного regex; включение требует полной проверки.

### 7.6. Серверный URL preview

```json
{
  "url": "https://shop.example/chairs?utm_source=meta&category=garden",
  "item": { "param_key_regex": "utm_[a-z]+", "is_active": true }
}
```

```json
{
  "normalized_landing_page": "shop.example/chairs?category=garden",
  "excluded_keys": ["utm_source"],
  "retained_keys": ["category"],
  "warnings": []
}
```

Preview показывает действие **одного редактируемого исключения**. Это явно написано в UI. При `is_active=false` параметр не удаляется, остальная нормализация landing_page выполняется. В UI результат подписать «Нормалізована посадкова сторінка»: возвращается landing_page без протокола, а не исходный URL со слегка изменённым query.

Использовать ту же RE2-логику, anchoring, casing, обработку query и нормализацию landing_page, что у scheduled query. Не подменять точный preview JavaScript RegExp. Допускается параметризованный BigQuery-запрос по одному переданному URL без чтения сырых событий. Проверка не делает HTTP-запрос к введённому адресу и не открывает его. Новые запросы отправлять по кнопке «Проверить»; не запускать платный query на каждый символ. Ошибки и устаревшие ответы не должны заменять результат для другого черновика.

### 7.7. Ошибки

Для новых domain endpoints использовать уже поддерживаемую форму:

```json
{
  "error": {
    "status": 409,
    "code": "TRAFFIC_SETTINGS_REVISION_CONFLICT",
    "message": "Settings have changed",
    "details": { "resource": "traffic-rules", "current_revision": "13" }
  }
}
```

| HTTP | Код/ситуация | Поведение UI |
| --- | --- | --- |
| 400 | `REQUEST_VALIDATION_ERROR`, field errors | Ошибки рядом с полями, черновик сохраняется |
| 401 | Пользовательская auth | Существующий reauth frontend |
| 403 | Permissions/demo | Read-only или сообщение об отсутствии доступа |
| 404 | `TRAFFIC_SETTING_NOT_FOUND` | Запись удалена, предложить возврат к списку |
| 409 | `TRAFFIC_SETTINGS_REVISION_CONFLICT` | Загрузить актуальные данные и разрешить конфликт |
| 409 | `TRAFFIC_RULE_PRIORITY_CONFLICT` | Показать конфликтующие правила |
| 409 | `TRAFFIC_SETTINGS_MIGRATION_REQUIRED`, `TRAFFIC_SETTINGS_INVALID_CONFIGURATION` | Пояснение неготовности, без ложного «пусто» |
| 413 | Слишком большой request | Понятное ограничение размера |
| 429/503 | Квота, временная недоступность ресурса | Повтор чтения или сохранение черновика |
| 502/504 | Ошибка/timeout downstream | Исход операции может быть неизвестен, см. ниже |

Существующие ошибки auth middleware Gateway могут иметь старую плоскую форму `{error,message}`. Новый frontend API adapter должен понимать обе, без глобального изменения старых API.

Gateway не должен превращать доменные 400/404/409 в 200/undefined или всегда в 500. Использовать `HttpException` и сохранять безопасные `details`. Downstream 401 от CMS из-за неверного сервисного credentials — это 502 для пользователя, а не повод обновлять его JWT. Не пересылать наружу SQL, service account, dataset identifiers или сырые стеки ошибок.

Timeout mutation не означает гарантированный rollback: запрос в BigQuery мог завершиться. Не ретраить мутации автоматически с новой ревизией и не показывать «точно не сохранено». Сохранить draft, сообщить о неизвестном результате, перечитать данные перед повторной явной попыткой пользователя. Повтор того же request с прежней ревизией не должен создать вторую запись.

## 8. Атомарность, ревизии и хранение

Добавить в dataset проекта служебную таблицу `traffic_settings_revisions`:

| Поле | Тип | Смысл |
| --- | --- | --- |
| `resource` | STRING REQUIRED | Одно из четырёх canonical имён таблиц с underscores |
| `revision` | INTEGER REQUIRED | Монотонная версия коллекции, начальная 1 |
| `updated_at` | TIMESTAMP REQUIRED | Момент последнего изменения |
| `updated_by` | STRING NULLABLE | Доверенный actor ID Gateway; для миграции null |

На проект — ровно четыре строки. Создавать таблицу и начальные строки в controlled provisioning/migration, а не конкурентным lazy insert на каждом GET. При наличии таблицы проверить уникальность resource; не обнулять revision при повторном deploy. Физическое размещение и location совпадают с domain tables. Зарегистрировать служебный ресурс в типах/repository CMS по принятым соглашениям.

Каждая mutation — **одна multi-statement BigQuery transaction**:

1. Проверить ровно одну revision-строку и совпадение `expected_revision`.
2. Условно обновить её и проверить результат; это часть той же транзакции.
3. Прочитать/проверить изменяемый объект и ограничения текущей коллекции.
4. Выполнить INSERT/UPDATE/DELETE доменной записи либо замену hosts.
5. Проверить количество затронутых строк; для операции над ID оно должно быть 1. Дубли ID — диагностируемая ошибка, не «обновить всё».
6. Commit и вернуть соответствующие результат и новую ревизию из этого выполнения. При ошибке rollback всех изменений.

Чтение коллекции/одного объекта с revision должно использовать единый согласованный snapshot. Недопустимы два несогласованных запроса «сначала данные, затем актуальная ревизия». Это касается и нормализованного списка referrers.

Конкурентная отмена транзакции BigQuery не равна произвольной 500: перечитать revision, вернуть 409 при её изменении; при временном конфликте другого вида допустим ограниченный повтор **с тем же expected_revision**, никогда с новым. При неопределённом исходе commit автоматический повтор не выполнять. Процессный mutex одного Node-инстанса не заменяет транзакцию в Cloud Run.

Описанный механизм обеспечивает конкурентность операций этой feature. Прямые ручные SQL-изменения domain tables должны во время эксплуатации также обновлять ревизию через административный путь/ту же транзакцию; произвольные внешние SQL writers без участия в протоколе в гарантию не входят. Указать это в operator runbook.

BigQuery поддерживает атомарные DML-изменения нескольких таблиц и snapshot isolation; постоянный DDL нужно выполнять отдельно от таких транзакций. Это основание выбранного подхода, детали проверить при реализации по [документации транзакций BigQuery](https://docs.cloud.google.com/bigquery/docs/transactions).

## 9. Валидация RE2 и обязательное исправление SQL URL-исключений

Сейчас `update-costs-and-calculate-attribution.sql` дважды собирает общий шаблон через `string_agg(replace(param_key_regex, "'", ''), '|')`, подставляет его как raw string в dynamic SQL и сравнивает с `kv`, где есть `key=value`. Это создаёт три проблемы для пользовательского редактора: молчаливое изменение кавычек, хрупкое SQL-экранирование и несоответствие обещанию «regex полного ключа» для `^fbclid$`.

Исправить обе ветки: visits и ad_costs.

1. Передавать regex/массив regex через query parameters либо `EXECUTE IMMEDIATE ... USING`, без текстовой вставки пользовательского содержимого в SQL.
2. Из `kv` выделять имя ключа до первого `=` и применять regex к нему, сохраняя остальную действующую логику нормализации URL. URL decoding ключей не добавлять незаметно: действующий разбор query для landing_page работает с raw query; одинаковую семантику закрепить в preview.
3. Каждый pattern применять как полное case-insensitive совпадение. Предпочтительно независимая проверка каждого активного pattern с локальным контекстом flags, чтобы один regex не менял поведение соседнего. `^...$`, alternation, кавычки и backslash должны сохранять смысл.
4. Пустой список исключений ничего не исключает. Обрабатывать повторяющиеся ключи, пустые значения и key без `=` одинаково в обоих местах и preview.
5. Использовать одну согласованную реализацию/SQL helper для формирования проверки и покрыть parity-тестами. Не менять порядок обработки атрибуции, условия rules/mappings и схему конечных visits/ad_costs ради UI.
6. Все ненулевые regex в URL rules, traffic rules и mappings валидировать с семантикой BigQuery RE2 до записи. Валидация должна проверять и фактическую обёртку flags/anchors, а не только отдельно введённую строку.
7. Не считать `new RegExp(...)` достаточной серверной проверкой. Для первой версии допустима пакетная параметризованная проверка выражений в BigQuery с отчётом по каждому полю; не читать для этого пользовательские события. Если используется локальный RE2 engine, доказать паритет тестами с BigQuery.
8. Не использовать `SAFE`-проверку так, чтобы синтаксическая ошибка превращалась в валидный шаблон «ничего не совпало». Возвращать field-level error.

GoogleSQL использует RE2, а `REGEXP_CONTAINS` проверяет частичное совпадение, поэтому полное сопоставление нужно задавать явно. См. [REGEXP_CONTAINS](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/string_functions#regexp_contains). Передача параметров в dynamic SQL описана в [EXECUTE IMMEDIATE](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/procedural-language#execute_immediate).

Обновление файла в репозитории **не обновляет уже развернутую scheduled query**. Миграция ниже обязана обновить query существующего transfer config и проверить успех до включения записи URL-исключений.

## 10. Задачи CMS

Ниже — предлагаемая файловая структура новых модулей. Допускается эквивалентная структура по соглашениям репозитория.

```text
src/presentation/router/traffic-settings.router.ts
src/presentation/controllers/traffic-settings.controller.ts
src/presentation/api-schemas/traffic-settings/
src/presentation/api-validation/traffic-settings/
src/application/use-cases/traffic-settings/
src/modules/traffic-settings/
src/modules/gcloud/bigquery/schemas/v1/bigquery.traffic_settings_revisions.schema.ts
src/presentation/docs/v1/traffic-settings.yaml
scripts/migrate-traffic-settings.ts
```

1. Создать domain types/DTO для четырёх ресурсов, результатов validate/preview/meta и ревизий. Списки колонок для SQL — явный allowlist, согласованный со схемами.
2. Подключить router в `src/index.ts` через существующий `App`, сохранив `/api/v1` prefix. У всех routes — service auth, positive project ID validation, DTO validation.
3. Реализовать project context resolver через `ProjectResourcesRepository`: GCP project, dataset ID, dataset location и реальные table IDs. Отсутствующие ресурсы — отдельный результат, не повод выбирать другой dataset или EU по умолчанию.
4. Расширить `BigQueryApi` или добавить специализированный repository с методами параметризованных SELECT/DML, возвратом результатов, metadata/table type inspection и контролем завершения query job. Существующий `runQuery(query): Promise<void>` оставлять совместимым: одного его недостаточно для нового CRUD.
5. Для nullable values и пустых массивов передавать явные типы параметров BigQuery. Правильно преобразовывать BigQuery INTEGER/revision в API; не отдавать SDK-wrapper объекты клиенту.
6. Реализовать transactional CRUD, optimistic concurrency, конфликты priority, проверку уникальности ID и параметризованную замену hosts.
7. Для query значений не использовать template string interpolation. Список изменяемых колонок не получать напрямую из произвольных request keys.
8. Ввести готовность ресурсов: реальные table metadata, актуальность схемы, корректность служебной revision-таблицы, migrated URL normalization/query version. Readable legacy view можно вернуть read-only, но не пробовать UPDATE view.
9. Обновить provisioning новых проектов: существующие четыре schemas + revision table, системные seeds только при первом создании соответствующей domain table. Repeated deploy не меняет данные и ревизии пользователя.
10. Добавить целевое обновление **query текста существующего transfer config** через BigQuery Data Transfer API. Сохранить config name, расписание, destination dataset, location, service account и состояние enabled/disabled; не удалять/создавать job заново для этой feature. Если для legacy-проекта нет ожидаемого unified job, показать preflight-диагностику и сначала выполнить существующую подходящую миграцию, не угадывать job по похожему имени.
11. Реализовать validate/preview с тем же движком и семантикой, которыми пользуется запись/расчёт. Preview и validate ничего не сохраняют, не увеличивают revision и не запускают attribution job.
12. Добавить стабильные domain error codes в `errors.constants.ts`, использовать существующий `HttpException`. Не ломать другие контроллеры, ожидающие старую сигнатуру ошибок.
13. После подтверждённого commit писать структурированный audit log: request ID, actor ID, project ID, resource, item ID (если есть), action, before/after revision, changed field names, success/failure. Не логировать credentials, весь request headers, сырые URLs или полные пользовательские regex без необходимости.
14. Обновить OpenAPI и инструкции env/provisioning/migration. Журнал версий в UI и отдельный audit-storage в первую версию не входят.

Не изменять поля `visits`, `ad_costs`, `attributed_ad` и алгоритм ad resolution ради отображения новых настроек. Не менять текущие seeds, за исключением исправления обнаруженного несовместимого выражения с отдельным доказательством необходимости; новые defaults не распространять автоматически по существующим проектам.

## 11. Задачи Gateway

Предлагаемые новые модули:

```text
src/router/traffic-settings/index.js
src/controllers/traffic-settings/index.js
src/services/cloud-management/traffic-settings.js
src/docs/v1/traffic-settings.yaml
```

1. Mount router с `{ mergeParams: true }` в `src/router/organization/index.js` по `/:organizationId/projects/:projectId/traffic-settings`. Пользовательские auth/check-email middleware верхнего уровня сохраняются.
2. Для каждого route назначить read/update permission согласно разделу 5. POST validate/preview — чтение, POST create — изменение; не определять право только по HTTP-методу.
3. У всех мутаций — demo restriction. Проверить permissions и project ownership до исходящего запроса. Отклонять попытки подменить project/actor в body.
4. Реализовать единый клиент CMS: service credentials, явный timeout, корректные HTTP methods/body, передача request ID, безопасная обработка ошибок. Не следовать произвольному upstream URL из client input.
5. В actor header, например `X-Strimix-Actor-Id`, передавать только `req.user.id`; не доверять одноимённому входящему заголовку браузера. CMS принимает его только от авторизованного Gateway.
6. Нормализовать ответы upstream ошибок. Сохранять field details и revision conflicts. Ошибки соединения → 502, timeout → 504; service auth failure не отдавать как пользовательский 401. Не оставлять `.catch`, который проглатывает ответ и возвращает undefined.
7. В публичный `/meta` добавить эффективные пользовательские права, включая деморежим, и объединить их с CMS resource readiness. Не возвращать credential headers, внутренние адреса, GCP identifiers.
8. Добавить env validation и документировать новые переменные:

| Переменная | Смысл |
| --- | --- |
| `TRAFFIC_SETTINGS_ENABLED` | Feature flag Gateway, по умолчанию false до rollout |
| `CLOUD_MANAGEMENT_SERVICE_URL` | Полный base origin CMS для данного окружения, без `/api/v1` suffix |
| `CLOUD_MANAGEMENT_SERVICE_AUTHORIZATION_CODE` | Сервисный код, согласованный с CMS |
| `CLOUD_MANAGEMENT_SERVICE_TIMEOUT_MS` | Явный timeout; default 60000, согласовать с CMS/Cloud Run |

При выключенной feature новые credentials не должны ломать запуск старого Gateway. При включении flag отсутствие/невалидность обязательных параметров должно выявляться при старте. Не брать адрес CMS из `TENANT_SERVICE_*`: это другой сервис.

При выключенной feature возвращать контролируемый `404 TRAFFIC_SETTINGS_FEATURE_DISABLED` для новых routes. Существующие проектные endpoints продолжают работать.

9. Добавить domain OpenAPI: все методы, enums, success/error envelopes, revision, role restrictions. Не менять глобально контракт существующих endpoints.
10. Добавить исполняемый test script для новой feature. Текущий `npm test` в Gateway — заглушка с exit 1; это нельзя считать выполненной проверкой. Использовать совместимый с фактической версией Node тестовый инструмент, без обязательного обновления runtime всего сервиса.

## 12. Задачи frontend

### 12.1. Навигация и маршруты

Добавить ссылку в группу «Проєкт» после существующих пунктов. Предлагаемые маршруты:

```text
/project/traffic-attribution
/project/traffic-attribution/url-parameters
/project/traffic-attribution/referrers
/project/traffic-attribution/rules
/project/traffic-attribution/rules/new
/project/traffic-attribution/rules/:ruleId/edit
/project/traffic-attribution/signals
/project/traffic-attribution/signals/new
/project/traffic-attribution/signals/:mappingId/edit
```

Root раздела переводит на `/rules`. Вкладки имеют реальные URLs, работают прямые ссылки, back/forward и reload. Сохранение возвращает к соответствующему списку, отмена не делает запрос записи. Drawer URL/domain может оставаться локальным состоянием страницы; URL для каждого drawer не обязателен.

Новый пункт выбран и группа раскрыта для всех дочерних edit/new routes. Сейчас в Sidebar сравнивается точное равенство pathname: для нового поддерева добавить корректное сопоставление вложенных путей, не ломая selected-состояние остальных групп.

Project/organization берутся из активного workspace. При отсутствии проекта показывать существующий select-project state и не отправлять запросы с null ID. При смене проекта очищать данные старого списка и черновик с подтверждением, если он изменён. Ответ запроса старого проекта не должен попасть в форму нового.

### 12.2. Предлагаемые модули

```text
src/views/projects/TrafficAttribution/
src/views/projects/TrafficRuleEditor/
src/views/projects/AttributionSignalEditor/
src/components/projects/traffic-attribution/
src/interfaces/domain/projects/traffic-settings.interface.ts
src/api/traffic-settings/index.ts
```

Состав компонентов можно адаптировать. Использовать текущие React 18, MUI, RTK Query, формы и feedback. Не добавлять вторую дизайн-систему или новый глобальный state manager.

### 12.3. Общие UI-требования

- Стили по макетам: бирюзовый primary, белая карточка, серый workspace, табличная структура, спокойные badges происхождения/режима. Не переносить панель «ЕСКІЗИ», demo project label, демоданные и ссылки на галерею в продукт.
- UI uk/en/ru: navigation, tabs, labels, hints, mode/stage names, errors, empty/loading/conflict states, aria labels. Поддерживать выбранную пользователем локаль. Поля `description`, outputs и regex — пользовательские данные, не переводить через i18n.
- Поиск и фильтры: активность; системные/собственные там, где существует `is_system`; stage для traffic rules. Счётчики отражают реальный API dataset, не заглушки.
- Сортировка/пагинация визуальные; не меняют приоритеты. Пустой результат поиска отличается от пустой коллекции.
- Loading, initial request error с retry, empty state с CTA, read-only state, resource not provisioned/migration required, invalid configuration.
- Изначально загрузить `/meta` и текущую вкладку. Не выполнять загрузку всех коллекций многократно на каждый render или изменение поиска.
- Пока запись выполняется, блокировать повторный submit и конфликтующие действия над ней. Успешный toast — после ответа сервера. Для BigQuery latency предпочтительно подтверждённое обновление списка; если используется optimistic switch, обязательно rollback и сообщение об ошибке.
- Длинные regex и имена не ломают таблицу. Полное значение доступно в форме/tooltip/copy. У необязательных технических ID — read-only advanced block.
- Escape/отмена drawer, корректный focus, подписи кнопок удаления и переключателей, клавиатурный доступ. Dialog удаления показывает домен/результат правила/ID и не подтверждает сам себя.
- Dirty-form protection: переход на другую вкладку/проект/страницу и browser close/reload; существующий draft сохраняется при ошибке API. Не делать silent autosave при уходе.
- На узком экране формы в один столбец, summary после формы, таблицы прокручиваются внутри контейнера; вся страница не получает горизонтальное переполнение.

### 12.4. URL-исключения — экраны 01/02

Список: активность, regex параметра, описание, происхождение, действия. Drawer: regex, description, active, readonly происхождение/ID и серверный пример URL. Показать, что очищается landing_page и что атрибуционные поля не удаляются.

Предпросмотр — явная кнопка с loading/error и результатом API; preview не сохраняет изменения. При изменении формы отметить прежний результат как устаревший, а не показывать его как актуальный. Отключение исключения и удаление доступны системным строкам тоже.

### 12.5. Рефералы — экран 03

Строки hostname, «точный домен», edit/delete. Кнопка добавления открывает multiline drawer «каждый домен с новой строки»; показать итог нормализации и повторы. Поддержать редактирование одного домена, удаление с подтверждением и пустой список.

Сохранять полный актуальный список с исходной ревизией. Не превращать race на два добавления в потерю чужого домена. Нет is_active, флагов системности, wildcard/subdomain mode или несуществующего description.

### 12.6. Правила — экраны 04/05

Список: активность, priority, stage, вычисленный результат, компактные условия, target, происхождение, действия. Три визуальных этапа работают как фильтр. Пояснить per-field semantics UTM и first-match semantics origin/channel.

Редактор: применение → AND-условия → outputs → advanced ID/active. Справа — текстовый итог конфигурации, обновляемый из формы. Это summary, а не результат реального расчёта на событиях.

Показать все поля раздела 6.4, включая редко используемые в сворачиваемых блоках. Один condition field не добавляется дважды. При stage switch несовместимые значения убираются только после понятного предупреждения. Показывать зависимые подсказки о web/ad-derived/url_params. Для пустого набора условий предупреждать «правило применяется ко всем подходящим записям», но разрешать такую конфигурацию.

Не вводить редактируемое «название правила» без поля в API. Человекочитаемую подпись выводить из outputs; ID доступен дополнительно.

### 12.7. Сигналы — экраны 06/07

Список: активность, priority, вычисленная подпись + ID, entity/container, краткие field mappings, fallback/override, действия.

Редактор: источник/контейнер/event → 12 mappings полей → 12 applicability filters → отдельные resolution boundaries → mode → ID/active. Продвинутые поля можно сворачивать, но нельзя терять их при сохранении.

Выбор entity меняет контейнер. `fallback` и `override` сопровождать понятным текстом, не только английским enum. У override показать последствие: источник конверсии может определяться сигналом даже при наличии вебатрибуции. Условия по ad name чувствительны к регистру, boundaries визуально отделены от `match_*`.

### 12.8. RTK Query и конфликты

1. Новые endpoints подключить через `apiSlice.injectEndpoints` к существующему baseQueryWithReauth; не создавать обход auth-потока.
2. Добавить tags на project+resource, например `{type:'TrafficSettings', id:'organizationId:projectId:traffic-rules'}`, отдельные tags meta/details при необходимости. Mutation проекта A не должна инвалидировать draft проекта B.
3. На успешный save обновить/инвалидировать соответствующие list/detail/meta данные. Не инвалидировать все отчёты как будто они уже пересчитаны.
4. На 409 показывать dialog: «Настройки изменились», сохранить локальный draft, дать загрузить актуальные данные и явным действием повторно применить свои изменения после просмотра. Не подставлять свежую ревизию под старую форму автоматически.
5. При удалении редактируемой записи другим пользователем показать 404-state; не создавать её заново скрытым POST.
6. URL preview и validate имеют request-specific keys; старый ответ не должен перезаписать результат нового ввода.

## 13. Миграция и совместимость существующих проектов

### 13.1. Инструмент миграции

Реализовать в CMS отдельный повторно запускаемый script, по умолчанию **dry-run**. Предлагаемый интерфейс, который нужно документировать и сделать рабочим:

```sh
npx tsx scripts/migrate-traffic-settings.ts --project-id 123 --dry-run
npx tsx scripts/migrate-traffic-settings.ts --project-id 123 --apply
```

`123` — пример, не реальный целевой проект. Для нескольких проектов допускается повторяемый `--project-id`/явный файл списка. Не делать миграцию всех production datasets по умолчанию. Среду и credentials брать из согласованной конфигурации; не хранить секреты в документе или migration log.

Dry-run должен показать:

- Реальный GCP project/dataset/location из ProjectResources.
- Существование/type/schema каждой из четырёх таблиц и revision table.
- Наличие legacy `excluded_referrers` view, текущую структуру hosts и объём данных.
- Дубли ID/resource, недопустимые enums/типы, invalid regex, нарушения cross-field invariants, конфликты priority и слишком длинные значения.
- Ссылку на текущий unified transfer config, его query hash/version и различия планируемого обновления.
- Точные действия и backup/rollback plan; ничего не изменять.

### 13.2. Применение

1. Сохранить восстанавливаемые backup данных и схем изменяемых таблиц, описание legacy view и прежний query/settings transfer config. Зафиксировать расположение backups и project ID в отчёте выполнения.
2. Если существующие domain tables корректны, не пересоздавать их и не перезаписывать данные.
3. Missing optional columns добавить безопасно через совместимую schema migration. Для несовместимых типов/отсутствующих обязательных данных не подставлять выдуманные бизнес-значения: выдать отчёт и оставить ресурс read-only до явного исправления.
4. Отсутствующие таблицы создаются по текущим схемам. Системный seed добавляется только при первом создании URL/traffic table; существующая пустая таблица может быть результатом осознанного удаления всех defaults и не должна автоматически засеиваться.
5. `attribution_signal_mappings` для нового проекта остаётся пустой. `excluded_referrers` для нового проекта — пустой логический список. Не использовать клиентские migration fixtures из `tasks/keycrm-source-id-attribution` как defaults.
6. Существующие несколько rows массива hosts можно атомарно привести к одной строке только с сохранением логического множества. Если обнаружены семантически сомнительные старые значения — остановить запись этого ресурса и вывести диагностику.
7. Создать revision table, инициализировать ровно четыре записи и проверить их уникальность. Повторный запуск не уменьшает revision.
8. Обновить query существующего scheduled transfer config целевым API и проверить, что новые regex semantics развернуты, а остальные параметры job сохранены. Код должен регистрировать version/hash миграции только после фактического успеха внешней операции.
9. Обновить отсутствующие ссылки на resources в CMS repository, не изменяя существующую корректную привязку к GCP project/dataset.
10. Выполнить postflight: count/ID/hosts preservation, повторное чтение API, проверка нового query, diff seed rows. Повторный dry-run должен показывать отсутствие незавершённых действий.

### 13.3. Legacy view рефералов

В текущем deploy-коде прямо указано, что старые проекты могут сохранить view `excluded_referrers` до отдельной миграции. Такой ресурс нельзя считать обычной редактируемой таблицей.

Нужен отдельный путь миграции:

1. Сохранить SQL definition view, schema и полный snapshot получаемых hosts.
2. Подготовить и проверить staging table с тем же логическим списком.
3. На период замены обеспечить отсутствие параллельной миграции/атрибуционного прогона и закрыть запись настроек проекта.
4. Выполнить замену view на table с сохранением имени и schema `hosts STRING REPEATED`, проверить результат и вернуть scheduled processing в прежнее enabled/disabled состояние.
5. При сбое иметь исполняемый rollback из сохранённого definition/snapshot; не оставлять имя ресурса отсутствующим.

Не заявлять транзакционность последовательности `DROP VIEW` + `CREATE TABLE`: постоянный DDL не является частью DML-транзакции раздела 8. Окно замены — управляемая административная операция с проверенным восстановлением. GET/PUT из UI не запускают её автоматически.

### 13.4. Старые некорректные конфигурации

Не удалять invalid rows автоматически и не исправлять regex «по догадке». Для читаемых данных показать диагностику, позволить read-only просмотр, отключение/удаление проблемной записи и её исправление, если это безопасно. Ошибка одной старой строки не должна подменяться пустым списком всего проекта.

Если отсутствие ревизий/таблицы/совместимой схемы делает безопасную запись невозможной, весь соответствующий ресурс read-only с `migration_required`. Не объявлять feature готовой для проекта, если обязательная миграция там не выполнена.

## 14. Проверки

### 14.1. CMS: domain и repository

Обязательные проверки реального поведения, а не только snapshot моков:

1. CRUD трёх ID-ресурсов и замена hosts, включая пустые коллекции; системные записи доступны для edit/disable/delete, а `is_system` сохраняется.
2. Round-trip **всех** полей traffic rules и mappings, включая hidden advanced, null, false, 0, negative priority и ранее существующие пустые строки.
3. Parameterized SQL сохраняет кавычки, backslash и пользовательские значения; невозможно выбрать другую таблицу/dataset через body/ID.
4. Две конкурентные мутации с одной revision: успешно фиксируется не более одной; другая получает conflict. В refs нет окна пустой таблицы и потерянного параллельного добавления.
5. Невалидная запись/priority conflict не меняет ни доменные данные, ни revision. Дубли ID обнаруживаются, не массово обновляются.
6. Удаление/отключение invalid legacy rule возможно; включение invalid rule невозможно.
7. Stage/output/target constraints, URL value без key, entity/container pairs, match-filter без mapped key, placeholder allowlist.
8. Priority collision: одинаковый этап+пересекающийся target+активность запрещают новый конфликт; разные этапы или visit/ad_cost без пересечения допустимы. Mapping tie остаётся детерминированным по mapping_id.
9. Реальная RE2-валидация: `(?i)` работает; lookbehind/backreference не принимаются; syntax error привязан к правильному полю; пустой condition, если он сохранён явно, не приравнивается к отсутствующему.
10. Location EU и US передаётся корректно. У проекта без ресурсов ошибка готовности, а не запрос в default dataset.

Для BQ-dependent пунктов нужен запуск на **выделенном тестовом dataset** в согласованном окружении. Unit tests с mock клиента сами по себе не подтверждают транзакции, RE2 и multi-statement SQL. Если credentials/тестовая среда недоступны, закончить остальную работу, подготовить исполняемые integration tests и явно указать непроверенную часть; не писать «всё проверено».

### 14.2. Паритет URL normalization

Один набор fixtures должен проверять server preview, visits SQL и ad_costs SQL:

| Вход/настройка | Ожидаемый результат |
| --- | --- |
| `utm_source=meta&category=garden`, active `utm_[a-z]+` | Удалён только UTM, category сохранена |
| `UTM_SOURCE=Meta` | Ключ исключается без учёта регистра |
| `custom_utm_source=meta` | Не исключается шаблоном `utm_[a-z]+` |
| `fbclid=123`, шаблон `^fbclid$` | Исключается полностью якоренным шаблоном |
| Несколько active patterns с alternation/inline flags | Один pattern не меняет flags другого |
| Кавычка/backslash в RE2 pattern | Не удаляется, не ломает dynamic SQL |
| Нет active patterns / правило выключено | Query-параметры не исключаются |
| Повторяющиеся ключи, пустое значение, ключ без `=` | Согласованный результат обеих веток и preview |
| Fragment `#...`, разный порядок query, `www.`, хвостовой `/` | Сохраняется действующая нормализация landing_page |
| Percent-encoded key | Поведение явно закреплено и одинаково; без скрытого нового decoding |

Сравнивать и итоговый landing_page, и сохранность атрибуционных меток. Не достаточно проверить лишь число удалённых query params.

### 14.3. Gateway

- Полная role matrix, включая org admin без отдельного project membership, project.user/viewer read-only, sharedReportViewer deny, demo write deny.
- Чужой projectId, несоответствие organization/project, неактивный проект и отсутствующий JWT не приводят к вызову CMS.
- Корректные path/body/method/credentials, expected_revision и actor forwarding; spoofed actor/header/body project не принимаются.
- Публичный body ошибок, field errors, 409 и 404 сохраняются; CMS 401 → 502; timeout → 504; network error не превращается в успешный ответ.
- Feature выключена → новые endpoints закрыты, остальные routes работают.

### 14.4. Frontend

- Меню, прямые URLs, reload/back/forward, selected parent для вложенного edit route.
- Empty/loading/error/retry/read-only/migration-required, реальные счётчики и фильтры.
- Поля stage/target/entity зависимы; hidden fields сохраняются; null/false/0 не теряются.
- Успех save только по API response; failed switch откатывается; double submit не создаёт две записи.
- Изменённая форма не теряется при ошибке, конфликте и отменённом выходе. На 409 нет silent overwrite.
- Смена проекта не показывает старые строки; запоздалый API/preview response не перезаписывает другой draft.
- Keyboard/focus/aria, uk/en/ru, viewport около 390 px и desktop 1440–1600 px.
- В продукте нет mock counts, CRM sample seed, панели прототипа и hardcoded организации Fiskars.

### 14.5. Contract tests между сервисами

Создать согласованный набор request/response fixtures для всех новых методов и проверять им CMS API, Gateway proxy и frontend adapters. Включить success, field error, revision conflict, resource not ready, read-only meta, service-auth failure и timeout. Особо проверить nullable booleans, `revision` как строку, полный PUT без read-only полей, DELETE с body и сохранение статуса 201. Дублировать общий контракт вручную в трёх несовместимых вариантах нельзя; OpenAPI и fixtures должны фиксировать одну форму сообщений.

### 14.6. Сквозные сценарии приёмки

**A. URL-исключение.** Администратор создаёт собственный `debug_id` → preview удаляет его и сохраняет `category` → запись реально присутствует в нужном dataset → после согласованного тестового attribution run landing_page visits/ad_costs изменяется одинаково → исходные метки доступны → отключение возвращает поведение без этого исключения.

**B. Реферал.** Добавление `pay.example`, отдельного `checkout.pay.example`, нормализация duplicate input → новый read возвращает оба точных hosts → чужая вкладка с прежней revision не затирает список → после обработки события домен не используется как referral-источник, явные UTM работают.

**C. Правила трафика.** На тестовых данных два UTM правила заполняют разные outputs по per-field priority, после них origin/channel дают ожидаемый результат. Изменение одного системного правила сохраняет `is_system=true`. Удалённое системное правило не возвращается после повторного deploy/job.

**D. Mapping.** Тестовый order.custom_params содержит source/ad name; mapping извлекает только указанные поля, фильтрует applicability, ищет ad в заданных boundaries и создаёт synthetic visit с существующей семантикой. Fallback при наличии предшествующей размеченной вебатрибуции не создаёт его; override создаёт. Отсутствующий входной param не подменяется стандартным ключом.

**E. Tenant/roles.** Пользователь с edit-доступом проекта A не может читать/менять проект B через смену URL. Viewer может просматривать A, но любой прямой mutation request запрещён. Shared report viewer не видит настройки.

**F. Existing project.** Миграция legacy view сохраняет логическое множество hosts и scheduled settings; повторный запуск не меняет seeds, пользовательские данные и ревизии. Rollback проверяется на тестовом проекте.

Примеры выше — fixtures только тестового окружения. Ни `pay.example`, ни `debug_id`, ни пример CRM mapping нельзя оставлять в production-конфигурациях после проверки.

## 15. Локальные команды и отчёт о проверках

Использовать package manager по lockfile репозитория. Не обновлять весь lockfile ради новой feature. На момент анализа команды:

| Репозиторий | Обязательный минимум |
| --- | --- |
| CMS | `npm run build`; проверка изменённых файлов ESLint; новый целевой test command + BQ integration tests |
| Gateway | Новый исполняемый test command; синтаксис/ESLint изменённых JS; запуск приложения с тестовой конфигурацией |
| Frontend | `npm run build`; целевые tests через текущий craco test; ESLint изменённых TS/TSX; browser smoke |

CMS использует TypeScript/Zod; Gateway — CommonJS JavaScript; frontend — существующий CRA/CRACO. Не предполагать наличие test runner, которого нет в package.json. Общие lint/build failures, существовавшие до работы, отделить от новых; не менять посторонние модули для косметического «зелёного» отчёта.

Сохранить проверочный отчёт: команды, результаты, окружение, перечень integration scenarios, screenshots UI и непроверенные условия. Старый `docs/design/.../validation.txt` относится к HTML-прототипу и **не является тестированием реализованной feature**.

## 16. Выпуск и откат

### 16.1. Feature flags и конфигурация

Frontend: добавить `REACT_APP_TRAFFIC_SETTINGS_ENABLED`, default false до rollout. Передать build argument через `Dockerfile`, `cloudbuild.yaml` и workflow; изменения runtime env уже собранного nginx image недостаточно для React build-time переменной. При выключенном flag скрыть меню и закрыть новые frontend routes.

Gateway: `TRAFFIC_SETTINGS_ENABLED` и CMS connection vars из раздела 11. CMS: новая разрешённая app auth запись Gateway в `APP_AUTHORIZATION_CODES`; действующие BigQuery credentials должны иметь права на чтение, query jobs и DML целевых конфигураций. Миграционному исполнителю дополнительно нужны schema/view и transfer config update permissions. Не выдавать браузеру эти права или секреты.

Флаг не заменяет permissions и resource readiness. Расписания, реальные credentials и target project IDs не выдумывать. Значение `every 6 hours` сейчас присутствует в исходном scheduled query config, но UI не должен выдавать его за точное время следующего запуска каждого проекта.

### 16.2. Порядок rollout

1. Подготовить согласованные ветки/PR трёх репозиториев и точный контракт. Проверить локальные builds/tests и review миграции.
2. Развернуть CMS с новыми backward-compatible endpoints и выключенной пользовательской feature. Старые API должны продолжать работать.
3. Настроить Gateway→CMS service authorization и deploy Gateway с feature flag false.
4. На выделенном тестовом проекте выполнить dry-run/apply миграции, обновить deployed SQL, прогнать BQ integration и сквозные сценарии.
5. Подготовить и выполнить миграцию явно согласованного списка действующих проектов с backups/postflight. Для проекта с незавершённой миграцией UI остаётся read-only/not ready.
6. Включить Gateway feature в целевом окружении, проверить реальные endpoints и роли.
7. Собрать/deploy frontend с feature flag true и провести browser smoke на новом и существующем проекте.
8. Проверить первый успешный плановый/контролируемый тестовый attribution run, ошибки RE2/DML и сохранность report semantics. Ручной запуск production-пересчёта не является автоматической частью обычного пользовательского save.

Текущие CMS и Gateway workflows запускают Cloud Run deploy на push в `master`. Frontend deploy использует `master`/`develop` для разных окружений. Поэтому push/merge в эти ветки — релизное действие, а не способ проверить сборку. Сначала сделать конкретные изменения и пройти проверки; затем использовать согласованный release-процесс.

Если исполнитель не получил target environment, project IDs или права на релиз, он должен закончить код, миграции, тесты, PR/артефакты и дать конкретный список оставшихся внешних параметров. Не считать функцию deployed без фактического выпуска. Запрашивать отсутствующие параметры для релиза после подготовки проверяемого результата, не останавливать из-за них независимую реализацию.

### 16.3. Rollback

1. Выключить Gateway feature и скрыть frontend-раздел/откатить его image; существующие данные конфигураций не удалять.
2. Откатить CMS/Gateway app images при необходимости. Добавленная служебная таблица и optional columns должны быть совместимы со старым кодом.
3. Если откатывается scheduled SQL, сначала проверить совместимость сохранённых пользователями regex с прежней обработкой. Не возвращать небезопасную старую интерполяцию при наличии новых выражений без анализа/восстановления конфигурационного snapshot.
4. Legacy view восстанавливать только по отдельному проверенному плану; учитывать пользовательские изменения, появившиеся после миграции. Не заменять новые данные старым backup молча.
5. Зафиксировать, что было возвращено, какие данные сохранены и какой transfer config/query сейчас активен.

## 17. Definition of Done

Функция готова к приёмке, когда выполнены все пункты:

- [ ] В трёх репозиториях есть согласованная реализация; реальные запросы проходят всю цепочку frontend → Gateway → CMS → BigQuery.
- [ ] Раздел расположен в «Проєкт», четыре вкладки и редакторы соответствуют дизайну и ТЗ.
- [ ] Все поля четырёх схем доступны и сохраняются без потери hidden/nullable значений.
- [ ] Работают CRUD, активация там, где поле существует, системные записи редактируются и не восстанавливаются самопроизвольно.
- [ ] Tenant isolation и новая матрица прав проверены через API, а не только скрытием кнопок.
- [ ] URL preview использует серверную RE2/normalization semantics; обе SQL-ветки исправлены и parity-тесты пройдены.
- [ ] Ревизии и атомарные изменения предотвращают потерю параллельных правок; ошибки/timeout сохраняют draft и не вызывают слепой retry.
- [ ] Есть dry-run/apply migration, backups, postflight и rollback для existing projects и legacy referrer view.
- [ ] SQL существующего transfer config обновляется целевым механизмом; одна замена файла в image не считается миграцией job.
- [ ] Есть uk/en/ru, loading/empty/error/conflict/read-only states и корректное поведение при смене проекта.
- [ ] Builds и целевые проверки выполнены, результаты реальных BQ integration tests указаны отдельно от unit/mock tests.
- [ ] OpenAPI, env instructions и release runbook обновлены; sample data не попали в реальные проекты.
- [ ] Нет необязательных изменений других сервисов и глобального обновления зависимостей.

Финальный отчёт исполнителя должен содержать: ссылки/ветки/коммиты трёх репозиториев, краткий список изменений каждого, API/OpenAPI, screenshot работающего UI, команды проверок и результат, выполненные миграции с target environment, release/rollback status и реальные ограничения. Разделить **«реализовано»**, **«проверено на BigQuery»** и **«развернуто»** — это разные этапы готовности.

## 18. Краткая инструкция запуска для владельца

Передайте агенту этот файл и доступ к трём рабочим каталогам из раздела 1.1. Начальный запрос можно сформулировать так:

> Реализуй целиком ТЗ `/Users/dmytro_yatsenko/Projects/Strimix/cloud-management-service/docs/specs/traffic-attribution-settings.ru.md` в трёх перечисленных репозиториях. Используй дизайн и контракты из документа. Начни с проверки текущих исходников, затем выполни изменения, тесты и подготовь миграцию/релиз. Сохраняй чужие изменения. Не останавливайся на плане, макете или одном сервисе. Все неизвестные параметры целевого окружения собери для релизного этапа; независимую реализацию выполни до этого.

Если целевое окружение и разрешение на его выпуск уже известны, добавьте их к этому запросу: конкретные environment/service names, список test/production project IDs, доступный способ получения credentials и принятый PR/deploy-процесс. Секретные значения в текст ТЗ не вставлять.
