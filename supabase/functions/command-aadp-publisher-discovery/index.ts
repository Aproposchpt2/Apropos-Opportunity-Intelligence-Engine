import { corsHeaders, db, json, parseBody, requireDashboardAuth } from '../_shared/command.ts';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

const GOVERNANCE = Object.freeze({
  official_source_research_required: true,
  duplicate_registry_detection_required: true,
  candidate_record_creation_enabled: true,
  human_review_before_registry_admission_required: true
});

async function createDiscoveryRun(body: JsonRecord, stateCode: string) {
  const created = await db('publisher_discovery_runs', {
    method: 'POST',
    body: JSON.stringify({
      state_code: stateCode,
      mission_name: text(body.mission_name) || null,
      discovery_scope: text(body.discovery_scope),
      organization_types: stringArray(body.organization_types),
      intelligence_provider: text(body.provider) || null,
      operator_name: text(body.operator) || null,
      governance: GOVERNANCE,
      status: 'RUNNING',
      current_stage: 'PUBLISHER_DISCOVERY_STARTED',
      started_at: new Date().toISOString(),
      evidence: {
        source: 'COMMAND_CENTER_DISCOVERY_MISSION',
        mission_notes: text(body.notes) || null,
        governance: GOVERNANCE
      }
    })
  });
  return created[0];
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const authError = await requireDashboardAuth(request); if (authError) return authError;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = asRecord(await parseBody(request));
    const stateCode = text(body.state_code).toUpperCase();
    const candidates = Array.isArray(body.publisher_candidates) ? body.publisher_candidates.map(asRecord) : [];
    const action = text(body.action).toUpperCase() || (candidates.length ? 'START_AND_INGEST' : 'START');
    const discoveryRunId = text(body.discovery_run_id);
    if (!/^[A-Z]{2}$/.test(stateCode)) return json({ error: 'state_code must be a two-letter state code' }, 400);
    if (!discoveryRunId) {
      if (!text(body.discovery_scope)) return json({ error: 'discovery_scope is required for a new Discovery mission' }, 400);
      if (stringArray(body.organization_types).length === 0) return json({ error: 'At least one organization_type is required for a new Discovery mission' }, 400);
    }

    let discovery: JsonRecord | undefined;
    if (discoveryRunId) {
      const existingRuns = await db(`publisher_discovery_runs?id=eq.${encodeURIComponent(discoveryRunId)}&select=*`);
      discovery = existingRuns?.[0];
      if (!discovery) return json({ error: 'Discovery run not found' }, 404);
      if (text(discovery.state_code).toUpperCase() !== stateCode) return json({ error: 'state_code does not match discovery run' }, 409);
    } else {
      discovery = await createDiscoveryRun(body, stateCode);
    }

    if (action === 'START' && candidates.length === 0) {
      return json({
        discovery_run_id: discovery.id,
        state_code: stateCode,
        status: 'RUNNING',
        current_stage: 'PUBLISHER_DISCOVERY_STARTED',
        existing_publisher_selection_required: false,
        candidate_intake: 'PENDING',
        governance: GOVERNANCE
      }, 202);
    }

    let staged = 0;
    let duplicates = 0;
    let verifiedSources = 0;
    let researchRequired = 0;

    for (const candidate of candidates) {
      const publisherName = text(candidate.publisher_name || candidate.organization_name);
      if (!publisherName) continue;
      const officialSources = Array.isArray(candidate.official_sources) ? candidate.official_sources : [];
      const sourceVerified = candidate.official_source_verified === true && officialSources.length > 0;
      const found = await db(`publisher_registry?publisher_name=eq.${encodeURIComponent(publisherName)}&state_code=eq.${stateCode}&select=id,publisher_name`);
      const duplicatePublisherId = found?.[0]?.id ?? null;
      if (duplicatePublisherId) duplicates += 1;
      if (sourceVerified) verifiedSources += 1;
      else researchRequired += 1;

      await db('publisher_discovery_candidates', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({
          discovery_run_id: discovery.id,
          publisher_name: publisherName,
          state_code: stateCode,
          organization_type: text(candidate.organization_type) || null,
          official_website: text(candidate.official_website) || null,
          procurement_website: text(candidate.procurement_website) || null,
          acquisition_method: text(candidate.acquisition_method) || 'UNASSESSED',
          search_endpoint: text(candidate.search_endpoint) || null,
          vendor_registration_url: text(candidate.vendor_registration_url) || null,
          procurement_platform: text(candidate.procurement_platform) || null,
          technology_vendor: text(candidate.technology_vendor) || null,
          registration_required: typeof candidate.registration_required === 'boolean' ? candidate.registration_required : null,
          official_sources: officialSources,
          official_source_verified: sourceVerified,
          duplicate_publisher_id: duplicatePublisherId,
          duplicate_status: duplicatePublisherId ? 'EXISTING_REGISTRY_MATCH' : 'NO_MATCH',
          review_status: sourceVerified ? 'PENDING_REVIEW' : 'RESEARCH_REQUIRED'
        })
      });
      staged += 1;
    }

    if (staged > 0) {
      await db('aadp_action_needed_alerts', {
        method: 'POST',
        body: JSON.stringify({
          discovery_run_id: discovery.id,
          state_code: stateCode,
          current_stage: 'PUBLISHER_RESULTS_PRESENTED',
          reason: 'Publisher discovery candidates require human review before Registry admission.',
          supporting_evidence: { staged, duplicates, official_sources_verified: verifiedSources, research_required: researchRequired },
          risk: 'Discovery candidates are non-authoritative and must not enter recurring acquisition before approval.',
          recommended_action: 'Review verified candidates; approve or reject each record. Resolve duplicate matches before admission.',
          resume_point: 'CANDIDATE_REVIEW',
          unrelated_publishers_may_continue: true
        })
      });
    }

    await db(`publisher_discovery_runs?id=eq.${discovery.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: staged > 0 ? 'PAUSED' : 'RUNNING',
        current_stage: staged > 0 ? 'PROJECT_OWNER_APPROVAL_OR_EXCEPTION_REVIEW' : 'PUBLISHER_DISCOVERY_STARTED',
        official_sources_identified: verifiedSources,
        publishers_presented: staged,
        evidence: {
          candidate_records_staged: staged,
          duplicate_registry_matches: duplicates,
          official_sources_verified: verifiedSources,
          research_required: researchRequired,
          registry_records_created: 0,
          human_review_required: true,
          resume_point: staged > 0 ? 'CANDIDATE_REVIEW' : 'PUBLISHER_DISCOVERY_STARTED',
          governance: GOVERNANCE
        }
      })
    });

    return json({
      discovery_run_id: discovery.id,
      state_code: stateCode,
      status: staged > 0 ? 'ACTION_NEEDED' : 'RUNNING',
      candidates_staged: staged,
      duplicate_registry_matches: duplicates,
      official_sources_verified: verifiedSources,
      research_required: researchRequired,
      registry_records_created: 0,
      human_review_required: true
    }, staged > 0 ? 200 : 202);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});