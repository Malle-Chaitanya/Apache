import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS, PRIORITY, SOURCE, FIELD_TYPE, ROLE_NAME_MAP,
  mapStatus, mapPriority, mapSource, mapFieldType, mapAgentRole,
} from '../src/mapping/valueMaps.js';

// ─────────────────────────────────────────────────────────────────────────────
// Value maps are the deterministic heart of the migration — a wrong entry here
// silently mis-files every ticket. These lock the Zendesk→Freshdesk crosswalk.
// ─────────────────────────────────────────────────────────────────────────────

test('mapStatus: every Zendesk status maps to the documented Freshdesk id', () => {
  assert.equal(mapStatus('new'), 2);      // FD Open
  assert.equal(mapStatus('open'), 2);     // FD Open
  assert.equal(mapStatus('pending'), 3);  // FD Pending
  assert.equal(mapStatus('hold'), 3);     // FD Pending (no native Hold)
  assert.equal(mapStatus('solved'), 4);   // FD Resolved
  assert.equal(mapStatus('closed'), 5);   // FD Closed
});

test('mapStatus: unknown/empty status falls back to Open (2), never throws', () => {
  assert.equal(mapStatus('banana'), 2);
  assert.equal(mapStatus(undefined), 2);
  assert.equal(mapStatus(null), 2);
  assert.equal(mapStatus(''), 2);
});

test('mapPriority: full crosswalk + fallback to Medium (2)', () => {
  assert.equal(mapPriority('low'), 1);
  assert.equal(mapPriority('normal'), 2);
  assert.equal(mapPriority('high'), 3);
  assert.equal(mapPriority('urgent'), 4);
  assert.equal(mapPriority('whatever'), 2);
  assert.equal(mapPriority(undefined), 2);
});

test('mapSource: channel crosswalk collapses unknowns to Portal (2)', () => {
  assert.equal(mapSource('email'), 1);
  assert.equal(mapSource('web'), 2);
  assert.equal(mapSource('chat'), 7);
  assert.equal(mapSource('phone'), 3);
  assert.equal(mapSource('api'), 2);
  assert.equal(mapSource('mobile'), 2);
  assert.equal(mapSource('twitter'), 2); // unmapped channel → Portal, not rejected
  assert.equal(mapSource(undefined), 2);
});

test('mapFieldType: Zendesk field type → Freshdesk custom-field type', () => {
  assert.equal(mapFieldType('text'), 'custom_text');
  assert.equal(mapFieldType('textarea'), 'custom_paragraph');
  assert.equal(mapFieldType('integer'), 'custom_number');
  assert.equal(mapFieldType('decimal'), 'custom_decimal');
  assert.equal(mapFieldType('date'), 'custom_date');
  assert.equal(mapFieldType('checkbox'), 'custom_checkbox');
  assert.equal(mapFieldType('tagger'), 'custom_dropdown');
  assert.equal(mapFieldType('multiselect'), 'custom_dropdown');
  assert.equal(mapFieldType('regexp'), 'custom_text'); // no FD regex type
  assert.equal(mapFieldType('mystery'), 'custom_text'); // safe default
});

test('map tables are internally consistent with their helper accessors', () => {
  for (const [k, v] of Object.entries(STATUS)) assert.equal(mapStatus(k), v);
  for (const [k, v] of Object.entries(PRIORITY)) assert.equal(mapPriority(k), v);
  for (const [k, v] of Object.entries(SOURCE)) assert.equal(mapSource(k), v);
  for (const [k, v] of Object.entries(FIELD_TYPE)) assert.equal(mapFieldType(k), v);
});

// ── mapAgentRole: the permission-fidelity core ──────────────────────────────

test('mapAgentRole: role_type 4 (admin) → Administrator, global scope, not billing', () => {
  const r = mapAgentRole({ role_type: 4 });
  assert.equal(r.role, 'Administrator');
  assert.equal(r.ticketScope, 1);
  assert.equal(r.billingAdmin, false);
});

test('mapAgentRole: role_type 5 (billing admin) → Administrator + billingAdmin flag', () => {
  const r = mapAgentRole({ role_type: 5 });
  assert.equal(r.role, 'Administrator');
  assert.equal(r.billingAdmin, true); // surfaced for human review — FD admin has no billing
});

test('mapAgentRole: role "admin" string also maps to Administrator', () => {
  assert.equal(mapAgentRole({ role: 'admin' }).role, 'Administrator');
});

test('mapAgentRole: light agent (role_type 1) → Ticket Collaborator, assigned-only scope', () => {
  const r = mapAgentRole({ role_type: 1 });
  assert.equal(r.role, 'Ticket Collaborator');
  assert.equal(r.ticketScope, 3);
  assert.equal(r.light, true);
});

test('mapAgentRole: contributor (role_type 3) → Ticket Collaborator', () => {
  assert.equal(mapAgentRole({ role_type: 3 }).role, 'Ticket Collaborator');
});

test('mapAgentRole: custom_role_name refines a plain agent', () => {
  assert.equal(mapAgentRole({ custom_role_name: 'Team Lead' }).role, 'Supervisor');
  assert.equal(mapAgentRole({ custom_role_name: 'Light agent' }).role, 'Ticket Collaborator');
  // Unknown custom role name → falls through to plain Agent, never crashes.
  assert.equal(mapAgentRole({ custom_role_name: 'Wizard' }).role, 'Agent');
});

test('mapAgentRole: plain agent (no role_type) and chat agent (2) → Agent, group scope', () => {
  const plain = mapAgentRole({});
  assert.equal(plain.role, 'Agent');
  assert.equal(plain.ticketScope, 2);
  assert.equal(mapAgentRole({ role_type: 2 }).role, 'Agent');
});

test('mapAgentRole: role_type precedence beats custom_role_name (admin wins)', () => {
  // A billing admin who also carries a "Senior Agent" custom role must still be
  // an Administrator — role_type is authoritative.
  const r = mapAgentRole({ role_type: 4, custom_role_name: 'Senior Agent' });
  assert.equal(r.role, 'Administrator');
});

test('ROLE_NAME_MAP never maps anything to "Account Administrator" (billing safety)', () => {
  // FD requires exactly one Account Administrator (the creator). Auto-assigning it
  // would break the target account — assert we never do.
  for (const target of Object.values(ROLE_NAME_MAP)) {
    assert.notEqual(target, 'Account Administrator');
  }
});
