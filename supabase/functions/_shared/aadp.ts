import { db, invoke, recordEvent, recordMetrics } from './command.ts';

export const AADP_TASK_TYPES = [
  'PUBLISHER_DISCOVERY','PUBLISHER_ACCESS_ASSESSMENT','PUBLISHER_REGISTRY_UPDATE','PUBLISHER_ASSIGNMENT_CREATE',
  'ACQUISITION_RUN_START','ACQUISITION_PAGE_FETCH','ACQUISITION_RECORD_STORE','ACQUISITION_RUN_CLOSE',
  'RECORD_NORMALIZATION','RECORD_DEDUPLICATION','RECORD_QUALIFICATION','QUALIFIED_RECORD_UPSERT',
  'REJECTION_RECORD_CREATE','DOCUMENT_DISCOVERY','DOCUMENT_RETRIEVAL','REQUIREMENT_EXTRACTION',
  'PROCUREMENT_LANGUAGE_ANALYSIS','AOIE_BATCH_REVIEW','MATCHING_RECOMMENDATION_CREATE',
  'MATCHING_RECOMMENDATION_TEST','RUN_RECONCILIATION','EXECUTIVE_REPORT_CREATE','PUBLISHER_ACCESS_REASSESSMENT',
  'TASK_RETRY','TASK_ESCALATION'
] as const;

export const AADP_V1_GRAPH = [
  'PUBLISHER_ASSIGNMENT_CREATE','ACQUISITION_RUN_START','ACQUISITION_PAGE_FETCH','ACQUISITION_RECORD_STORE',
  'ACQUISITION_RUN_CLOSE','RECORD_NORMALIZATION','RECORD_DEDUPLICATION','RECORD_QUALIFICATION',
  'QUALIFIED_RECORD_UPSERT','REJECTION_RECORD_CREATE','RUN_RECONCILIATION','AOIE_BATCH_REVIEW',
  'PROCUREMENT_LANGUAGE_ANALYSIS','MATCHING_RECOMMENDATION_CREATE','MATCHING_RECOMMENDATION_TEST',
  'EXECUTIVE_REPORT_CREATE'
] as const;

export type AadpTaskType = typeof AADP_TASK_TYPES[number];

export interface PublisherAssignmentInput {
  publisher_id: string;
  publisher_name: string;
  acquisition_method: string;
  search_endpoint?: string;
  search_parameters?: Record<string, unknown>;
  authorized_status_range?: string[];
  pagination_instructions?: Record<string, unknown>;
  attachment_instructions?: Record<string, unknown>;
  amendment_instructions?: Record<string, unknown>;
  expected_source_identifiers?: string[];
  qualification_ruleset_version: string;
  aoie_review_required?: boolean;
  execution_schedule?: string;
  retry_policy?: { max_attempts?: number; backoff_seconds?: number };
  runtime_limit_seconds?: number;
  reporting_requirements?: Record<string, unknown>;
}

export function validateAssignment(input: PublisherAssignmentInput) {
  const required = ['publisher_id','publisher_name','acquisition_method','qualification_ruleset_version'] as const;
  const missing = required.filter(key => !input[key]);
  if (missing.length) throw new Error(`Publisher assignment missing: ${missing.join(', ')}`);
  if (!input.search_endpoint && input.acquisition_method !== 'MANUAL') throw new Error('Non-manual acquisition requires search_endpoint');
  if ((input.runtime_limit_seconds ?? 3600) < 60) throw new Error('runtime_limit_seconds must be at least 60');
}

export async function createTaskGraph(runId: string) {
  const rows = AADP_V1_GRAPH.map((task_type, index) => ({
    run_id: runId,
    task_type,
    state: index === 0 ? 'READY' : 'BLOCKED',
    input_payload: { graph_version: 'AADP-1.0', sequence: index + 1 }
  }));
  const tasks = await db('command_tasks', { method: 'POST', body: JSON.stringify(rows) });
  const dependencies = tasks.slice(1).map((task: { id: string }, index: number) => ({
    task_id: task.id,
    depends_on_task_id: tasks[index].id
  }));
  if (dependencies.length) await db('command_task_dependencies', { method: 'POST', body: JSON.stringify(dependencies) });
  return tasks;
}

