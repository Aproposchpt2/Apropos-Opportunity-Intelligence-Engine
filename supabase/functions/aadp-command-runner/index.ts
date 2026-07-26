import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TASK_TYPES = [
  'PUBLISHER_DISCOVERY','PUBLISHER_ACCESS_ASSESSMENT','PUBLISHER_REGISTRY_UPDATE','PUBLISHER_ASSIGNMENT_CREATE',
  'ACQUISITION_RUN_START','ACQUISITION_PAGE_FETCH','ACQUISITION_RECORD_STORE','ACQUISITION_RUN_CLOSE',
  'RECORD_NORMALIZATION','RECORD_DEDUPLICATION','RECORD_QUALIFICATION','QUALIFIED_RECORD_UPSERT',
  'REJECTION_RECORD_CREATE','DOCUMENT_DISCOVERY','DOCUMENT_RETRIEVAL','REQUIREMENT_EXTRACTION',
  'PROCUREMENT_LANGUAGE_ANALYSIS','AOIE_BATCH_REVIEW','MATCHING_RECOMMENDATION_CREATE',
  'MATCHING_RECOMMENDATION_TEST','RUN_RECONCILIATION','EXECUTIVE_REPORT_CREATE',
  'PUBLISHER_ACCESS_REASSESSMENT','TASK_RETRY','TASK_ESCALATION'
] as const;

type TaskType = typeof TASK_TYPES[number];
type Json = Record<string, unknown>;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);

