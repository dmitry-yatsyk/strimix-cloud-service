export const AD_COSTS_TABLE_ID = 'ad_costs'

export const AD_COSTS_TABLE_SCHEMA = [
  { name: 'date', type: 'DATE' },
  { name: 'ad_platform', type: 'STRING' },
  { name: 'source', type: 'STRING' },
  { name: 'medium', type: 'STRING' },
  { name: 'campaign', type: 'STRING' },
  { name: 'content', type: 'STRING' },
  { name: 'term', type: 'STRING' },
  { name: 'strimix_refid', type: 'STRING' },
  { name: 'landing_page_url', type: 'STRING' },
  { name: 'landing_hostname', type: 'STRING' },
  { name: 'landing_page_path', type: 'STRING' },
  {
    name: 'url_params',
    type: 'RECORD',
    mode: 'REPEATED',
    fields: [
      { name: 'key', type: 'STRING' },
      {
        name: 'value',
        type: 'RECORD',
        fields: [{ name: 'string_value', type: 'STRING' }],
      },
    ],
  },
  { name: 'cost', type: 'FLOAT' },
  { name: 'currency', type: 'STRING' },
  { name: 'impressions', type: 'INTEGER' },
  { name: 'reach', type: 'INTEGER' },
  { name: 'clicks', type: 'INTEGER' },
  { name: 'click_delay', type: 'BOOLEAN' },
  { name: 'data_source', type: 'STRING' },
  { name: 'ad_destination', type: 'STRING' },
  // Ad account of the row; the name is the latest known for the account, the
  // same on every date. Added at the end, as migrated tables get them
  // (src/scripts/migrate-ad-account-columns.ts).
  { name: 'ad_account_id', type: 'STRING' },
  { name: 'ad_account_name', type: 'STRING' },
  { name: 'campaign_id', type: 'STRING' },
  { name: 'campaign_name', type: 'STRING' },
  { name: 'adgroup_id', type: 'STRING' },
  { name: 'adgroup_name', type: 'STRING' },
  { name: 'ad_id', type: 'STRING' },
  { name: 'ad_name', type: 'STRING' },
  // Resolved traffic classification (see traffic_rules table). Recalculated
  // by the events attribution scheduled query on every run.
  { name: 'traffic_origin', type: 'STRING' },
  { name: 'traffic_channel', type: 'STRING' },
  // Normalized landing page ("host/path?query", lowercase, no protocol/www/
  // trailing slash; tracking query params stripped, functional ones kept and
  // sorted). Shared column with visits.landing_page so merged reports can
  // break down ad costs and visits by the same landing page key.
  { name: 'landing_page', type: 'STRING' },
]
