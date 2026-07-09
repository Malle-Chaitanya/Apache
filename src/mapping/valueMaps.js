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

// Zendesk custom-role name → nearest Freshdesk default role (roles aren't API-creatable).
export const ROLE_DEFAULT = {
  'Senior Agent': 'Agent',
  'Read-only Auditor': 'Agent',
};

export const mapStatus = (s) => STATUS[s] ?? 2;
export const mapPriority = (p) => PRIORITY[p] ?? 2;
export const mapSource = (s) => SOURCE[s] ?? 2;
export const mapFieldType = (t) => FIELD_TYPE[t] ?? 'custom_text';
