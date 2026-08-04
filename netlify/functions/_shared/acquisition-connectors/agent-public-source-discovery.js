import { createHash } from 'node:crypto';
import { env } from '../native-runtime.js';

const txt = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const arr = value => Array.isArray(value) ? value : [];
const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);

function outputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  for (const item of arr(data?.output)) {
    for (const part of arr(item?.content)) {
      if (part?.type === 'output_text' && typeof part.text === 'string') return part.text;
    }
  }
  return '';
}

function parseJson(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('Public-source acquisition agent returned invalid JSON.');
  }
}

function searchParameters(assignment) {
  return assignment?.search_parameters && typeof assignment.search_parameters === 'object'
    ? assignment.search_parameters
    : {};
}

function commandInstruction(assignment) {
  const parameters = searchParameters(assignment);
  return txt(
    parameters.acquisition_command_instruction
    || parameters.connection_config?.acquisition_command_instruction
    || parameters.acquisition_discovery_profile?.command_instruction
  );
}

function rootDomain(hostname) {
  const parts = txt(hostname).toLowerCase().split('.').filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('.') : parts.join('.');
}

function isOfficialUrl(value, endpoint) {
  try {
    const candidate = new URL(value);
    const source = new URL(endpoint);
    return candidate.protocol === 'https:' && rootDomain(candidate.hostname) === rootDomain(source.hostname);
  } catch { return false; }
}

function normalizeOpportunity(item, publisher, endpoint) {
  const title = txt(item?.title || item?.solicitation_title);
  const solicitationNumber = txt(item?.solicitation_number || item?.bid_number || item?.notice_id);
  const detailUrl = txt(item?.detail_url || item?.source_url || endpoint);
  const sourceUrl = isOfficialUrl(detailUrl, endpoint) ? detailUrl : endpoint;
  const sourceRecordId = txt(item?.source_record_id || solicitationNumber)
    || `PUBLIC-${hash(`${publisher?.id}:${title}:${txt(item?.due_date)}:${sourceUrl}`)}`;
  return {
    source_record_id: sourceRecordId,
    solicitation_number: solicitationNumber || null,
    title,
    description: txt(item?.description) || null,
    status: txt(item?.status || 'OPEN').toUpperCase(),
    posted_date: txt(item?.posted_date) || null,
    due_date: txt(item?.due_date) || null,
    issuing_organization: txt(item?.agency_name || publisher?.publisher_name) || null,
    department: txt(item?.department) || null,
    contact_name: txt(item?.contact_name) || null,
    contact_email: txt(item?.contact_email) || null,
    source_url: sourceUrl,
    detail_page_url: sourceUrl,
    listing_url: endpoint,
    document_urls: arr(item?.document_urls).map(txt).filter(Boolean),
    state_code: publisher?.state_code || null,
    county_name: publisher?.county_name || null,
    procurement_platform: txt(item?.procurement_platform || publisher?.configuration?.procurement_platform) || null,
    record_type: 'AGENT_VERIFIED_PUBLIC_SOLICITATION',
    official_source_verified: item?.official_source_verified === true && isOfficialUrl(sourceUrl, endpoint),
    __agent_discovery: {
      connector_key: 'AGENT_PUBLIC_SOURCE_DISCOVERY',
      instruction_version: 'MINIMUM_ACCESS-V1',
      public_source_only: true,
      no_authentication_used: true
    }
  };
}

