import { corsHeaders, db, json, parseBody } from '../_shared/command.ts';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = asRecord(await parseBody(request));
    const stateCode = text(body.state_code).toUpperCase();
    const candidates = Array.isArray(body.publisher_candidates) ? body.publisher_candidates.map(asRecord) : [];
    if (!/^[A-Z]{2}$/.test(stateCode)) return json({ error: 'state_code must be a two-letter state code' }, 400);

    const created = await db('publisher_discovery_runs', {
      method: 'POST',
      body: JSON.stringify({
        state_code: stateCode,
        status: 'RUNNING',
        current_stage: 'PUBLISHER_DISCOVERY_STARTED',
        started_at: new Date().toISOString(),
        evidence: { candidate_count: candidates.length, source: 'AUTHORIZED_OPERATOR_INPUT' }
      })
    });
    const discovery = created[0];

    let inserted = 0;
    let existing = 0;
    for (const candidate of candidates) {
      const publisherName = text(candidate.publisher_name || candidate.organization_name);
      if (!publisherName) continue;
      const found = await db(`publisher_registry?publisher_name=eq.${encodeURIComponent(publisherName)}&state_code=eq.${stateCode}&select=id`);
      const payload = {
        publisher_name: publisherName,
        state_code: stateCode,
        organization_type: text(candidate.organization_type) || null,
        official_website: text(candidate.official_website) || null,
        procurement_website: text(candidate.procurement_website) || null,
        acquisition_method: text(candidate.acquisition_method) || 'UNASSESSED',
        search_endpoint: text(candidate.search_endpoint) || null,
        vendor_registration_url: text(candidate.vendor_registration_url) || null,
        verified: false,
        access_status: 'PENDING_PROJECT_OWNER_APPROVAL',
        configuration: {
          procurement_platform: candidate.procurement_platform ?? null,
          technology_vendor: candidate.technology_vendor ?? null,
          official_sources: candidate.official_sources ?? [],
          registration_required: candidate.registration_required ?? null,
          discovery_run_id: discovery.id
        }
      };
      if (found.length) {
        await db(`publisher_registry?id=eq.${found[0].id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        existing += 1;
      } else {
        await db('publisher_registry', { method: 'POST', body: JSON.stringify(payload) });
        inserted += 1;
      }
    }

    await db('aadp_action_needed_alerts', {
      method: 'POST',
      body: JSON.stringify({
        discovery_run_id: discovery.id,
        state_code: stateCode,
        current_stage: 'PUBLISHER_RESULTS_PRESENTED',
        reason: 'State publisher-discovery results require Project Owner approval or exception review.',
        supporting_evidence: { publishers_presented: inserted + existing, inserted, updated: existing },
        risk: 'Unapproved publishers must not enter recurring acquisition.',
        recommended_action: 'Review and approve verified publisher records.',
        resume_point: 'PUBLISHER_REGISTRY_UPDATED',
        unrelated_publishers_may_continue: true
      })
    });

    await db(`publisher_discovery_runs?id=eq.${discovery.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'PAUSED',
        current_stage: 'PROJECT_OWNER_APPROVAL_OR_EXCEPTION_REVIEW',
        official_sources_identified: inserted + existing,
        publishers_presented: inserted + existing,
        evidence: {
          inserted,
          updated: existing,
          action_needed: true,
          resume_point: 'PUBLISHER_REGISTRY_UPDATED',
          unrelated_publishers_may_continue: true
        }
      })
    });

    return json({
      discovery_run_id: discovery.id,
      state_code: stateCode,
      status: 'ACTION_NEEDED',
      publishers_presented: inserted + existing,
      inserted,
      updated: existing
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