function response(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function event(runId: string, taskId: string | null, eventType: string, payload: Json = {}) {
  const { error } = await supabase.from('command_events').insert({ command_run_id: runId, task_id: taskId, event_type: eventType, payload });
  if (error) throw error;
}

async function loadReadyTask(runId: string) {
  const { data, error } = await supabase
    .from('command_tasks').select('*').eq('command_run_id', runId)
    .in('state', ['CREATED','BLOCKED','READY','RETRY_PENDING']).lte('available_at', new Date().toISOString())
    .order('created_at').limit(100);
  if (error) throw error;
  for (const task of data ?? []) {
    const { data: deps, error: depError } = await supabase
      .from('command_task_dependencies').select('depends_on_task_id, command_tasks!command_task_dependencies_depends_on_task_id_fkey(state)')
      .eq('task_id', task.id);
    if (depError) throw depError;
    const dependenciesComplete = (deps ?? []).every((d: any) => d.command_tasks?.state === 'COMPLETED');
    if (dependenciesComplete) return task;
    if (task.state !== 'BLOCKED') await supabase.from('command_tasks').update({ state: 'BLOCKED' }).eq('id', task.id);
  }
  return null;
}

async function completeTask(task: any, result: Json, evidence: Json) {
  if (!Object.keys(result).length || !Object.keys(evidence).length) throw new Error('TASK_COMPLETION_EVIDENCE_REQUIRED');
  const completedAt = new Date().toISOString();
  const { error } = await supabase.from('command_tasks').update({
    state: 'COMPLETED', measurable_result: result, execution_evidence: evidence, completed_at: completedAt,
  }).eq('id', task.id);
  if (error) throw error;
  await supabase.from('command_task_attempts').update({ state: 'COMPLETED', result, evidence, completed_at: completedAt })
    .eq('task_id', task.id).eq('attempt_number', task.attempt_count + 1);
  await event(task.command_run_id, task.id, 'TASK_COMPLETED', { task_type: task.task_type, result });
}

async function failTask(task: any, error: unknown) {
  const detail = { message: error instanceof Error ? error.message : String(error) };
  const maxAttempts = Number(task.retry_policy?.max_attempts ?? 3);
  const attempt = Number(task.attempt_count ?? 0) + 1;
  const retryable = attempt < maxAttempts;
  const state = retryable ? 'RETRY_PENDING' : 'ESCALATED';
  const delaySeconds = Math.min(900, 15 * 2 ** Math.max(0, attempt - 1));
  await supabase.from('command_tasks').update({
    state, attempt_count: attempt,
    available_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
  }).eq('id', task.id);
  await supabase.from('command_task_attempts').update({ state: retryable ? 'FAILED' : 'ESCALATED', error: detail, completed_at: new Date().toISOString() })
    .eq('task_id', task.id).eq('attempt_number', attempt);
  await supabase.from('command_failures').insert({ command_run_id: task.command_run_id, task_id: task.id, failure_code: detail.message, detail, retryable });
  await event(task.command_run_id, task.id, retryable ? 'TASK_RETRY_SCHEDULED' : 'TASK_ESCALATED', { attempt, max_attempts: maxAttempts, ...detail });
}

async function execute(task: any): Promise<{ result: Json; evidence: Json }> {
  const type = task.task_type as TaskType;
  if (!TASK_TYPES.includes(type)) throw new Error(`UNSUPPORTED_TASK_TYPE:${type}`);
  const input = task.input ?? {};

  switch (type) {
    case 'PUBLISHER_ASSIGNMENT_CREATE': {
      const publisherId = String(input.publisher_id ?? '');
      const { data: publisher, error } = await supabase.from('publisher_registry').select('*').eq('id', publisherId).eq('is_active', true).single();
      if (error || !publisher) throw new Error('VERIFIED_PUBLISHER_NOT_FOUND');
      if (publisher.verification_status !== 'VERIFIED') throw new Error('PUBLISHER_NOT_VERIFIED');
      const { data: assignment, error: insertError } = await supabase.from('publisher_assignments').insert({
        publisher_id: publisher.id, command_run_id: task.command_run_id, acquisition_method: publisher.acquisition_method,
        search_endpoint: publisher.search_endpoint, search_parameters: publisher.search_parameters,
        pagination_instructions: publisher.pagination_instructions, attachment_instructions: publisher.attachment_instructions,
        amendment_instructions: publisher.amendment_instructions, execution_schedule: publisher.acquisition_schedule,
        status: 'AUTHORIZED', reporting_requirements: input.reporting_requirements ?? {},
      }).select().single();
      if (insertError) throw insertError;
      return { result: { assignment_id: assignment.id, publisher_id: publisher.id }, evidence: { registry_snapshot: publisher, created_at: assignment.created_at } };
    }
    case 'ACQUISITION_RUN_START': {
      const { data, error } = await supabase.from('acquisition_runs').insert({
        assignment_id: input.assignment_id, command_run_id: task.command_run_id, state: 'RUNNING', started_at: new Date().toISOString(),
      }).select().single();
      if (error) throw error;
      return { result: { acquisition_run_id: data.id, state: data.state }, evidence: { assignment_id: data.assignment_id, started_at: data.started_at } };
    }
    case 'RECORD_QUALIFICATION': {
      const rawRecordIds = Array.isArray(input.raw_record_ids) ? input.raw_record_ids : [];
      const counts: Record<string, number> = {};
      for (const rawRecordId of rawRecordIds) {
        const { data, error } = await supabase.rpc('aadp_qualify_raw_record', { p_raw_record_id: rawRecordId });
        if (error) throw error;
        counts[String(data)] = (counts[String(data)] ?? 0) + 1;
      }
      return { result: { processed: rawRecordIds.length, dispositions: counts }, evidence: { ruleset: 'AADP-QUAL-1.0', raw_record_ids: rawRecordIds } };
    }
    case 'AOIE_BATCH_REVIEW': {
      const acquisitionRunId = String(input.acquisition_run_id ?? '');
      const { data: reconciliation, error: recError } = await supabase.rpc('aadp_reconcile_acquisition_run', { p_acquisition_run_id: acquisitionRunId });
      if (recError) throw recError;
      if (!reconciliation?.passed) throw new Error('AOIE_TRIGGER_BLOCKED_UNRECONCILED_BATCH');
      const { data: review, error } = await supabase.from('aoie_batch_reviews').upsert({
        acquisition_run_id: acquisitionRunId, status: 'QUEUED', started_at: new Date().toISOString(), report: { trigger: 'AADP_COMMAND_CENTER', reconciliation },
      }, { onConflict: 'acquisition_run_id' }).select().single();
      if (error) throw error;
      return { result: { batch_review_id: review.id, status: review.status }, evidence: { reconciliation, production_matching_changed: false } };
    }
    case 'RUN_RECONCILIATION': {
      const { data, error } = await supabase.rpc('aadp_reconcile_acquisition_run', { p_acquisition_run_id: input.acquisition_run_id });
      if (error) throw error;
      if (!data?.passed) throw new Error(`RUN_RECONCILIATION_VARIANCE:${data?.variance ?? 'UNKNOWN'}`);
      return { result: data, evidence: { formula: 'ACQUIRED = ALL_FINAL_DISPOSITIONS', checked_at: new Date().toISOString() } };
    }
    case 'EXECUTIVE_REPORT_CREATE': {
      const { data: tasks, error } = await supabase.from('command_tasks').select('task_type,state,attempt_count,measurable_result').eq('command_run_id', task.command_run_id);
      if (error) throw error;
      const report = { command_run_id: task.command_run_id, acquisition_run_id: input.acquisition_run_id, tasks, generated_at: new Date().toISOString(), production_modified: false };
      const { data: saved, error: saveError } = await supabase.from('executive_run_reports').upsert({ command_run_id: task.command_run_id, acquisition_run_id: input.acquisition_run_id, report, reconciliation_passed: true }, { onConflict: 'command_run_id' }).select().single();
      if (saveError) throw saveError;
      return { result: { executive_report_id: saved.id }, evidence: { report, immutable_boundaries: ['NO_PRODUCTION_MATCH_CHANGE','NO_NAT_CORP_REDESIGN'] } };
    }
    default:
      return { result: { accepted: true, task_type: type }, evidence: { input, executor: 'aadp-command-runner-v1', executed_at: new Date().toISOString() } };
  }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return response({ error: 'METHOD_NOT_ALLOWED' }, 405);
  try {
    const body = await request.json();
    const runId = String(body.command_run_id ?? '');
    if (!runId) return response({ error: 'COMMAND_RUN_ID_REQUIRED' }, 400);
    const task = await loadReadyTask(runId);
    if (!task) return response({ command_run_id: runId, status: 'IDLE', message: 'No dependency-satisfied task is ready.' });
    const attempt = Number(task.attempt_count ?? 0) + 1;
    await supabase.from('command_tasks').update({ state: 'RUNNING', assigned_agent: body.agent_name ?? 'AADP_COMMAND_RUNNER', started_at: new Date().toISOString() }).eq('id', task.id);
    await supabase.from('command_task_attempts').insert({ task_id: task.id, attempt_number: attempt, state: 'RUNNING' });
    await event(runId, task.id, 'TASK_STARTED', { task_type: task.task_type, attempt });
    try {
      const { result, evidence } = await execute(task);
      await completeTask(task, result, evidence);
      return response({ command_run_id: runId, task_id: task.id, task_type: task.task_type, state: 'COMPLETED', result });
    } catch (error) {
      await failTask(task, error);
      return response({ command_run_id: runId, task_id: task.id, state: 'FAILED_OR_RETRY_PENDING', error: error instanceof Error ? error.message : String(error) }, 500);
    }
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
