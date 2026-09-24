# Traffic & attribution settings — frozen API contract v1

One message shape for all three repositories. The CMS OpenAPI
(`src/presentation/docs/v1/traffic-settings.yaml`), the gateway OpenAPI
(`src/docs/v1/traffic-settings.yaml`) and the frontend adapters
(`src/api/traffic-settings/`) must all describe exactly what is below. The
fixtures in `docs/tasks/traffic-attribution-settings/specs/fixtures/` are the
executable form of this document and are shared by the contract tests of all
three services.

## 1. Base URLs

| Layer | Base |
| --- | --- |
| Gateway (public, user JWT) | `/api/v1/organization/:organizationId/projects/:projectId/traffic-settings` |
| CMS (internal, service code) | `/api/v1/project-resources/:projectId/traffic-settings` |

Suffix, HTTP method, domain payload and success body are identical. The gateway
only adds verified actor/context on the way in, and effective user rights to
`/meta` on the way out. No internal credential, GCP identifier or internal
address ever appears in a public response.

## 2. Resource slugs

`resource` is exactly one of:

| Slug | BigQuery table | Addressed by |
| --- | --- | --- |
| `excluded-url-params` | `excluded_url_params` | `param_id` |
| `excluded-referrers` | `excluded_referrers` | `referrer_id` |
| `traffic-rules` | `traffic_rules` | `rule_id` |
| `attribution-signal-mappings` | `attribution_signal_mappings` | `mapping_id` |

Every slug is id-addressed and goes through the generic `/:resource` routes.
Referrers additionally have one literal route for the bulk add.

## 3. Endpoints

| Method + suffix | Purpose | Right | Success |
| --- | --- | --- | --- |
| `GET /meta` | readiness, application mode, rights | read | 200 |
| `GET /:resource` | whole collection | read | 200 `{items, revision}` |
| `GET /:resource/:id` | one item + collection revision | read | 200 `{item, revision}` |
| `POST /:resource` | create | update | 201 `{item, revision, application}` |
| `PUT /:resource/:id` | full replace of mutable fields | update | 200 `{item, revision, application}` |
| `PATCH /:resource/:id/active` | `is_active` only | update | 200 `{item, revision, application}` |
| `DELETE /:resource/:id` | delete one | update | 200 `{deleted_id, revision, application}` |
| `POST /excluded-referrers/bulk` | add several hosts at once | update | 200 `{items, skipped_hosts, revision, application}` |
| `POST /validate` | check a draft, writes nothing | read | 200 validation result |
| `POST /excluded-url-params/preview` | effect of one draft exclusion | read | 200 preview result |

Rights are assigned per route, not derived from the HTTP method: `POST /validate`
and `POST .../preview` are **read**, `POST /:resource` is **update**.

Literal routes (`/meta`, `/validate`, `/excluded-referrers/bulk`,
`/excluded-url-params/preview`) are registered **before** `/:resource/:id` so
`/:id` cannot capture them.

The bulk add exists because own domains are pasted as a set. Hosts already on the
list are returned in `skipped_hosts` rather than failing the call, so a partly
known list still goes through in one step.

Collections are small: the whole list is returned and search, filtering,
sorting and pagination are client-side. There is no server `LIMIT`.

### Deterministic order

| Resource | Order |
| --- | --- |
| `traffic-rules` | stage (`utm`, `origin`, `channel`), then `priority`, then `rule_id` |
| `attribution-signal-mappings` | `priority`, then `mapping_id` |
| `excluded-url-params` | `param_id` |
| `excluded-referrers` | `host`, then `referrer_id` |

## 4. Revision protocol

`revision` is an **opaque decimal string** versioning the WHOLE collection of one
resource inside one project. It is not a timestamp and not a row version. It is
returned from the same consistent snapshot as the data it describes.

- Every mutation body MUST carry `expected_revision`. Missing → `400`.
- Stale value → `409 TRAFFIC_SETTINGS_REVISION_CONFLICT` with
  `details.current_revision`.
- A successful mutation increments the revision exactly once and returns the
  stored, normalized object — never a copy of the request body.
