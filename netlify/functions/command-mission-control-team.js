import { handler as baseHandler } from './command-mission-control.js';
import { db } from './_shared/native-runtime.js';

const TEAM_VERSION = 'APIE-MULTI-AGENT-1.0';

const TEAMS = Object.freeze({
  ACQUISITION_DISCOVERY: {
    lead_agent: 'Acquisition Operations',
    team_label: 'APIE Acquisition Task Force',
    agents: [
      { key: 'MISSION_ORCHESTRATION', name: 'Mission Orchestration', responsibility: 'PostgreSQL queue creation, scope integrity, leases, heartbeats, retries and terminal state.' },
      { key: 'PUBLISHER_ACCESS', name: 'Publisher Access', responsibility: 'Publisher profile resolution, certified connector selection, adapter dispatch and source access.' },
      { key: 'ACQUISITION_OPERATIONS', name: 'Acquisition Operations', responsibility: 'Opportunity enumeration, detail acquisition and current-run source evidence.' },
      { key: 'NORMALIZATION_QUALIFICATION', name: 'Normalization & Qualification', responsibility: 'Authoritative jurisdiction normalization, qualification rules and canonical routing.' },
      { key: 'PERSISTENCE_RECONCILIATION', name: 'Persistence & Reconciliation', responsibility: 'Raw/canonical persistence counts, integrity checks, reconciliation and variance detection.' },
      { key: 'MISSION_QA', name: 'Mission QA', responsibility: 'Scope violations, anomalous results, failed checkpoints, quarantine and recovery evidence.' },
      { key: 'MISSION_REPORTING', name: 'Mission Reporting', responsibility: 'Diagnostic trace, last-confirmed checkpoint, evidence labels and final mission report.' }
    ]
  },
  PUBLISHER_DISCOVERY: {
    lead_agent: 'Publisher Expansion',
    team_label: 'APIE Publisher Discovery Task Force',
    agents: [
      { key: 'MISSION_ORCHESTRATION', name: 'Mission Orchestration', responsibility: 'Queue ownership, checkpoint continuation, lease and retry control.' },
      { key: 'PUBLISHER_RESEARCH', name: 'Publisher Research', responsibility: 'Official-source publisher discovery and public procurement-source identification.' },
      { key: 'PLATFORM_CLASSIFICATION', name: 'Platform Classification', responsibility: 'Access class, procurement platform, machine-to-machine capability and connector strategy.' },
      { key: 'ADMISSION_CONTROL', name: 'Publisher Admission', responsibility: 'Duplicate review, objective validation, publisher registry admission and READY assignment.' },
      { key: 'MISSION_QA', name: 'Mission QA', responsibility: 'Checkpoint completeness, zero-result detection, exceptions and recovery evidence.' },
      { key: 'MISSION_REPORTING', name: 'Mission Reporting', responsibility: 'Diagnostic trace and discovery/admission report.' }
    ]
  },
  VERIFY_PUBLISHER_CONNECTION: {
    lead_agent: 'Publisher Engineering',
    team_label: 'APIE Publisher Engineering Task Force',
    agents: [
      { key: 'MISSION_ORCHESTRATION', name: 'Mission Orchestration', responsibility: 'Run authorization, worker dispatch and evidence continuity.' },
      { key: 'PUBLISHER_ACCESS', name: 'Publisher Access', responsibility: 'Read-only source connection and endpoint validation.' },
      { key: 'CONNECTOR_QA', name: 'Connector QA', responsibility: 'EAG-001 evidence, sample validation and certification decision.' },
      { key: 'MISSION_REPORTING', name: 'Mission Reporting', responsibility: 'Connection-verification diagnostic report.' }
    ]
  },
  CONTRACT_PACKAGE_ACQUISITION: {
    lead_agent: 'AADP Package Acquisition',
    team_label: 'APIE Contract Package Task Force',
    agents: [
      { key: 'MISSION_ORCHESTRATION', name: 'Mission Orchestration', responsibility: 'Queue, checkpoint and retry control.' },
      { key: 'PACKAGE_ACQUISITION', name: 'Package Acquisition', responsibility: 'Official attachment enumeration and retrieval.' },
      { key: 'DOCUMENT_PERSISTENCE', name: 'Document Persistence', responsibility: 'Immediate storage, hashes, metadata and package manifest integrity.' },
      { key: 'PACKAGE_QA', name: 'Package QA', responsibility: 'Completeness reconciliation, failed-document quarantine and readiness.' },
      { key: 'MISSION_REPORTING', name: 'Mission Reporting', responsibility: 'Package acquisition evidence and final report.' }
    ]
  }
});