export async function completeTask(taskId: string, measurableResult: Record<string, unknown>, executionEvidence: Record<string, unknown>) {
  if (!Object.keys(measurableResult).length || !Object.keys(executionEvidence).length) throw new Error('Task completion requires measurable result and execution evidence');
  const tasks = await db(`command_tasks?id=eq.${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'COMPLETED', measurable_result: measurableResult, execution_evidence: executionEvidence, completed_at: new Date().toISOString() })
  });
  const dependents = await db(`command_task_dependencies?depends_on_task_id=eq.${taskId}&select=task_id`);
  for (const dependent of dependents) {
    const blockers = await db(`command_task_dependencies?task_id=eq.${dependent.task_id}&select=depends_on_task_id,command_tasks!command_task_dependencies_depends_on_task_id_fkey(state)`);
    if (blockers.every((item: any) => item.command_tasks?.state === 'COMPLETED')) {
      await db(`command_tasks?id=eq.${dependent.task_id}&state=eq.BLOCKED`, { method: 'PATCH', body: JSON.stringify({ state: 'READY' }) });
    }
  }
  return tasks[0];
}

export async function runAadpTask(runId: string, task: any, assignment: any) {
  const attemptNumber = Number(task.output_payload?.attempt_count ?? 0) + 1;
  await db('command_task_attempts', { method: 'POST', body: JSON.stringify({ task_id: task.id, attempt_number: attemptNumber, state: 'RUNNING' }) });
  await db(`command_tasks?id=eq.${task.id}`, { method: 'PATCH', body: JSON.stringify({ state: 'RUNNING', started_at: new Date().toISOString(), output_payload: { attempt_count: attemptNumber } }) });
  await recordEvent(runId, null, 'AADP_TASK_STARTED', `${task.task_type} started`, { task_id: task.id, attempt_number: attemptNumber });
  try {
    const result = await invoke('aadp-task-executor-v2', { run_id: runId, task_id: task.id, task_type: task.task_type, assignment });
    await completeTask(task.id, result.metrics ?? { processed: 1 }, result.evidence ?? result);
    await db(`command_task_attempts?task_id=eq.${task.id}&attempt_number=eq.${attemptNumber}`, { method: 'PATCH', body: JSON.stringify({ state: 'COMPLETED', completed_at: new Date().toISOString(), evidence: result.evidence ?? result }) });
    await recordMetrics(runId, null, result.metrics ?? {});
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const maxAttempts = Number(assignment.retry_policy?.max_attempts ?? 3);
    const retry = attemptNumber < maxAttempts;
    await db(`command_task_attempts?task_id=eq.${task.id}&attempt_number=eq.${attemptNumber}`, { method: 'PATCH', body: JSON.stringify({ state: retry ? 'RETRY_PENDING' : 'FAILED', completed_at: new Date().toISOString(), error_message: message }) });
    await db(`command_tasks?id=eq.${task.id}`, { method: 'PATCH', body: JSON.stringify({ state: retry ? 'RETRY_PENDING' : 'ESCALATED', output_payload: { attempt_count: attemptNumber, error: message } }) });
    await db('command_failures', { method: 'POST', body: JSON.stringify({ run_id: runId, failure_type: 'AADP_TASK_FAILURE', recoverable: retry, attempt_number: attemptNumber, error_message: message, evidence: { task_id: task.id, task_type: task.task_type } }) });
    await recordEvent(runId, null, retry ? 'AADP_TASK_RETRY_PENDING' : 'AADP_TASK_ESCALATED', message, { task_id: task.id });
    throw error;
  }
}

export async function reconcileAcquisition(acquisitionRunId: string) {
  const result = await db('rpc/aadp_reconcile_run', { method: 'POST', body: JSON.stringify({ p_acquisition_run_id: acquisitionRunId }) });
  return result;
}