- A draft keeps the revision it was loaded with. A background refetch must not
  silently swap in a newer one.

### Mutation envelopes

`POST` / `PUT` of the three id-addressed resources:

```json
{
  "expected_revision": "12",
  "item": {
    "param_key_regex": "utm_[a-z]+",
    "description": "Standard UTM labels",
    "is_active": true
  }
}
```

`PUT` carries **all** mutable fields, including explicit `null`s. An omitted
optional field is read as `null`, not as "leave unchanged" — the frontend builds
the full DTO from the loaded object plus the current form. Read-only fields
(`param_id`, `rule_id`, `mapping_id`, `is_system`) are returned in reads and
**rejected** inside a write `item`. Any unknown key in a mutation DTO is
rejected.

```json
{ "expected_revision": "12", "is_active": false }
```
`PATCH /:resource/:id/active`.

```json
{ "expected_revision": "12" }
```
`DELETE /:resource/:id` — yes, DELETE carries a body.

```json
{ "expected_revision": "12", "hosts": ["example.com", "www.example.com"] }
```
`POST /excluded-referrers/bulk`. At least one host; the rows are created active
and without a description. An empty array is refused because it has nothing to
mean — clearing the list is done by deleting rows.

### Application

```json
{ "mode": "next_scheduled_run" }
```

Returned with every mutation. It means the configuration is saved and reports
change after the next successful attribution run. There is no `applied_at` and no
`next_run_at`: the service does not know when a given project's job next runs.

## 5. `GET /meta`

Public (gateway) response:

```json
{
  "project_id": 123,
  "can_read": true,
  "can_write": true,
  "application": { "mode": "next_scheduled_run", "scheduled_query_configured": true },
  "resources": {
    "excluded-url-params": { "readable": true, "writable": true, "state": "ready" },
    "excluded-referrers": {
      "readable": true,
      "writable": false,
      "state": "migration_required",
      "reason_code": "LEGACY_VIEW",
      "message": "This project still stores excluded referrers as a view. An administrator must run the migration before the list can be edited."
    },
    "traffic-rules": { "readable": true, "writable": true, "state": "ready" },
    "attribution-signal-mappings": { "readable": true, "writable": true, "state": "ready" }
  }
}
```

`can_read` / `can_write` are computed by the **gateway** from the user's roles and
demo status. The CMS response is identical minus those two fields.

States: `ready`, `not_provisioned`, `migration_required`, `invalid_configuration`.
Anything other than `ready` carries a stable `reason_code` and a safe `message`.

Effective editability = `can_write && resources[r].writable`. The server
re-checks readiness on every mutation; the flag is a UI hint, never the
authority. A missing table is **not** an existing empty list, and a network or
IAM failure is **never** reported as a successful meta with empty settings.

`invalid_configuration` does not necessarily forbid everything. With a sound
schema and a working revision row, a single bad regex still allows correcting,
disabling and deleting that row, so `writable` stays `true` and the diagnostics
explain that enabling or saving the invalid object is what is blocked. Only when
a row cannot be addressed safely (duplicate ids) or the revision protocol is
missing does `writable` become `false`.

### `reason_code` values

| Code | State | Meaning |
| --- | --- | --- |
| `TABLE_MISSING` | `not_provisioned` | The config table does not exist for this project |
| `DATASET_MISSING` | `not_provisioned` | The project has no BigQuery dataset registered |
| `LEGACY_VIEW` | `migration_required` | `excluded_referrers` is still a view, not a table |
| `LEGACY_HOSTS_COLUMN` | `migration_required` | `excluded_referrers` still holds one row with a `hosts` array |
| `REVISION_ROW_MISSING` | `migration_required` | No revision row, so no safe concurrency control |
| `REVISION_ROWS_DUPLICATED` | `invalid_configuration` | More than one revision row for the resource |
| `SCHEMA_COLUMNS_MISSING` | `migration_required` | Table lacks columns the current version writes |
| `DUPLICATE_ITEM_IDS` | `invalid_configuration` | Two rows share an id, so no row can be addressed |
| `RESOURCE_MISREGISTERED` | `invalid_configuration` | Stored table reference contradicts the project's dataset |
| `INVALID_STORED_REGEX` | `invalid_configuration` | Some stored pattern is not valid RE2 |
| `PRIORITY_CONFLICTS` | `invalid_configuration` | Pre-existing active rules collide on priority |

