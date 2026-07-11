// ─────────────────────────────────────────────────────────────
// Mapping service — the interactive mapping layer's brain.
//
// The engine ships deterministic DEFAULTS in valueMaps.js / matrix.js. This
// service lets a customer OVERRIDE them per project (which objects to migrate,
// how each enum value translates, how agents match) WITHOUT a code deploy —
// overrides are rows in `valueMaps` / `mappingRules` / the project doc.
//
// Contract: `effective*()` = JS default ⊕ project override. When a customer has
// set nothing, the effective result is byte-for-byte the old hard-coded behavior
// → zero regression. Everything here is pure data + deterministic merges; no LLM.
// ─────────────────────────────────────────────────────────────
import { repo } from '../db/repository.js';
import { STATUS, PRIORITY, SOURCE } from './valueMaps.js';
import { MATRIX, LOAD_ORDER } from './matrix.js';

// The Zendesk ticket-type → Freshdesk type default. Zendesk "task" has no
// Freshdesk equivalent, so it folds to Question (the safe, non-rejecting choice —
// the same call Help Desk Migration makes).
export const TYPE_DEFAULT = { question: 'Question', incident: 'Incident', problem: 'Problem', task: 'Question' };

// The named, user-editable value maps. `key` is stored on `valueMaps.name`;
// `default` seeds the rows; `sourceValues` are the Zendesk-side keys the UI
// renders (each gets a target dropdown). `__default` (see mergeValueMap) is the
// "use for empty / unmatched values" fallback — HDM's "Use for empty values".
export const VALUE_MAP_DEFS = {
  status:   { label: 'Ticket status',        object: 'tickets', targetKind: 'freshdesk-status',   default: STATUS },
  priority: { label: 'Ticket priority',      object: 'tickets', targetKind: 'freshdesk-priority', default: PRIORITY },
  source:   { label: 'Ticket source/channel', object: 'tickets', targetKind: 'freshdesk-source',  default: SOURCE },
  type:     { label: 'Ticket type',          object: 'tickets', targetKind: 'freshdesk-type',     default: TYPE_DEFAULT },
};

// The fixed target option sets a Freshdesk account exposes for each built-in
// enum (ids per Freshdesk API). The UI renders these as the target dropdown.
export const TARGET_OPTIONS = {
  'freshdesk-status':   [{ value: 2, label: 'Open' }, { value: 3, label: 'Pending' }, { value: 4, label: 'Resolved' }, { value: 5, label: 'Closed' }],
  'freshdesk-priority': [{ value: 1, label: 'Low' }, { value: 2, label: 'Medium' }, { value: 3, label: 'High' }, { value: 4, label: 'Urgent' }],
  'freshdesk-source':   [{ value: 1, label: 'Email' }, { value: 2, label: 'Portal' }, { value: 3, label: 'Phone' }, { value: 7, label: 'Chat' }, { value: 9, label: 'Feedback Widget' }, { value: 10, label: 'Outbound Email' }],
  'freshdesk-type':     [{ value: 'Question', label: 'Question' }, { value: 'Incident', label: 'Incident' }, { value: 'Problem', label: 'Problem' }],
};

// ── value maps ──────────────────────────────────────────────

// One effective map = default overlaid with the saved override. A stored `null`
// value means "skip" (drop the field for that source value); undefined means
// "not overridden → use default".
function mergeValueMap(def, override) {
  const map = { ...def.default };
  if (override && typeof override === 'object') for (const [k, v] of Object.entries(override)) map[k] = v;
  return map;
}

export async function effectiveValueMaps(projectId) {
  const rows = await repo('valueMaps').find({ projectId });
  const byName = Object.fromEntries(rows.map((r) => [r.name, r.map]));
  const out = {};
  for (const [name, def] of Object.entries(VALUE_MAP_DEFS)) out[name] = mergeValueMap(def, byName[name]);
  return out;
}

// UI shape for one value map: every source value as a row with its current
// target, the full target option set, and the empty/unmatched default.
export async function getValueMap(projectId, name) {
  const def = VALUE_MAP_DEFS[name];
  if (!def) throw new Error(`unknown value map "${name}"`);
  const row = await repo('valueMaps').findOne({ projectId, name });
  const eff = mergeValueMap(def, row?.map);
  const rows = Object.keys(def.default).map((sourceValue) => ({ sourceValue, target: eff[sourceValue] ?? null }));
  return {
    name, label: def.label, object: def.object,
    targetOptions: TARGET_OPTIONS[def.targetKind] || [],
    rows,
    emptyDefault: eff.__default ?? null,   // "Use for empty values"
    customized: !!(row && Object.keys(row.map || {}).length),
  };
}

// Persist an override. `map` is a partial { sourceValue: targetValue | null },
// plus an optional __default. We store only the diff vs the JS default so future
// default changes still flow through for untouched keys.
export async function saveValueMap(projectId, name, map) {
  const def = VALUE_MAP_DEFS[name];
  if (!def) throw new Error(`unknown value map "${name}"`);
  const diff = {};
  for (const [k, v] of Object.entries(map || {})) {
    if (k === '__default') { if (v != null) diff.__default = v; continue; }
    if (!(k in def.default) || def.default[k] !== v) diff[k] = v; // keep only real overrides
  }
  await repo('valueMaps').upsert({ projectId, name }, { projectId, name, map: diff, version: 1 });
  return getValueMap(projectId, name);
}

export async function resetValueMap(projectId, name) {
  // Clearing the override map back to {} restores the JS defaults (mergeValueMap
  // overlays nothing), which is the same as "no customization".
  await repo('valueMaps').upsert({ projectId, name }, { projectId, name, map: {}, version: 1 });
  return getValueMap(projectId, name);
}

