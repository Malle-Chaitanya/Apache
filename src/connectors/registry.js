import { ZendeskSource } from './zendesk/index.js';
import { FreshdeskTarget } from './freshdesk/index.js';

// Platform → connector. Adding a new platform (Jira SM, ServiceNow, …) is just
// registering a connector here; the engine never changes.
const SOURCES = { zendesk: ZendeskSource };
const TARGETS = { freshdesk: FreshdeskTarget };

export function makeSource(platform, creds) {
  const C = SOURCES[platform];
  if (!C) throw new Error(`No source connector registered for platform: ${platform}`);
  return new C(creds);
}
export function makeTarget(platform, creds) {
  const C = TARGETS[platform];
  if (!C) throw new Error(`No target connector registered for platform: ${platform}`);
  return new C(creds);
}

export const sourcePlatforms = () => Object.keys(SOURCES);
export const targetPlatforms = () => Object.keys(TARGETS);