## 6. `POST /validate`

Request:

```json
{ "resource": "traffic-rules", "item": { }, "id": "custom_abc or null" }
```

`id` supplies context only; it never changes an id and it is checked to belong to
this project. A structurally broken envelope is `400`.

Response:

```json
{
  "valid": false,
  "errors": [
    { "field": "source_regex", "code": "INVALID_REGEX", "message": "Invalid RE2 expression" }
  ],
  "warnings": []
}
```

`field` is a domain field name or a readable path such as `hosts[2]`. A passing
validate does **not** guarantee a successful save: on write the CMS re-checks the
final configuration and the concurrency constraints.

For `excluded-referrers` the item is either one row, or `{ "hosts": [...] }` to
check a bulk add before sending it. Either way the normalization outcome is
reported in `warnings`.

## 7. `POST /excluded-url-params/preview`

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

Preview shows the effect of the **one** exclusion being edited, not of the whole
project configuration. With `is_active: false` nothing is removed but the rest of
the landing page normalization still runs. The returned value is a normalized
`landing_page` (no protocol), not the input URL with a tweaked query — the UI
labels it accordingly.

It uses the same RE2 logic, anchoring, casing, query handling and landing page
normalization as the scheduled query; it reads no raw events; it never makes an
HTTP request to the address. New requests happen on an explicit button, not per
keystroke, and a late response must not replace the result of a newer draft.

## 8. Errors

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

| HTTP | Code | UI behaviour |
| --- | --- | --- |
| 400 | `REQUEST_VALIDATION_ERROR` | field errors, draft kept |
| 400 | `TRAFFIC_SETTINGS_VALIDATION_FAILED` | field errors from `details.errors`, draft kept |
| 400 | `TRAFFIC_SETTINGS_EXPECTED_REVISION_REQUIRED` | reload, then retry |
| 401 | gateway auth | existing frontend reauth flow |
| 403 | permissions / demo user | read-only or "no access" |
| 404 | `TRAFFIC_SETTING_NOT_FOUND` | record is gone, offer return to list |
| 404 | `TRAFFIC_SETTINGS_FEATURE_DISABLED` | feature off in this environment |
| 409 | `TRAFFIC_SETTINGS_REVISION_CONFLICT` | conflict dialog, keep draft |
| 409 | `TRAFFIC_RULE_PRIORITY_CONFLICT` | show `details.conflicting_rule_ids` |
| 409 | `TRAFFIC_SETTINGS_REFERRER_HOST_CONFLICT` | report on the host field, offer the existing row |
| 409 | `TRAFFIC_SETTINGS_REFERRER_LIMIT_EXCEEDED` | explain the limit, nothing was written |
| 409 | `TRAFFIC_SETTINGS_MIGRATION_REQUIRED` | explain not-ready, never a false "empty" |
| 409 | `TRAFFIC_SETTINGS_INVALID_CONFIGURATION` | explain, allow fix/disable/delete |
| 409 | `TRAFFIC_SETTINGS_NOT_PROVISIONED` | explain not-ready |
| 409 | `TRAFFIC_SETTINGS_DUPLICATE_ITEM_ID` | administrative fix required |
| 413 | request too large | explain the size limit |
| 429 / 503 | quota / temporarily unavailable | retry read, keep draft |
| 502 | downstream failure | outcome may be unknown |
| 504 | `TRAFFIC_SETTINGS_OUTCOME_UNKNOWN` | keep draft, reload before any retry |

Gateway rules: domain `400/404/409` are forwarded as-is, never turned into `200`,
`undefined` or a blanket `500`; safe `details` are preserved. A CMS `401` caused
by a wrong **service** credential is a `502` to the user, not a reason to refresh
their JWT. Connection error → `502`, timeout → `504`.