const DEFAULT_RESEARCH_TEAM = Object.freeze({
  lead_agent: 'Research Operations',
  team_label: 'APIE Research Task Force',
  agents: [
    { key: 'MISSION_ORCHESTRATION', name: 'Mission Orchestration', responsibility: 'Run authorization, execution state and recovery control.' },
    { key: 'RESEARCH_EXECUTION', name: 'Research Execution', responsibility: 'Mission-specific discovery and evidence collection.' },
    { key: 'MISSION_QA', name: 'Mission QA', responsibility: 'Evidence sufficiency, exception review and outcome validation.' },
    { key: 'MISSION_REPORTING', name: 'Mission Reporting', responsibility: 'Diagnostic trace and mission report.' }
  ]
});

function teamFor(missionType) {
  const team = TEAMS[String(missionType || '').toUpperCase()] || DEFAULT_RESEARCH_TEAM;
  return {
    version: TEAM_VERSION,
    model: 'POSTGRES_CHECKPOINTED_STAGE_OWNERSHIP',
    exchange_medium: 'SUPABASE_POSTGRES',
    concurrency_policy: 'SERIAL_STAGE_OWNERSHIP_UNLESS_EXPLICITLY_PARALLELIZED',
    ...team,
    agent_count: team.agents.length
  };
}

async function patchRun(run, missionType) {
  if (!run?.id) return;
  const team = teamFor(missionType || run.mission_type_key);
  const executionEvidence = run.execution_evidence && typeof run.execution_evidence === 'object' ? run.execution_evidence : {};
  await db(`command_runs?id=eq.${encodeURIComponent(run.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      execution_evidence: {
        ...executionEvidence,
        execution_team: team,
        multi_agent_model: true,
        execution_team_version: TEAM_VERSION
      }
    })
  });

  const missions = await db(`command_missions?command_run_id=eq.${encodeURIComponent(run.id)}&select=id,mission_config&order=created_at.desc&limit=1`).catch(() => []);
  const mission = missions?.[0];
  if (mission?.id) {
    const missionConfig = mission.mission_config && typeof mission.mission_config === 'object' ? mission.mission_config : {};
    await db(`command_missions?id=eq.${encodeURIComponent(mission.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        mission_config: {
          ...missionConfig,
          execution_team: team,
          multi_agent_model: true,
          execution_team_version: TEAM_VERSION
        }
      })
    });
  }
}

export const handler = async event => {
  const result = await baseHandler(event);
  if (Number(result?.statusCode || 500) < 200 || Number(result?.statusCode || 500) >= 300) return result;

  let payload = {};
  try { payload = result?.body ? JSON.parse(result.body) : {}; } catch { return result; }
  const missionType = String(payload?.run?.mission_type_key || payload?.mission?.mission_type_key || '').toUpperCase();
  const runs = Array.isArray(payload?.runs) && payload.runs.length ? payload.runs : payload?.run ? [payload.run] : [];

  await Promise.all(runs.map(run => patchRun(run, missionType || run?.mission_type_key)));
  const team = teamFor(missionType || runs?.[0]?.mission_type_key);

  return {
    ...result,
    body: JSON.stringify({
      ...payload,
      execution_team: team,
      execution: {
        ...(payload.execution || {}),
        multi_agent_model: true,
        execution_team_version: TEAM_VERSION,
        execution_team: team
      }
    })
  };
};