async function runAgent({ endpoint, publisher, assignment, mode, limit }) {
  const apiKey = txt(env('OPENAI_API_KEY'));
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured for targeted acquisition discovery.');
  const instruction = commandInstruction(assignment);
  if (!instruction) throw new Error(`${publisher?.publisher_name || 'Publisher'} has no acquisition_command_instruction.`);
  const model = txt(env('OPENAI_ACQUISITION_DISCOVERY_MODEL') || env('OPENAI_DISCOVERY_MODEL') || 'gpt-5.6-terra');
  const prompt = `You are the APROPOS targeted acquisition discovery agent.\n\nPUBLISHER: ${publisher?.publisher_name}\nOFFICIAL TARGET URL: ${endpoint}\nMODE: ${mode}\nMAXIMUM RECORDS: ${limit}\n\nCUSTOM COMMAND INSTRUCTION:\n${instruction}\n\nMANDATORY CONTROLS:\n- Work only from the official target URL and official pages or documents directly linked from it.\n- Do not broaden into a general web search for this organization.\n- Do not log in, register, submit forms, bypass access controls, or use unofficial aggregators.\n- Return only current, open, publicly accessible procurement opportunities.\n- If no qualifying open opportunities are published, return an empty opportunities array.\n- Never invent identifiers, dates, contacts, documents, or opportunity status.\n- Keep no more than ${limit} records.\n\nReturn ONLY valid JSON using this exact shape:\n{"opportunities":[{"source_record_id":"","solicitation_number":"","title":"","description":"","status":"OPEN","posted_date":"","due_date":"","agency_name":"","department":"","contact_name":"","contact_email":"","detail_url":"https://official-source.example/","document_urls":["https://official-source.example/document.pdf"],"procurement_platform":"","official_source_verified":true}]}`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      reasoning: { effort: 'low' },
      tools: [{ type: 'web_search', search_context_size: 'low' }],
      tool_choice: 'required',
      max_tool_calls: 2,
      max_output_tokens: 5000,
      store: false,
      input: prompt
    }),
    signal: AbortSignal.timeout(120000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error?.message || `OpenAI targeted acquisition discovery failed (${response.status}).`;
    throw new Error(detail);
  }
  const parsed = parseJson(outputText(data));
  const raw = arr(parsed?.opportunities).slice(0, limit);
  const records = raw
    .map(item => normalizeOpportunity(item, publisher, endpoint))
    .filter(item => item.title && item.official_source_verified === true && ['OPEN', 'ACTIVE', 'POSTED'].includes(item.status));
  return { records, raw_count: raw.length, model };
}

async function checkEndpoint(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { 'User-Agent': 'APROPOS-Publisher-Engineering/1.0', Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: controller.signal
    });
    return { ok: response.ok, status: response.status, final_url: response.url || endpoint, content_type: response.headers.get('content-type') || null };
  } finally { clearTimeout(timeout); }
}

export const connector = {
  key: 'AGENT_PUBLIC_SOURCE_DISCOVERY',
  version: '1.0.0',
  publisherNames: [],
  hostnames: [],
  async verify({ endpoint, publisher, assignment, sampleSize = 5, onSample }) {
    const endpointReport = await checkEndpoint(endpoint);
    if (!endpointReport.ok) throw new Error(`Official target endpoint returned HTTP ${endpointReport.status}.`);
    const limit = Math.max(1, Math.min(Number(sampleSize || 5), 5));
    const result = await runAgent({ endpoint, publisher, assignment, mode: 'EAG-001 READ-ONLY VERIFICATION', limit });
    let passed = 0;
    for (let index = 0; index < result.records.length; index++) {
      passed += 1;
      if (onSample) await onSample({ processed: index + 1, total: result.records.length, passed });
    }
    const failures = Math.max(0, result.raw_count - result.records.length);
    return {
      connector_key: 'AGENT_PUBLIC_SOURCE_DISCOVERY',
      connector_version: '1.0.0',
      ready_for_acquisition: endpointReport.ok && failures === 0,
      endpoint_status: endpointReport.status,
      endpoint_final_url: endpointReport.final_url,
      endpoint_content_type: endpointReport.content_type,
      publisher_reported_total: null,
      records_parsed: result.records.length,
      sample_size: result.records.length,
      detail_pages_successful: passed,
      failures,
      pagination_status: 'NOT_APPLICABLE_TARGETED_DISCOVERY',
      execution_mode: 'TARGETED_AGENT_PUBLIC_SOURCE',
      access_controls_used: false,
      cost_controls: { max_tool_calls: 2, max_output_tokens: 5000, max_records: limit, search_context_size: 'low' },
      model: result.model
    };
  },
  async acquire({ endpoint, publisher, assignment, onPage }) {
    const parameters = searchParameters(assignment);
    const requested = Number(parameters.acquisition_discovery_profile?.maximum_records || 20);
    const limit = Math.max(1, Math.min(requested, 20));
    const result = await runAgent({ endpoint, publisher, assignment, mode: 'TARGETED OPEN-OPPORTUNITY ACQUISITION', limit });
    if (onPage) await onPage({ page: 1, totalPages: 1, totalReported: result.records.length });
    return {
      records: result.records,
      total_reported: result.records.length,
      pages_processed: 1,
      source_url: endpoint,
      reconciliation: { count_matches: true, targeted_agent_discovery: true, maximum_records: limit },
      diagnostics: { model: result.model, raw_count: result.raw_count, accepted_count: result.records.length }
    };
  }
};
