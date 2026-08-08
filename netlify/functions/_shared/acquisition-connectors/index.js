import { connector as laCountyEcaps } from './la-county-ecaps.js';
import { connector as caCalEProcureCscr } from './ca-caleprocure-cscr-v14.js';
import { connector as agentPublicSourceDiscovery } from './agent-public-source-discovery.js';
import { connector as openGovPublicBrowser } from './opengov-public-browser.js';
import { connector as publicJsonApi } from './public-json-api.js';

const CONNECTORS = Object.freeze([laCountyEcaps, caCalEProcureCscr, openGovPublicBrowser, agentPublicSourceDiscovery, publicJsonApi]);

// Only these connectors are reachable through the discovery-only fallback
// below. They are the two adapters that can run against ANY publisher's
// documented evidence without hand-written publisher-specific code:
// PUBLIC_JSON_API when a structured open-data endpoint is on record, and
// AGENT_PUBLIC_SOURCE_DISCOVERY as a bounded fallback otherwise. Adding a
// connector here does not automatically enable it for production/certified
// acquisition — that still requires an explicit connector_key or a
// publisherNames/hostnames match, unchanged from today.
const DISCOVERY_FALLBACK_KEYS = Object.freeze(['PUBLIC_JSON_API', 'AGENT_PUBLIC_SOURCE_DISCOVERY']);

const txt = value => String(value ?? '').trim();

function explicitConnectorKey({ publisher, assignment }) {
  const configuration = typeof publisher?.configuration === 'object' && publisher.configuration ? publisher.configuration : {};
  const searchParameters = typeof assignment?.search_parameters === 'object' && assignment.search_parameters ? assignment.search_parameters : {};
  return txt(searchParameters.connector_key || searchParameters.connection_config?.connector_key || configuration.connector_key).toUpperCase();
}

function nameOrHostnameMatch({ publisher, assignment }) {
  const publisherName = txt(publisher?.publisher_name).toLowerCase();
  const endpoint = txt(assignment?.search_endpoint || publisher?.search_endpoint || publisher?.procurement_website || publisher?.official_website);
  let hostname = '';
  try { hostname = new URL(endpoint).hostname.toLowerCase(); } catch { hostname = ''; }
  return CONNECTORS.find(item => item.publisherNames.some(name => name.toLowerCase() === publisherName) || item.hostnames.includes(hostname)) || null;
}

// Discovery-lane-only resolution. Never called unless the caller explicitly
// opts in via discoveryMode — production/certification callers (e.g.
// command-verify-publisher-connection-background.js) never pass it and are
// completely unaffected. Requires the publisher to actually be M2M
// classified AND to have a real READY assignment AND for that assignment to
// carry a genuinely executable discovery profile (endpoint + field mapping,
// or an agent command instruction) — a publisher with no profile still
// returns null here so the caller can report "requires discovery-profile
// configuration" instead of silently guessing a connector.
function resolveDiscoveryFallback({ publisher, assignment }) {
  const configuration = typeof publisher?.configuration === 'object' && publisher.configuration ? publisher.configuration : {};
  const machineToMachine = publisher?.machine_to_machine_supported === true || configuration.machine_to_machine_supported === true;
  if (!machineToMachine) return null;
  if (!assignment || txt(assignment.status).toUpperCase() !== 'READY') return null;

  const searchParameters = typeof assignment.search_parameters === 'object' && assignment.search_parameters ? assignment.search_parameters : {};
  const profile = (searchParameters.acquisition_discovery_profile && typeof searchParameters.acquisition_discovery_profile === 'object' && searchParameters.acquisition_discovery_profile)
    || (configuration.acquisition_discovery_profile && typeof configuration.acquisition_discovery_profile === 'object' && configuration.acquisition_discovery_profile)
    || {};
  const profileConnectorKey = txt(profile.connector_key).toUpperCase();

  if (profileConnectorKey && DISCOVERY_FALLBACK_KEYS.includes(profileConnectorKey)) {
    const byKey = CONNECTORS.find(item => item.key === profileConnectorKey);
    if (byKey) return byKey;
  }

  // No explicit discovery connector_key recorded — fall back to the agent
  // adapter only if the profile actually carries the command instruction it
  // requires. Otherwise there is nothing executable to resolve to.
  const commandInstruction = txt(
    profile.command_instruction
    || searchParameters.acquisition_command_instruction
    || configuration.acquisition_command_instruction
  );
  if (commandInstruction) {
    return CONNECTORS.find(item => item.key === 'AGENT_PUBLIC_SOURCE_DISCOVERY') || null;
  }
  return null;
}

export function resolveConnector({ publisher, assignment, discoveryMode = false }) {
  const explicitKey = explicitConnectorKey({ publisher, assignment });
  if (explicitKey) {
    const explicit = CONNECTORS.find(item => item.key === explicitKey);
    if (!explicit) throw new Error(`No acquisition connector is registered for connector_key ${explicitKey}.`);
    return explicit;
  }

  const matched = nameOrHostnameMatch({ publisher, assignment });
  if (matched) return matched;

  if (discoveryMode) {
    const fallback = resolveDiscoveryFallback({ publisher, assignment });
    if (fallback) return fallback;
    throw new Error(`${publisher?.publisher_name || 'This M2M publisher'} requires discovery-profile configuration.`);
  }

  throw new Error(`No tested publisher-specific connector is configured for ${publisher?.publisher_name || 'this publisher'}.`);
}

export function listConnectorKeys() { return CONNECTORS.map(item => item.key); }