Existing gateway auth middleware still emits the older flat `{error, message}`
shape. The new frontend adapter understands both without changing old APIs.

A mutation timeout does not guarantee a rollback — the BigQuery statement may
have committed. Mutations are never retried automatically, and never with a fresh
revision. The draft is kept, the outcome is reported as unknown, and the data is
re-read before the user explicitly retries. Repeating the same request with the
same revision must not create a second row.

## 9. Permissions

New permissions in the gateway's `roles-and-permissions.js`:

- `organization.projects.trafficSettings.read` / `.update` → `organization.owner`, `organization.admin`
- `project.trafficSettings.read` → `project.admin`, `project.user`, `project.viewer`
- `project.trafficSettings.update` → `project.admin`

Every route uses
`GrantAccess.checkPermission('any', ['organization.projects.trafficSettings.<action>', 'project.trafficSettings.<action>'])`.

| Role | read / validate / preview | create / update / toggle / delete |
| --- | --- | --- |
| `organization.owner` | yes | yes |
| `organization.admin` | yes | yes |
| `project.admin` | yes | yes |
| `project.user` | yes | no |
| `project.viewer` | yes | no |
| `project.sharedReportViewer` | no | no |
| `organization.user` without a project role | no | no |
| demo user | normal read | no |

`project.project.read` is deliberately not reused: `sharedReportViewer` has it.
`canEditReports` is likewise unsuitable — it would give `project.user` write
access to this configuration.

## 10. Service authorization, CMS side

The gateway calls the CMS with the service code from
`CLOUD_MANAGEMENT_SERVICE_AUTHORIZATION_CODE`, matched against the CMS
`APP_AUTHORIZATION_CODES` entry whose `appName` is `app-api-gateway`. The new CMS
routes additionally require that the matched entry is that trusted app, so
another service's code cannot reach them. The user's Bearer token is never
forwarded to the CMS.

Headers the gateway sends:

| Header | Value |
| --- | --- |
| `Authorization` | the service code |
| `X-Strimix-Actor-Id` | `req.user.id`, never an inbound header of the same name |
| `X-Strimix-Request-Id` | per-request id, propagated into the CMS audit log |

## 11. Availability

There is no on/off variable for this feature, in any repository.

| Repo | Variable | Default |
| --- | --- | --- |
| Gateway | `CLOUD_MANAGEMENT_SERVICE_URL` | empty; base origin without `/api/v1` |
| Gateway | `CLOUD_MANAGEMENT_SERVICE_AUTHORIZATION_CODE` | empty |
| Gateway | `CLOUD_MANAGEMENT_SERVICE_TIMEOUT_MS` | `60000` |

These routes are a proxy, so the configuration of the upstream is the switch: a
deployment that sets neither of the first two does not run the feature, and the
routes answer a controlled `404 TRAFFIC_SETTINGS_FEATURE_DISABLED` while every
existing endpoint keeps working. Setting one without the other is rejected at
startup, so the feature cannot disappear because of a forgotten variable. The
same check answers `GET .../features`, so the menu and the routes agree. The CMS
address is never taken from `TENANT_SERVICE_*` — that is a different service.

The frontend has no flag: it renders what the feature map allows. Per-tenant
rollout and rollback are rows in the gateway's `featureOverride` table, and a
project only gets the section once its BigQuery tables are migrated.

## 12. Domain field reference

Field names are the BigQuery column names, `snake_case`, on the wire in all three
repos. `null` always means "not configured"; it is never an implicit default.
Nothing is trimmed or lower-cased on the way through: regexes, literal outputs,
ad entity names and container keys are content- and case-sensitive.

### `excluded-url-params`

| Field | Write | Notes |
| --- | --- | --- |
| `param_id` | no | generated by the CMS as `custom_<uuid>`, unique per project |
| `param_key_regex` | yes | required RE2, must not be blank for a new row |
| `is_active` | yes | boolean |
| `is_system` | no | origin only; system rows are still editable, disableable and deletable |
| `description` | yes | nullable string |

