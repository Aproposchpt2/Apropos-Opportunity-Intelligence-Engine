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
    const countyName = String(body.county_name || '').trim();
    const includeTesting = body.include_testing === true;
    if (!/^[A-Z]{2}$/.test(stateCode)) return response(400, { error: 'Valid state_code is required.' });
    if (!countyName) return response(400, { error: 'county_name is required.' });
    const rows = await db(`publisher_registry?state_code=eq.${encodeURIComponent(stateCode)}&county_name=eq.${encodeURIComponent(countyName)}&verified=eq.true&access_status=eq.READY&select=id,publisher_name,state_code,county_name,county_fips,organization_type,official_website,procurement_website,acquisition_method,search_endpoint,verified,access_status,access_class,machine_to_machine_supported,connector_strategy,engineering_complexity,reuse_score,connector_roi_score,last_verified_at,configuration&order=publisher_name.asc`);
    const publishers = (rows || []).filter(p => String(p.publisher_name || '').trim()).map(p => {
      const configuration = parseObject(p.configuration);
      const endpoint = p.search_endpoint || p.procurement_website || p.official_website || null;
      const connectorKey = String(configuration.connector_key || '').trim() || null;
      const acquisitionProfile = parseObject(configuration.acquisition_discovery_profile || configuration.acquisition_discovery);
      const commandInstruction = String(acquisitionProfile.command_instruction || configuration.acquisition_command_instruction || '').trim() || null;
      const minimumAccessPrepared = acquisitionProfile.enabled === true
        && String(acquisitionProfile.access_tier || '').toUpperCase() === 'MINIMUM_ACCESS'
        && Boolean(commandInstruction)
        && Boolean(endpoint)
        && configuration.authentication_required !== true
        && configuration.login_required !== true
        && configuration.stateful_session_required !== true
        && configuration.javascript_required !== true
        && configuration.browser_automation_required !== true;
      const certificationStatus = String(configuration.certification_status || 'DEVELOPMENT').toUpperCase();
      const profileReady = p.verified === true && String(p.access_status || '').toUpperCase() === 'READY' && Boolean(endpoint) && Boolean(connectorKey);
      const certified = ['CERTIFIED', 'PRODUCTION'].includes(certificationStatus);
      const selectable = includeTesting ? profileReady : profileReady && certified;
      return {
        publisher_id: p.id, publisher_name: p.publisher_name, county_name: p.county_name, county_fips: p.county_fips,
        organization_type: p.organization_type, official_website: p.official_website, procurement_website: p.procurement_website,
        acquisition_method: p.acquisition_method || 'AUTO_RESOLVE', search_endpoint: endpoint,
        platform: configuration.procurement_platform || null, access_class: p.access_class || configuration.access_class || configuration.platform_access_class || 'UNKNOWN',
        machine_to_machine_supported: p.machine_to_machine_supported ?? configuration.machine_to_machine_supported ?? null,
        connector_strategy: p.connector_strategy || configuration.connector_strategy || configuration.recommended_connector_strategy || null,
        engineering_complexity: p.engineering_complexity || configuration.engineering_complexity || 'UNKNOWN',
        reuse_score: p.reuse_score == null ? null : Number(p.reuse_score), connector_roi_score: p.connector_roi_score == null ? null : Number(p.connector_roi_score),
        connector_key: connectorKey, connector_label: connectorKey === 'AGENT_PUBLIC_SOURCE_DISCOVERY' ? 'TARGETED PUBLIC-SOURCE AGENT' : connectorKey || 'CONNECTOR PROFILE REQUIRED',
        connector_version: configuration.connector_version || null, certification_status: certificationStatus,
        source_verified: p.verified === true, access_status: p.access_status || 'DISCOVERED',
        minimum_access_prepared: minimumAccessPrepared, acquisition_instruction_configured: Boolean(commandInstruction),
        execution_mode: certified ? 'CERTIFIED_CONNECTOR' : minimumAccessPrepared ? 'EAG_001_REQUIRED' : 'NOT_PREPARED',
        last_verified_at: configuration.last_verification_at || p.last_verified_at, selectable,
        readiness_reason: !profileReady ? 'Publisher profile, endpoint, or connector is not READY.' : !certified && minimumAccessPrepared ? 'Minimum-access target is prepared; run EAG-001 once before Acquisition Discovery.' : !certified && !includeTesting ? 'Publisher must pass EAG-001 before Acquisition Discovery.' : null
      };
    });
    return response(200, { state_code: stateCode, county_name: countyName, execution_scope: 'SINGLE_COUNTY_SINGLE_PUBLISHER_REQUIRED', include_testing: includeTesting, publishers });
  } catch (error) {
    console.error('command-publisher-options failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
