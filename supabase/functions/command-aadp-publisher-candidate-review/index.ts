import { corsHeaders, db, json, parseBody, requireEnv } from '../_shared/command.ts';

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : value == null ? '' : String(value);

async function requireOperator(request: Request): Promise<boolean> {
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) return false;
  const response = await fetch(`${requireEnv('SUPABASE_URL')}/rest/v1/rpc/command_is_operator`, {
    method: 'POST',
    headers: {
      apikey: requireEnv('SUPABASE_ANON_KEY'),
      Authorization: authorization,
      'Content-Type': 'application/json'
    },
    body: '{}'
  });
  if (!response.ok) return false;
  return (await response.json().catch(() => false)) === true;
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    if (!(await requireOperator(request))) return json({ error: 'Command Center operator authorization required' }, 403);
    const body = asRecord(await parseBody(request));
    const candidateId = text(body.candidate_id);
    const decision = text(body.decision).toUpperCase();
    const reviewNotes = text(body.review_notes) || null;
    if (!candidateId) return json({ error: 'candidate_id is required' }, 400);
    if (!['APPROVE','REJECT'].includes(decision)) return json({ error: 'decision must be APPROVE or REJECT' }, 400);

    const candidates = await db(`publisher_discovery_candidates?id=eq.${encodeURIComponent(candidateId)}&select=*`);
    const candidate = candidates?.[0];
    if (!candidate) return json({ error: 'Publisher discovery candidate not found' }, 404);
    if (['APPROVED_ADMITTED','REJECTED'].includes(candidate.review_status)) {
      return json({ candidate, idempotent_replay: true });
    }

    if (decision === 'REJECT') {
      const updated = await db(`publisher_discovery_candidates?id=eq.${candidate.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ review_status: 'REJECTED', review_notes: reviewNotes, reviewed_at: new Date().toISOString() })
      });
      return json({ candidate: updated?.[0] ?? candidate, registry_admission: 'REJECTED' });
    }

    if (candidate.official_source_verified !== true) {
      return json({ error: 'Official-source verification is required before Registry admission' }, 409);
    }
    if (candidate.duplicate_publisher_id) {
      return json({ error: 'Candidate matches an existing Publisher Registry record and cannot be admitted as a duplicate', duplicate_publisher_id: candidate.duplicate_publisher_id }, 409);
    }

    const duplicateCheck = await db(`publisher_registry?publisher_name=eq.${encodeURIComponent(candidate.publisher_name)}&state_code=eq.${encodeURIComponent(candidate.state_code)}&select=id`);
    if (duplicateCheck.length) {
      await db(`publisher_discovery_candidates?id=eq.${candidate.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ duplicate_publisher_id: duplicateCheck[0].id, duplicate_status: 'EXISTING_REGISTRY_MATCH' })
      });
      return json({ error: 'Duplicate Publisher Registry record detected during final admission check', duplicate_publisher_id: duplicateCheck[0].id }, 409);
    }

    const registryRows = await db('publisher_registry', {
      method: 'POST',
      body: JSON.stringify({
        publisher_name: candidate.publisher_name,
        state_code: candidate.state_code,
        organization_type: candidate.organization_type,
        official_website: candidate.official_website,
        procurement_website: candidate.procurement_website,
        acquisition_method: candidate.acquisition_method || 'UNASSESSED',
        search_endpoint: candidate.search_endpoint,
        vendor_registration_url: candidate.vendor_registration_url,
        verified: true,
        access_status: 'APPROVED_FOR_REGISTRY',
        last_verified_at: new Date().toISOString(),
        configuration: {
          procurement_platform: candidate.procurement_platform,
          technology_vendor: candidate.technology_vendor,
          registration_required: candidate.registration_required,
          official_sources: candidate.official_sources,
          discovery_run_id: candidate.discovery_run_id,
          discovery_candidate_id: candidate.id,
          admitted_by_human_review: true
        }
      })
    });
    const admitted = registryRows[0];

    const updatedCandidates = await db(`publisher_discovery_candidates?id=eq.${candidate.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        review_status: 'APPROVED_ADMITTED',
        review_notes: reviewNotes,
        reviewed_at: new Date().toISOString(),
        admitted_publisher_id: admitted.id
      })
    });

    const approvedCandidates = await db(`publisher_discovery_candidates?discovery_run_id=eq.${candidate.discovery_run_id}&review_status=eq.APPROVED_ADMITTED&select=id`);
    const unresolvedCandidates = await db(`publisher_discovery_candidates?discovery_run_id=eq.${candidate.discovery_run_id}&review_status=in.(PENDING_REVIEW,RESEARCH_REQUIRED)&select=id`);
    const completed = unresolvedCandidates.length === 0;
    await db(`publisher_discovery_runs?id=eq.${candidate.discovery_run_id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        publishers_approved: approvedCandidates.length,
        status: completed ? 'COMPLETED' : 'PAUSED',
        current_stage: completed ? 'PUBLISHER_REGISTRY_ADMISSION_COMPLETE' : 'PROJECT_OWNER_APPROVAL_OR_EXCEPTION_REVIEW',
        completed_at: completed ? new Date().toISOString() : null
      })
    });
    if (completed) {
      await db(`aadp_action_needed_alerts?discovery_run_id=eq.${candidate.discovery_run_id}&status=eq.OPEN`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'RESOLVED', selected_action: 'HUMAN_REVIEW_COMPLETE', resolved_at: new Date().toISOString() })
      });
    }

    return json({
      candidate: updatedCandidates?.[0] ?? candidate,
      registry_admission: 'APPROVED',
      publisher_id: admitted.id,
      discovery_run_complete: completed
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});