Matching is on the **whole URL param key, case-insensitively** — not on the value
and not on an arbitrary substring of the URL. `utm_[a-z]+` matches `utm_source`
and `UTM_MEDIUM` but not `custom_utm_source`; an already anchored `^fbclid$`
works. Only components of the normalized `landing_page` of visits and ad_costs
are affected: the original URL, the extracted UTMs, `url_params` and the ad
identifier columns are untouched.

### `excluded-referrers`

Required: `referrer_id`, `host`, `is_active`. Optional: `description`.

| Field | Writable | Notes |
| --- | --- | --- |
| `referrer_id` | no | `custom_<uuid>`, generated on create |
| `host` | yes | normalized hostname, unique across the list |
| `is_active` | yes | an inactive row is kept but not excluded |
| `description` | yes | nullable string |

One row per host, so a domain can be disabled without losing the note explaining
why it was added. The host is unique regardless of `is_active`, and a colliding
write answers 409 `TRAFFIC_SETTINGS_REFERRER_HOST_CONFLICT`. There is no
`is_system`: every row is the client's own. Rows are returned ordered by
`host, referrer_id`.

Hostname only: no protocol, port, `/path`, query, fragment or wildcard.
Subdomains are separate entries. IP addresses and single-label hosts are not
supported in v1 and produce a clear error. Normalization is trim, lower case, IDN
to ASCII punycode, drop one trailing DNS dot, de-duplicate, with hostname and
label length checks — identical on the client preview, the server write and the
migration.

### `traffic-rules`

Required: `rule_id`, `priority`, `is_active`, `is_system`, `stage`, `target`.
`stage ∈ {utm, origin, channel}`, `target ∈ {visit, ad_cost, both}`.

Optional, all of which the editor must support and round-trip:

| Group | Fields |
| --- | --- |
| Web applicability | `applies_to_web` |
| Label conditions | `source_regex`, `medium_regex`, `campaign_regex`, `content_regex`, `term_regex`, `strimix_refid_regex` |
| Ad conditions | `data_source_regex`, `campaign_id_regex`, `campaign_name_regex`, `adgroup_id_regex`, `adgroup_name_regex`, `ad_id_regex`, `ad_name_regex`, `ad_destination_regex` |
| URL | `url_param_key`, `url_param_value_regex` |
| Resolved origin | `traffic_origin_regex` |
| UTM outputs | `set_source`, `set_medium`, `set_campaign`, `set_content`, `set_term`, `set_strimix_refid` |
| Classification | `set_traffic_origin`, `set_traffic_channel` |

Invariants enforced by the CMS:

- all non-null conditions are ANDed; there are no arbitrary OR groups, though
  alternation inside one regex is fine;
- regex conditions are case-sensitive as written — `(?i)` is the author's job;
- a **lower** `priority` runs earlier;
- UTM: each output `set_*` is taken from the first matching rule **by priority
  that defines that field**, so different rules may fill different fields; a
  written value overwrites the extracted label;
- origin/channel: the first matching rule wins;
- `traffic_origin_regex` is allowed on channel rules only;
- `utm` requires at least one of the six UTM outputs non-null and all
  classification outputs null;
- `origin` requires `set_traffic_origin`, `channel` requires
  `set_traffic_channel`, and outputs of the other stage must be null;
- `applies_to_web = true` is allowed only for `utm` with a target including
  `visit`; `null` means false;
- `url_param_value_regex` requires a non-empty `url_param_key`; a key without a
  regex is an existence check;
- ad conditions apply to a cost row or the unambiguous values of a synthetic
  visit's resolved group — they never match web visits, even with
  `applies_to_web = true`.

Placeholders allowed in UTM outputs only: `{data_source}`, `{campaign_id}`,
`{campaign_name}`, `{adgroup_id}`, `{adgroup_name}`, `{ad_id}`, `{ad_name}`.
Nothing else, and no expression evaluation. A rule with placeholders fires only
when all five canonical labels are still empty.

