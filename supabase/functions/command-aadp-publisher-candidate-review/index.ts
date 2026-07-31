import { corsHeaders, db, json, parseBody, recordEvent, requireDashboardAuth, requireServiceRole } from '../_shared/command.ts';

type J = Record<string, unknown>;
const R = (v: unknown): J => v && typeof v === 'object' && !Array.isArray(v) ? v as J : {};
const T = (v: unknown): string => typeof v === 'string' ? v.trim() : v == null ? '' : String(v);

async function auth(request: Request) {
  const serviceError = requireServiceRole(request);
  return serviceError ? await requireDashboardAuth(request) : null;
}

async function recordReviewDecision(candidate: J, decision: 'APPROVE' | 'REJECT', publisherId: string | null, reviewNotes: string | null) {
  const discoveryRunId = T(candidate.discovery_run_id);
  if (!discoveryRunId) return;
  const discovery = (await db(`publisher_discovery_runs?id=eq.${discoveryRunId}&select=command_run_id`))?.[0];
  const commandRunId = T(discovery?.command_run_id);
  if (!commandRunId) return;
  const approved = decision === 'APPROVE';
  await recordEvent(
    commandRunId,
    null,
    approved ? 'PUBLISHER_DISCOVERY_CANDIDATE_APPROVED' : 'PUBLISHER_DISCOVERY_CANDIDATE_REJECTED',
    approved ? 'Publisher candidate approved by human review and admitted to Publisher Registry' : 'Publisher candidate rejected by human review',
    {
      discovery_run_id: discoveryRunId,
      candidate_id: T(candidate.id),
      publisher_name: T(candidate.publisher_name),
      publisher_id: publisherId,
      decision,
      decision_source: 'DASHBOARD_HUMAN_REVIEW',
      review_notes: reviewNotes,
      official_source_verified: candidate.official_source_verified === true,
      duplicate_status: T(candidate.duplicate_status) || null
    }
  ).catch(() => null);
}

async function finalizeDiscovery(discoveryRunId: string) {
  const discovery = (await db(`publisher_discovery_runs?id=eq.${discoveryRunId}&select=*`))?.[0];
  if (!discovery) return { completed: false, discovery: null };

  const approved = await db(`publisher_discovery_candidates?discovery_run_id=eq.${discoveryRunId}&review_status=eq.APPROVED_ADMITTED&select=id`);
  const unresolved = await db(`publisher_discovery_candidates?discovery_run_id=eq.${discoveryRunId}&review_status=in.(PENDING_REVIEW,RESEARCH_REQUIRED)&select=id`);
  const completed = unresolved.length === 0;
  const now = new Date().toISOString();

  await db(`publisher_discovery_runs?id=eq.${discoveryRunId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      publishers_approved: approved.length,
      status: completed ? 'COMPLETED' : 'PAUSED',
      current_stage: completed ? 'PUBLISHER_REGISTRY_ADMISSION_COMPLETE' : 'PROJECT_OWNER_APPROVAL_OR_EXCEPTION_REVIEW',
      completed_at: completed ? now : null,
      updated_at: now
    })
  });

  if (completed) {
    await db(`aadp_action_needed_alerts?discovery_run_id=eq.${discoveryRunId}&status=eq.OPEN`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'RESOLVED', selected_action: 'HUMAN_REVIEW_COMPLETE', resolved_at: now })
    }).catch(() => null);

    const commandRunId = T(discovery.command_run_id);
    if (commandRunId) {
      await db(`command_stage_projection?command_run_id=eq.${commandRunId}&stage_key=eq.CANDIDATE_REVIEW`, {
        method: 'PATCH',
        body: JSON.stringify({ display_state: 'COMPLETED', progress_value: 100, completed_at: now, updated_at: now })
      }).catch(() => null);
      await db(`command_runs?id=eq.${commandRunId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'completed', aadp_state: 'COMPLETED', current_stage: null, progress_value: 100,
          action_required: false, last_activity_at: now, completed_at: now,
          result_summary: `Publisher Discovery review complete. ${approved.length} publisher(s) admitted to the Registry.`
        })
      });
      await recordEvent(commandRunId, null, 'PUBLISHER_DISCOVERY_REVIEW_COMPLETE', 'Publisher Discovery human review completed', {
        discovery_run_id: discoveryRunId, publishers_approved: approved.length
      }).catch(() => null);
    }
  }

  return { completed, discovery, approved: approved.length, unresolved: unresolved.length };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const authError = await auth(request); if (authError) return authError;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = R(await parseBody(request));
    const candidateId = T(body.candidate_id);
    const decision = T(body.decision).toUpperCase();
    const reviewNotes = T(body.review_notes) || null;
    if (!candidateId) return json({ error: 'candidate_id is required' }, 400);
    if (!['APPROVE', 'REJECT'].includes(decision)) return json({ error: 'decision must be APPROVE or REJECT' }, 400);

    const candidate = (await db(`publisher_discovery_candidates?id=eq.${encodeURIComponent(candidateId)}&select=*`))?.[0];
    if (!candidate) return json({ error: 'Publisher discovery candidate not found' }, 404);
    if (['APPROVED_ADMITTED', 'REJECTED'].includes(candidate.review_status)) {
      const state = await finalizeDiscovery(candidate.discovery_run_id);
      return json({ candidate, idempotent_replay: true, discovery_run_complete: state.completed });
    }

    if (decision === 'REJECT') {
      const updated = await db(`publisher_discovery_candidates?id=eq.${candidate.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ review_status: 'REJECTED', review_notes: reviewNotes, reviewed_at: new Date().toISOString() })
      });
      await recordReviewDecision(updated?.[0] ?? candidate, 'REJECT', null, reviewNotes);
      const state = await finalizeDiscovery(candidate.discovery_run_id);
      return json({ candidate: updated?.[0] ?? candidate, registry_admission: 'REJECTED', discovery_run_complete: state.completed });
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

    const admitted = (await db('publisher_registry', {
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
    }))[0];

    const updated = await db(`publisher_discovery_candidates?id=eq.${candidate.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ review_status: 'APPROVED_ADMITTED', review_notes: reviewNotes, reviewed_at: new Date().toISOString(), admitted_publisher_id: admitted.id })
    });

    await recordReviewDecision(updated?.[0] ?? candidate, 'APPROVE', admitted.id, reviewNotes);
    const state = await finalizeDiscovery(candidate.discovery_run_id);
    return json({ candidate: updated?.[0] ?? candidate, registry_admission: 'APPROVED', publisher_id: admitted.id, discovery_run_complete: state.completed });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});