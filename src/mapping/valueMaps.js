// Deterministic Zendesk→Freshdesk value translations (PRD §9.3, §10.2).
// Pure lookup tables — no inference, no LLM.

export const STATUS = { new: 2, open: 2, pending: 3, hold: 3, solved: 4, closed: 5 }; // Freshdesk status ids
export const PRIORITY = { low: 1, normal: 2, high: 3, urgent: 4 };
export const SOURCE = { email: 1, web: 2, chat: 7, phone: 3, api: 2, mobile: 2 };

// Zendesk ticket-field type → Freshdesk custom-field type.
export const FIELD_TYPE = {
  text: 'custom_text',
  textarea: 'custom_paragraph',
  integer: 'custom_number',
  decimal: 'custom_decimal',
  date: 'custom_date',
  checkbox: 'custom_checkbox',
  tagger: 'custom_dropdown',
  multiselect: 'custom_dropdown',
  regexp: 'custom_text',   // no FD regex type → text + validation note (conflict)
};

// Zendesk role/custom-role → nearest Freshdesk DEFAULT role. Freshdesk has no API
// to create custom roles, so we map to the built-in roles every account ships with.
// Freshdesk hierarchy (verified, support.freshdesk.com/.../96909):
//   Account Administrator > Administrator > Supervisor > Agent
// NOTE: we deliberately never auto-assign "Account Administrator" — Freshdesk
// requires exactly one (the account creator) and it carries billing access.
// Verified LIVE against cloudfuze-help.freshdesk.com /roles — every account ships
// these default roles (ids are account-specific, resolved at load time):
//   Account Administrator > Administrator > Supervisor > Agent > Ticket Collaborator
export const ROLE_NAME_MAP = {
  // Zendesk custom-role NAME → Freshdesk default role
  'Admin': 'Administrator',
  'Administrator': 'Administrator',
  'Billing admin': 'Administrator',
  'Team Lead': 'Supervisor',
  'Team Leader': 'Supervisor',
  'Supervisor': 'Supervisor',
  'Advisor': 'Supervisor',
  'Senior Agent': 'Agent',
  'Staff': 'Agent',
  'Light agent': 'Ticket Collaborator',   // FD's real limited-seat role
  'Contributor': 'Ticket Collaborator',
  'Read-only Auditor': 'Ticket Collaborator',
};
// Back-compat alias — the role transformer reads ROLE_DEFAULT[name].
export const ROLE_DEFAULT = ROLE_NAME_MAP;

// Freshdesk ticket_scope: 1 = Global, 2 = Group-restricted, 3 = Assigned-only.
const ROLE_SCOPE = { 'Account Administrator': 1, Administrator: 1, Supervisor: 1, Agent: 2, 'Ticket Collaborator': 3 };

// Deterministic Zendesk agent → Freshdesk default role + ticket scope.
// Keys off Zendesk `role` + `role_type` (present on every agent object):
//   null/0 = agent, 1 = light agent, 2 = chat, 3 = contributor, 4 = admin, 5 = billing admin.
// `custom_role_name` (joined from /custom_roles when available) refines it.
export function mapAgentRole(agent = {}) {
  let role;
  if (agent.role_type === 4 || agent.role_type === 5 || agent.role === 'admin') role = 'Administrator';
  else if (agent.role_type === 1 || agent.role_type === 3) role = 'Ticket Collaborator'; // light agent / contributor
  else if (agent.custom_role_name && ROLE_NAME_MAP[agent.custom_role_name]) role = ROLE_NAME_MAP[agent.custom_role_name];
  else role = 'Agent';                    // full agent (null/0), chat (2)
  return {
    role,
    ticketScope: ROLE_SCOPE[role] || 2,
    light: agent.role_type === 1,
    billingAdmin: agent.role_type === 5,  // FD Administrator can't see billing → surfaced for review
  };
}

export const mapStatus = (s) => STATUS[s] ?? 2;
export const mapPriority = (p) => PRIORITY[p] ?? 2;
export const mapSource = (s) => SOURCE[s] ?? 2;
export const mapFieldType = (t) => FIELD_TYPE[t] ?? 'custom_text';