**Priority conflicts.** A mutation must not introduce two *active* rules of the
same stage with the same `priority` and overlapping `target` (`both` overlaps
both). That returns `409 TRAFFIC_RULE_PRIORITY_CONFLICT` with the conflicting
ids. Different stages, and non-overlapping `visit`/`ad_cost`, are fine.
Pre-existing conflicts are **not** deleted: they are surfaced as a warning, and
disabling, deleting or any change that does not add a new conflict stays allowed
so a legacy configuration can be repaired. Regex overlap is not analysed.

### `attribution-signal-mappings`

Required: `mapping_id`, `priority`, `is_active`, `entity`, `param_source`, `mode`.

| Group | Fields |
| --- | --- |
| Label keys | `source_param_key`, `medium_param_key`, `campaign_param_key`, `content_param_key`, `term_param_key`, `strimix_refid_param_key` |
| Ad identity keys | `campaign_id_param_key`, `campaign_name_param_key`, `adgroup_id_param_key`, `adgroup_name_param_key`, `ad_id_param_key`, `ad_name_param_key` |
| Label filters | `match_source_regex`, `match_medium_regex`, `match_campaign_regex`, `match_content_regex`, `match_term_regex`, `match_strimix_refid_regex` |
| Ad signal filters | `match_campaign_id_regex`, `match_campaign_name_regex`, `match_adgroup_id_regex`, `match_adgroup_name_regex`, `match_ad_id_regex`, `match_ad_name_regex` |
| Resolution boundaries | `data_source_regex`, `ad_destination_regex` |
| Event restriction | `event_name` |

Invariants:

- `entity ∈ {order, deal}` ⇒ `param_source = custom_params`; `entity = event` ⇒
  `param_source = event_params`. Other combinations are rejected. The UI derives
  the container from the entity and shows it read-only;
- `mode ∈ {fallback, override}`. `fallback` creates a synthetic visit only when
  the profile has no marked web attribution before the anchor time; `override`
  creates one regardless. `fallback` is **not** "only when no web visit exists at
  all";
- at least one `*_param_key` must be set. It is the name of an **input key**, not
  a value and not a JSONPath;
- `null` means "do not extract". There is no fallback to a standard default key.
  A synthetic visit is created only when something non-empty was actually
  extracted;
- `match_*` are checked after extraction, non-null filters are ANDed, and a
  missing extracted value fails its filter. A new or newly added filter requires
  its matching `*_param_key`; old contradictions are diagnosed without silent
  modification;
- priority is played out only among mappings that passed their filters for one
  `(entity, entity_id)`. Equal priorities are currently broken by `mapping_id` —
  surfaced as a warning, with no new prohibition and no change to the tie-break;
- `data_source_regex` / `ad_destination_regex` scope the ad_costs lookup. They are
  a separate block, not members of `match_*`, and they are matched
  case-insensitively by the existing SQL, whereas `match_*` are case-sensitive
  unless the author added `(?i)`;
- ad entity names are compared case-sensitively, and UI never guesses away an
  ambiguous resolved group;
- for order/deal the params come from the entity's latest state while the
  synthetic visit is anchored to entity creation (minus 1 ms in the
  implementation); for an event, the immutable event is both source and anchor;
- `event_name` is an optional exact event name. Changing the entity must not
  silently reinterpret `custom_params` keys as confirmed `event_params` keys: the
  draft is kept, the container change is explained, and a deliberate save is
  required;
- mappings have no `is_system`, `name` or `description`, and none are added.

## 13. Application limits

| Thing | Limit |
| --- | --- |
| regex | 4096 chars |
| `description` | 4096 chars |
| string output | 2048 chars |
| event name, param key | 256 chars |
| hosts per list | 1000 |
| HTTP body | existing 100 KiB, with a clear `413` |

Existing values outside these limits are never truncated: preflight finds them
and reports a diagnosable state.

`priority` is an integer representable without loss in JavaScript. Strings,
`NaN` and fractions are rejected. Negative values are not forbidden by the
schema, and no "1…999 only" rule is introduced — a new custom rule is merely
*suggested* a free value below 1000.
