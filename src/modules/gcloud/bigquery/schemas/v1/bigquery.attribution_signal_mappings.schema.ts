export const ATTRIBUTION_SIGNAL_MAPPINGS_TABLE_ID = 'attribution_signal_mappings'

/**
 * Per-project mappings that describe WHERE attribution signals live for
 * non-web conversions (e.g. a CRM deal source passed inside
 * order.custom_params under a client-specific key, or inside event_params
 * of a standalone attribution event).
 *
 * The events attribution scheduled query uses these mappings to build
 * synthetic visits (visits.visit_type = 'synthetic') for conversions that
 * carry a signal but have no real web visit.
 *
 * A mapping points to a param container (entity + param_source) and to the
 * keys inside it that hold each visit label. Every label has its own
 * explicit `<label>_param_key`: set it to a client-specific key
 * ('deal_source'), to the standard one ('source', 'medium'...), or leave it
 * null — null means the label is not extracted at all. There are no
 * implicit fallbacks or default values: what is configured is what gets
 * extracted, missing labels stay null.
 *
 * For 'order' / 'deal' entities the signal follows the "state, not history"
 * semantics (matching how the orders/deals tables are built): params are
 * read from the LATEST event carrying the entity, while the synthetic visit
 * is anchored to the entity CREATION time (earliest event, minus 1 ms). An
 * 'event' entity is immutable: the event itself is both the signal source
 * and the anchor.
 *
 * Besides the utm labels, a mapping can point to AD IDENTITY params: ids
 * and/or names of the campaign / adgroup / ad the conversion came from
 * (frequent case: only the ad name is known, e.g. Instagram Direct leads
 * where Facebook does not expose the ad id). The attribution job looks
 * these signals up in ad_costs from the deepest level up (ad -> adgroup ->
 * campaign); name comparison is strictly case-sensitive. The matched
 * ad_costs rows form the RESOLVED GROUP of the visit: it lives in the
 * run's temp tables and feeds both the ad-derived rule conditions (checked
 * on the group's unified values) and the projection placeholders of
 * the utm stage (see traffic_rules). Only the
 * unambiguous part of the group is persisted into visits.attributed_ad
 * (struct: data_source, campaign_id, campaign_name, adgroup_id,
 * adgroup_name, ad_id, ad_name, ad_destination): explicit ids/names are
 * trusted as-is; an ad name resolving to exactly one ad gives the full id
 * set; an ambiguous field keeps null (the '(combined)' marker never
 * reaches the persistent table). Reports match the visit to costs in a
 * cascade: ids first, then names + ad_destination, then the canonical
 * labels materialized by the projection rules ('(combined)' markers
 * included). The date scope of the lookup mirrors the report
 * engine click_delay semantics: click_delay=false ad rows must share the
 * event date, click_delay=true rows may precede it.
 *
 * match_*_regex (optional, 12 fields): APPLICABILITY FILTERS — whether the
 * mapping applies to a particular extracted signal. Six fields match the
 * canonical labels (source, medium, campaign, content, term,
 * strimix_refid), six match the ad identity signals (campaign/adgroup/ad
 * ids and names). Checked AFTER extraction on the values of the entity's
 * latest event ("state, not history"); non-null filters are combined with
 * AND; regexes are case-sensitive as written ((?i) goes into the regex
 * itself). Strict emptiness: a non-null filter with no extracted value
 * fails. A mapping that fails its filters is NOT a candidate and does NOT
 * enter the priority draw — priority is played out only among mappings
 * that passed their filters on the same (entity, entity_id), so a failed
 * mapping never blocks another one. This is how a single CRM stream is
 * split across mappings with different resolution boundaries: e.g.
 * source_id=13 (Instagram/chat) activates the mapping scoped to non-web
 * destinations while source_id=14 (web) activates the one scoped to
 * '^web$', keeping same-named ads of different destinations apart.
 *
 * ad_destination_regex (optional): the RESOLUTION BOUNDARY — ad identity
 * signals of this mapping are searched only among ad_costs rows whose
 * ad_destination matches the regex. E.g. a mapping for Instagram Direct
 * leads scopes the lookup to chat destinations so that a same-named
 * website ad never becomes a candidate. System seed mappings default to
 * non-web destinations (a synthetic visit is by definition born off-site);
 * a client with a broken tracker may consciously widen the scope.
 *
 * data_source_regex (optional): the second RESOLUTION BOUNDARY — ad
 * identity signals are searched only among ad_costs rows of the matching
 * ad network (facebook_ads, google_ads, tiktok_ads...). Protects
 * name-based signals from cross-network namesakes: without the boundary a
 * name living in two networks resolves to an ambiguous group and neither
 * ids nor data_source reach attributed_ad. Null = all networks.
 *
 * The signal is "present" (a synthetic visit is created) when at least one
 * extracted label or ad identity param is non-empty; rows where nothing
 * was extracted are dropped. The labels are written into the visit label
 * columns only; url_params of a synthetic visit stays empty (it holds
 * actual query params parsed from page_location, which a synthetic visit
 * does not have). Extracted labels are the RAW input of the utm rule
 * stage: rules overwrite them (an extracted value survives only when no
 * utm rule sets that field).
 *
 * So a single-value case (a deal source label like "Таргет" passed in
 * order.custom_params under a client key) is a mapping with only
 * source_param_key = 'deal_source', a full "synthetic page_view"
 * attribution event is a mapping with entity = 'event' and the six label
 * keys set to the standard names ('source', 'medium', 'campaign', ...),
 * and an "attribute by ad name" case is a mapping with only
 * ad_name_param_key pointing to the client param holding the name.
 *
 * event_name (optional): restricts the mapping to events with that name,
 * e.g. a dedicated 'offline_attribution' event emitted by an integration.
 *
 * mode:
 *  - 'fallback': create a synthetic visit only when the profile has no marked
 *    web attribution before the event
 *  - 'override': always create a synthetic visit at the event time (the
 *    signal wins last-click attribution for that conversion)
 */
