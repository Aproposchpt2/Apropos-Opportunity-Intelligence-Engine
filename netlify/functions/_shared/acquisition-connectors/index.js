import { connector as laCountyEcaps } from './la-county-ecaps.js';
import { connector as caCalEProcureCscr } from './ca-caleprocure-cscr.js';

const CONNECTORS = Object.freeze([laCountyEcaps, caCalEProcureCscr]);

const txt = value => String(value ?? '').trim();

export function resolveConnector({ publisher, assignment }) {
  const configuration = typeof publisher?.configuration === 'object' && publisher.configuration
    ? publisher.configuration
    : {};
  const searchParameters = typeof assignment?.search_parameters === 'object' && assignment.search_parameters
    ? assignment.search_parameters
    : {};

  const explicitKey = txt(
    searchParameters.connector_key ||
    searchParameters.connection_config?.connector_key ||
    configuration.connector_key
  ).toUpperCase();

  if (explicitKey) {
    const explicit = CONNECTORS.find(item => item.key === explicitKey);
    if (!explicit) throw new Error(`No acquisition connector is registered for connector_key ${explicitKey}.`);
    return explicit;
  }

  const publisherName = txt(publisher?.publisher_name).toLowerCase();
  const endpoint = txt(assignment?.search_endpoint || publisher?.search_endpoint || publisher?.procurement_website || publisher?.official_website);
  let hostname = '';
  try { hostname = new URL(endpoint).hostname.toLowerCase(); } catch { hostname = ''; }

  const matched = CONNECTORS.find(item =>
    item.publisherNames.some(name => name.toLowerCase() === publisherName) ||
    item.hostnames.includes(hostname)
  );

  if (!matched) {
    throw new Error(`No tested publisher-specific connector is configured for ${publisher?.publisher_name || 'this publisher'}.`);
  }
  return matched;
}

export function listConnectorKeys() {
  return CONNECTORS.map(item => item.key);
}
