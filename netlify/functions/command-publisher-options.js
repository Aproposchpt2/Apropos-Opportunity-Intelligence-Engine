import { response, parseBody, requireDashboardAuth, db } from './_shared/native-runtime.js';

const parseObject = value => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
};

export const handler = async event => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });
  try {
    const body = parseBody(event);
    const stateCode = String(body.state_code || '').trim().toUpperCase();
    const includeTesting = body.include_testing === true;
    if (!/^[A-Z]{2}$/.test(stateCode)) return response(400, { error: 'Valid state_code is required.' });
    const rows = await db(`publisher_registry?state_code=eq.${encodeURIComponent(stateCode)}&verified=eq.true&select=id,publisher_name,state_code,organization_type,official_website,procurement_website,acquisition_method,search_endpoint,verified,access_status,last_verified_at,configuration&order=publisher_name.asc`);
    const publishers = (rows || []).filter(p => String(p.publisher_name || '').trim()).map(p => {
      const configuration = parseObject(p.configuration);
      const endpoint = p.search_endpoint || p.procurement_website || p.official_website || null;
      const connectorKey = String(configuration.connector_key || '').trim() || null;
      const certificationStatus = String(configuration.certification_status || 'DEVELOPMENT').toUpperCase();
      const profileReady = p.verified === true && String(p.access_status || '').toUpperCase() === 'READY' && Boolean(endpoint) && Boolean(connectorKey);
      const certified = ['CERTIFIED', 'PRODUCTION'].includes(certificationStatus);
      const selectable = includeTesting ? profileReady : profileReady && certified;
      return {
        publisher_id: p.id, publisher_name: p.publisher_name, organization_type: p.organization_type,
        official_website: p.official_website, procurement_website: p.procurement_website,
        acquisition_method: p.acquisition_method || 'AUTO_RESOLVE', search_endpoint: endpoint,
        connector_key: connectorKey, connector_label: connectorKey || 'CONNECTOR PROFILE REQUIRED',
        connector_version: configuration.connector_version || null, certification_status: certificationStatus,
        source_verified: p.verified === true, access_status: p.access_status || 'DISCOVERED',
        last_verified_at: configuration.last_verification_at || p.last_verified_at, selectable,
        readiness_reason: !profileReady ? 'Publisher profile, endpoint, or connector is not READY.' : !certified && !includeTesting ? 'Publisher must pass EAG-001 before Acquisition Discovery.' : null
      };
    });
    return response(200, { state_code: stateCode, execution_scope: 'SINGLE_PUBLISHER_REQUIRED', include_testing: includeTesting, publishers });
  } catch (error) {
    console.error('command-publisher-options failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
