import { response, parseBody, requireDashboardAuth, db } from './_shared/native-runtime.js';

const parseObject = value => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
};

const isApprovedProfile = configuration => {
  const status = String(configuration.approval_status || '').trim().toUpperCase();
  return configuration.publisher_profile_approved === true
    && configuration.profile_complete === true
    && configuration.approved_for_operator_menu === true
    && status === 'APPROVED';
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
    const acquisitionDiscovery = body.mission_type_key === 'ACQUISITION_DISCOVERY' || body.acquisition_discovery === true;
    if (!/^[A-Z]{2}$/.test(stateCode)) return response(400, { error: 'Valid state_code is required.' });
    if (!countyName) return response(400, { error: 'county_name is required.' });

    const baseFilter = `state_code=eq.${encodeURIComponent(stateCode)}&county_name=eq.${encodeURIComponent(countyName)}`;
    const discoveryFilter = acquisitionDiscovery ? '&machine_to_machine_supported=eq.true' : '&verified=eq.true&access_status=eq.READY';
    const rows = await db(`publisher_registry?${baseFilter}${discoveryFilter}&select=id,publisher_name,state_code,county_name,county_fips,organization_type,official_website,procurement_website,acquisition_method,search_endpoint,verified,access_status,access_class,machine_to_machine_supported,connector_strategy,engineering_complexity,reuse_score,connector_roi_score,last_verified_at,configuration&order=publisher_name.asc`);

    const publishers = (rows || [])
      .filter(p => String(p.publisher_name || '').trim())
      .map(p => {
        const configuration = parseObject(p.configuration);
        const endpoint = p.search_endpoint || p.procurement_website || p.official_website || null;
        const connectorKey = String(configuration.connector_key || '').trim() || null;
        const acquisitionProfile = parseObject(configuration.acquisition_discovery_profile || configuration.acquisition_discovery);
        const commandInstruction = String(acquisitionProfile.command_instruction || configuration.acquisition_command_instruction || '').trim() || null;
        const certificationStatus = String(configuration.certification_status || 'DEVELOPMENT').toUpperCase();
        const approved = isApprovedProfile(configuration);
        const certified = ['CERTIFIED', 'PRODUCTION'].includes(certificationStatus);
        const machineToMachine = p.machine_to_machine_supported === true || configuration.machine_to_machine_supported === true;
        const minimumAccessPrepared = acquisitionProfile.enabled === true
          && String(acquisitionProfile.access_tier || '').toUpperCase() === 'MINIMUM_ACCESS'
          && Boolean(commandInstruction)
          && Boolean(endpoint)
          && configuration.authentication_required !== true
          && configuration.login_required !== true
          && configuration.stateful_session_required !== true
          && configuration.javascript_required !== true
          && configuration.browser_automation_required !== true;

        const executionMode = acquisitionDiscovery
          ? 'M2M_ACQUISITION_DISCOVERY'
          : certified
            ? 'CERTIFIED_CONNECTOR'
            : minimumAccessPrepared
              ? 'EAG_001_REQUIRED'
              : 'VERIFICATION_REQUIRED';

        return {
          publisher_id: p.id,
          publisher_name: p.publisher_name,
          county_name: p.county_name,
          county_fips: p.county_fips,
          organization_type: p.organization_type,
          official_website: p.official_website,
          procurement_website: p.procurement_website,
          acquisition_method: p.acquisition_method || 'AUTO_RESOLVE',
          search_endpoint: endpoint,
          platform: configuration.procurement_platform || null,
          access_class: p.access_class || configuration.access_class || configuration.platform_access_class || 'UNKNOWN',
          machine_to_machine_supported: machineToMachine,
          connector_strategy: p.connector_strategy || configuration.connector_strategy || configuration.recommended_connector_strategy || null,
          engineering_complexity: p.engineering_complexity || configuration.engineering_complexity || 'UNKNOWN',
          reuse_score: p.reuse_score == null ? null : Number(p.reuse_score),
          connector_roi_score: p.connector_roi_score == null ? null : Number(p.connector_roi_score),
          connector_key: connectorKey,
          connector_label: connectorKey === 'AGENT_PUBLIC_SOURCE_DISCOVERY' ? 'TARGETED PUBLIC-SOURCE AGENT' : connectorKey || (machineToMachine ? 'M2M PROFILE' : 'CONNECTOR PROFILE REQUIRED'),
          connector_version: configuration.connector_version || null,
          certification_status: certificationStatus,
          approval_status: String(configuration.approval_status || 'PENDING').toUpperCase(),
          approved_at: configuration.approved_at || null,
          approval_basis: configuration.approval_basis || null,
          source_verified: p.verified === true,
          access_status: p.access_status || 'DISCOVERED',
          profile_complete: configuration.profile_complete === true,
          publisher_profile_approved: configuration.publisher_profile_approved === true,
          approved_for_operator_menu: configuration.approved_for_operator_menu === true,
          minimum_access_prepared: minimumAccessPrepared,
          m2m_discovery_ready: machineToMachine,
          acquisition_instruction_configured: Boolean(commandInstruction),
          execution_mode: executionMode,
          selectable: acquisitionDiscovery ? machineToMachine : (includeTesting || certified),
          eligible_for_selection: acquisitionDiscovery ? machineToMachine : true,
          eligible_for_acquisition: approved && certified,
          readiness_reason: acquisitionDiscovery
            ? 'M2M publisher is available for operator-led Acquisition Discovery. Discovery will determine and validate the usable acquisition method.'
            : certified
              ? null
              : minimumAccessPrepared
                ? 'READY publisher requires EAG-001 certification before production acquisition.'
                : 'READY publisher requires connector verification before production acquisition.'
        };
      })
      .filter(p => !acquisitionDiscovery || p.machine_to_machine_supported)
      .sort((a, b) => a.publisher_name.localeCompare(b.publisher_name));

    return response(200, {
      state_code: stateCode,
      county_name: countyName,
      execution_scope: 'SINGLE_COUNTY_SINGLE_PUBLISHER',
      selection_policy: acquisitionDiscovery ? 'ALL_M2M_PUBLISHERS_IN_SELECTED_COUNTY' : 'ALL_VERIFIED_READY_PUBLISHERS',
      acquisition_policy: acquisitionDiscovery ? 'NO_PRECERTIFICATION_GATE_DISCOVERY_ONLY' : 'CERTIFICATION_REQUIRED_AT_EXECUTION',
      include_testing: includeTesting,
      publisher_count: publishers.length,
      publishers
    });
  } catch (error) {
    console.error('command-publisher-options failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};