// ── object selection ────────────────────────────────────────
// Which source objects the customer chose to migrate. Stored on the project so
// it travels with options. Default = everything the matrix knows.
export function defaultSelection() {
  return Object.fromEntries(LOAD_ORDER.map((t) => [t, true]));
}

export async function getSelection(projectId) {
  const p = await repo('projects').findOne({ _id: projectId });
  const saved = p?.options?.objectSelection || {};
  const sel = defaultSelection();
  for (const [k, v] of Object.entries(saved)) if (k in sel) sel[k] = !!v;
  return sel;
}

export async function saveSelection(projectId, selection) {
  const p = await repo('projects').findOne({ _id: projectId });
  const clean = {};
  for (const t of LOAD_ORDER) if (t in (selection || {})) clean[t] = !!selection[t];
  await repo('projects').updateOne({ _id: projectId }, { options: { ...(p?.options || {}), objectSelection: clean } });
  return getSelection(projectId);
}

// ── field mapping (Tier 1) ─────────────────────────────────
// The canonical source→target field list per DATA object — mirrors exactly what
// the deterministic transformers produce, so the UI shows the real mapping and
// the engine can honor a "skip" without a transformer rewrite. `valueMap` links
// an enum field to its Tier-2 value map; `required` fields can't be skipped
// (Freshdesk rejects the record without them); `fk` fields resolve through idmap.
export const FIELD_MAP_DEFS = {
  organizations: [
    { key: 'name',       source: 'Name',        target: 'Name',            required: true },
    { key: 'domains',    source: 'Domains',     target: 'Domains' },
  ],
  users: [
    { key: 'name',       source: 'Name',        target: 'Name',            required: true },
    { key: 'email',      source: 'Email',       target: 'Email',           required: true },
    { key: 'company_id', source: 'Organization', target: 'Company',        fk: true },
  ],
  tickets: [
    { key: 'subject',      source: 'Subject',      target: 'Subject',       required: true },
    { key: 'description',  source: 'Description',  target: 'Description',    required: true },
    { key: 'status',       source: 'Status',       target: 'Status',        required: true, valueMap: 'status' },
    { key: 'priority',     source: 'Priority',     target: 'Priority',      required: true, valueMap: 'priority' },
    { key: 'source',       source: 'Channel',      target: 'Source',        valueMap: 'source' },
    { key: 'type',         source: 'Type',         target: 'Type',          valueMap: 'type' },
    { key: 'group_id',     source: 'Group',        target: 'Group',         fk: true },
    { key: 'responder_id', source: 'Assignee',     target: 'Agent',         fk: true },
    { key: 'requester_id', source: 'Requester',    target: 'Contact',       required: true, fk: true },
    { key: 'company_id',   source: 'Organization', target: 'Company',       fk: true },
    { key: 'tags',         source: 'Tags',         target: 'Tags' },
    { key: 'cc_emails',    source: 'CC',           target: 'CC' },
    { key: 'created_at',   source: 'Created date', target: 'Created at' },
    { key: 'updated_at',   source: 'Updated date', target: 'Updated at' },
  ],
};
export const FIELD_MAP_OBJECTS = Object.keys(FIELD_MAP_DEFS);

// UI shape: every field with its current skip state. Required fields are locked on.
export async function getFieldMap(projectId, type) {
  const defs = FIELD_MAP_DEFS[type];
  if (!defs) throw new Error(`no field map for "${type}"`);
  const rule = await repo('mappingRules').findOne({ projectId, sourceEntityType: type });
  const skip = new Set(rule?.skip || []);
  return {
    type, targetType: MATRIX[type]?.targetType,
    fields: defs.map((f) => ({ ...f, skippable: !f.required, skipped: skip.has(f.key) })),
    customized: !!(rule?.skip?.length),
  };
}

// Persist which fields to skip. Required fields can never be skipped.
export async function saveFieldMap(projectId, type, { skip = [] } = {}) {
  const defs = FIELD_MAP_DEFS[type];
  if (!defs) throw new Error(`no field map for "${type}"`);
  const skippable = new Set(defs.filter((f) => !f.required).map((f) => f.key));
  const clean = [...new Set(skip)].filter((k) => skippable.has(k));
  await repo('mappingRules').upsert(
    { projectId, sourceEntityType: type },
    { projectId, sourceEntityType: type, targetEntityType: MATRIX[type]?.targetType, skip: clean, version: 1 },
  );
  return getFieldMap(projectId, type);
}

// Loaded once per run: { type → Set(skippedFieldKeys) } for the load phase to
// drop skipped fields from each transformed payload.
export async function effectiveFieldSkips(projectId) {
  const out = {};
  for (const type of FIELD_MAP_OBJECTS) {
    const rule = await repo('mappingRules').findOne({ projectId, sourceEntityType: type });
    out[type] = new Set(rule?.skip || []);
  }
  return out;
}

// ── the object overview (drives the "Select Objects" screen) ──
// One row per source object: target, domain, feasibility, whether it's selected,
// which mapping affordances it has (valueMaps / matching / filters).
export async function objectOverview(projectId) {
  const sel = await getSelection(projectId);
  const valueMapObjects = new Set(Object.values(VALUE_MAP_DEFS).map((d) => d.object));
  return LOAD_ORDER.map((type) => {
    const m = MATRIX[type];
    const valueMaps = Object.entries(VALUE_MAP_DEFS).filter(([, d]) => d.object === type).map(([k]) => k);
    return {
      type, targetType: m.targetType, domain: m.domain, feasibility: m.feasibility,
      selected: sel[type],
      affordances: {
        fields: FIELD_MAP_OBJECTS.includes(type),
        valueMaps,
        matching: type === 'agents',
        filters: type === 'tickets',
      },
    };
  });
}
