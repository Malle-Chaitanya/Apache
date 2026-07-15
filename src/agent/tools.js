// src/agent/tools.js
// ─────────────────────────────────────────────────────────────
// Tools the migration guide can call, scoped to OUR Zendesk → Freshdesk wizard.
// Read tools (get_migration_status) return data. Action tools emit a UI event
// over the SSE stream that the React wizard applies (navigate, set scope, start
// a run) — the guide drives the SAME buttons the user would click. The write
// path itself stays 100% deterministic in the engine; the LLM only triggers it.
//
// DESTRUCTIVE tools are gated behind an explicit "Yes, proceed" confirmation.
// ─────────────────────────────────────────────────────────────

// Wizard step index → name (mirrors web/src/App.jsx STEPS).
export const STEP_NAMES = [
  'Connect Platforms', // 0
  'Choose Pair',       // 1
  'Select Data',       // 2
  'Select & Map',      // 3
  'Dry Run',           // 4
  'Live Migration',    // 5
  'Report',            // 6
];

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_migration_status',
      description: 'Read the current state of the migration: which step the user is on, whether Zendesk (source) and Freshdesk (target) are connected, the chosen data scope, source scan counts, and whether a dry run or live migration has completed. Call this whenever you need fresh facts before answering.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate_to_step',
      description: 'Move the wizard to a specific step so the panel matches what you are guiding. Steps: 0=Connect Platforms, 1=Choose Pair, 2=Select Data, 3=Select & Map, 4=Dry Run, 5=Live Migration, 6=Report. The UI clamps navigation to what is reachable (e.g. you cannot skip past Connect until both sides are connected).',
      parameters: {
        type: 'object',
        properties: { step: { type: 'integer', minimum: 0, maximum: 6, description: 'Target step index (0-6).' } },
        required: ['step'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_data_scope',
      description: 'Set what gets migrated on the Select Data step. Configuration = groups, agents, fields, SLAs, business hours, automations, macros, brands. Data = tickets + conversations + attachments, contacts, companies, knowledge base. At least one must stay on. Pass only the field(s) you want to change.',
      parameters: {
        type: 'object',
        properties: {
          migrateConfig: { type: 'boolean', description: 'Include configuration objects.' },
          migrateData: { type: 'boolean', description: 'Include data objects.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_dry_run',
      description: 'Start a dry run (pre-check). Reads both platforms and previews exactly what would migrate — NO data is written. Always safe. Requires that both platforms are connected and a project exists (i.e. the user has reached Select Data or later).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_live_migration',
      description: 'Start the LIVE migration — this WRITES into Freshdesk. Configuration loads first, then data; batched, checkpointed and resumable. Only call after the user explicitly confirms going live. Recommend a dry run first if one has not been done.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_report',
      description: 'Open the Report step so the user can review results and download the Excel/JSON report. Only meaningful after a run has completed.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
];

// Tools that must be confirmed by the user before executing.
export const DESTRUCTIVE_TOOLS = ['start_live_migration'];

export const CONFIRMATION_MESSAGES = {
  start_live_migration: 'This starts the **live migration** and writes data into Freshdesk. Configuration loads first, then data — it is batched, checkpointed and resumable, but it does write to the target. Ready to go live?',
};
