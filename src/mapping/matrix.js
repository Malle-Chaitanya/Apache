// The deterministic object-mapping matrix (PRD §9). This is config-as-data
// that drives the engine: for each source object type, what it becomes, which
// transformer builds the payload, what it depends on, and its feasibility.
// feasibility: auto | transform | partial | manual  (manual = no create API → conflict)

export const MATRIX = {
  // ── config ──
  groups:        { domain: 'config', targetType: 'groups',        transformer: 'group',        feasibility: 'auto',      dependsOn: [] },
  roles:         { domain: 'config', targetType: 'roles',         transformer: 'role',         feasibility: 'manual',    dependsOn: [] },
  ticketFields:  { domain: 'config', targetType: 'ticketFields',  transformer: 'ticketField',  feasibility: 'transform', dependsOn: [] },
  brands:        { domain: 'config', targetType: 'products',      transformer: 'brand',        feasibility: 'manual',    dependsOn: [] },
  businessHours: { domain: 'config', targetType: 'businessHours', transformer: 'businessHours',feasibility: 'manual',    dependsOn: [] },
  slaPolicies:   { domain: 'config', targetType: 'slaPolicies',   transformer: 'sla',          feasibility: 'partial',   dependsOn: ['businessHours'] },
  agents:        { domain: 'config', targetType: 'agents',        transformer: 'agent',        feasibility: 'partial',   dependsOn: ['groups', 'roles'] },
  triggers:      { domain: 'config', targetType: 'automationRules', transformer: 'trigger',    feasibility: 'manual',    dependsOn: ['groups', 'ticketFields'] },
  automations:   { domain: 'config', targetType: 'automationRules', transformer: 'automation', feasibility: 'manual',    dependsOn: [] },
  macros:        { domain: 'config', targetType: 'cannedResponses', transformer: 'macro',      feasibility: 'partial',   dependsOn: ['groups'] },
  // ── data ──
  organizations: { domain: 'data', targetType: 'companies',     transformer: 'organization', feasibility: 'auto',      dependsOn: [] },
  users:         { domain: 'data', targetType: 'contacts',      transformer: 'user',         feasibility: 'auto',      dependsOn: ['organizations'] },
  kbCategories:  { domain: 'data', targetType: 'kbCategories',  transformer: 'kbCategory',   feasibility: 'auto',      dependsOn: [] },
  kbSections:    { domain: 'data', targetType: 'kbFolders',     transformer: 'kbSection',    feasibility: 'auto',      dependsOn: ['kbCategories'] },
  kbArticles:    { domain: 'data', targetType: 'kbArticles',    transformer: 'kbArticle',    feasibility: 'transform', dependsOn: ['kbSections'] },
  tickets:       { domain: 'data', targetType: 'tickets',       transformer: 'ticket',       feasibility: 'transform', dependsOn: ['groups', 'agents', 'users', 'organizations', 'ticketFields'] },
};

// Extraction order (any order works; keep deterministic).
export const EXTRACT_ORDER = Object.keys(MATRIX);

// Load order: config before data, dependencies before dependents (PRD §6).
export const LOAD_ORDER = [
  'groups', 'roles', 'ticketFields', 'brands', 'businessHours', 'slaPolicies',
  'agents', 'triggers', 'automations', 'macros',
  'organizations', 'users', 'kbCategories', 'kbSections', 'kbArticles', 'tickets',
];

export const CONFIG_TYPES = LOAD_ORDER.filter((t) => MATRIX[t].domain === 'config');
export const DATA_TYPES = LOAD_ORDER.filter((t) => MATRIX[t].domain === 'data');