export const ATTRIBUTION_SIGNAL_MAPPINGS_TABLE_SCHEMA = [
  // Short display label for the UI. Optional. The attribution job never reads it.
  { name: 'name', type: 'STRING' },
  // Operator note. The attribution job never reads it.
  { name: 'description', type: 'STRING' },
  { name: 'mapping_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'priority', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'is_active', type: 'BOOLEAN', mode: 'REQUIRED' },
  // 'order' | 'deal': one synthetic visit per entity instance, signals taken
  // from the entity custom_params of its latest event, visit anchored to the
  // entity creation. 'event': one synthetic visit per signal-carrying event,
  // signals taken from event_params
  { name: 'entity', type: 'STRING', mode: 'REQUIRED' }, // 'order' | 'deal' | 'event'
  { name: 'param_source', type: 'STRING', mode: 'REQUIRED' }, // 'custom_params' | 'event_params'
  // Container keys holding each visit label: a client-specific key
  // ('deal_source') or the standard one ('source', 'medium'...).
  // Null = the label is not extracted
  { name: 'source_param_key', type: 'STRING' },
  { name: 'medium_param_key', type: 'STRING' },
  { name: 'campaign_param_key', type: 'STRING' },
  { name: 'content_param_key', type: 'STRING' },
  { name: 'term_param_key', type: 'STRING' },
  { name: 'strimix_refid_param_key', type: 'STRING' },
  // Container keys holding ad identity params. The job looks them up in
  // ad_costs: matched rows become the visit's resolved group, unambiguous
  // ids go into visits.attributed_ad (deepest level wins; names are matched
  // case-sensitively)
  { name: 'campaign_id_param_key', type: 'STRING' },
  { name: 'campaign_name_param_key', type: 'STRING' },
  { name: 'adgroup_id_param_key', type: 'STRING' },
  { name: 'adgroup_name_param_key', type: 'STRING' },
  { name: 'ad_id_param_key', type: 'STRING' },
  { name: 'ad_name_param_key', type: 'STRING' },
  // Applicability filters: checked after extraction, AND of non-null
  // regexes (case-sensitive), a non-null filter with no extracted value
  // fails. A failed mapping is not a candidate and skips the priority
  // draw. Null = no condition
  { name: 'match_source_regex', type: 'STRING' },
  { name: 'match_medium_regex', type: 'STRING' },
  { name: 'match_campaign_regex', type: 'STRING' },
  { name: 'match_content_regex', type: 'STRING' },
  { name: 'match_term_regex', type: 'STRING' },
  { name: 'match_strimix_refid_regex', type: 'STRING' },
  { name: 'match_campaign_id_regex', type: 'STRING' },
  { name: 'match_campaign_name_regex', type: 'STRING' },
  { name: 'match_adgroup_id_regex', type: 'STRING' },
  { name: 'match_adgroup_name_regex', type: 'STRING' },
  { name: 'match_ad_id_regex', type: 'STRING' },
  { name: 'match_ad_name_regex', type: 'STRING' },
  // Resolution boundary: ad identity is searched only among ad_costs rows
  // whose ad_destination matches (case-insensitive regex). Null = no boundary
  { name: 'ad_destination_regex', type: 'STRING' },
  // Second resolution boundary: only ad_costs rows of the matching ad
  // network (case-insensitive regex on data_source). Null = all networks
  { name: 'data_source_regex', type: 'STRING' },
  { name: 'event_name', type: 'STRING' }, // optional condition: only events with this name
  { name: 'mode', type: 'STRING', mode: 'REQUIRED' }, // 'fallback' | 'override'
]
