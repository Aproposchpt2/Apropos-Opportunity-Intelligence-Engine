import { corsHeaders, db, invoke, json, parseBody } from '../_shared/command.ts';

type JsonRecord = Record<string, unknown>;
const now = () => new Date().toISOString();
const asRecord = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : value == null ? '' : String(value);

async function acquisitionRun(runId: string): Promise<JsonRecord> {
  const rows = await db(`acquisition_runs?command_run_id=eq.${runId}&select=*&order=created_at.desc&limit=1`);
  if (!rows?.[0]) throw new Error('Acquisition run has not been initialized');
  return rows[0];
}

function embedDetailUrl(row: JsonRecord): string {
  const raw = asRecord(row.raw_payload);
  const platformId = text(raw.platform_project_id);
  if (platformId) return `https://procurement.opengov.com/portal/embed/tucson-az/projects/${platformId}`;
  const original = text(row.source_url);
  return original.includes('/portal/embed/') ? original : original.replace('/portal/', '/portal/embed/');
}

async function handleDetail(body: JsonRecord) {
  const run = await acquisitionRun(text(body.run_id));
  const rows = await db(`acquisition_raw_records?acquisition_run_id=eq.${run.id}&is_current_version=eq.true&select=*`);
  let retrieved = 0;
  let failed = 0;
  const failures: JsonRecord[] = [];

  for (const row of rows) {
    const detailUrl = embedDetailUrl(row);
    try {
      const response = await fetch(detailUrl, {
        redirect: 'follow',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Mozilla/5.0 (compatible; APROPOS-PDAS/1.0; public procurement retrieval)'
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const detail = await response.text();
      if (!detail || detail.length < 500) throw new Error('OpenGov detail response was unexpectedly empty');
      const raw = asRecord(row.raw_payload);
      await db(`acquisition_raw_records?id=eq.${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          source_url: detailUrl,
          raw_payload: {
            ...raw,
            official_source_url: detailUrl,
            source_url: detailUrl,
            __aadp_detail: detail,
            __aadp_detail_url: detailUrl,
            __aadp_detail_retrieved_at: now()
          },
          detail_retrieved_at: now(),
          detail_retrieval_status: 'SUCCESS',
          detail_retrieval_error: null
        })
      });
      retrieved += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ source_record_id: row.source_record_id, detail_url: detailUrl, error: message });
      failed += 1;
      await db(`acquisition_raw_records?id=eq.${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ detail_retrieval_status: 'FAILED', detail_retrieval_error: message })
      });
    }
  }

  if (rows.length > 0 && retrieved === 0) throw new Error(`OpenGov detail retrieval failed for all ${rows.length} records`);
  return {
    success: true,
    task_type: 'PROJECT_DETAIL_RETRIEVAL',
    metrics: { detail_records_retrieved: retrieved, detail_retrieval_failures: failed },
    evidence: {
      acquisition_run_id: run.id,
      adapter: 'OPENGOV_PUBLIC_PORTAL_V3_EMBED_DETAIL',
      embed_route: true,
      failures: failures.slice(0, 10)
    }
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = asRecord(await parseBody(request));
    if (text(body.task_type) === 'PROJECT_DETAIL_RETRIEVAL') return json(await handleDetail(body));
    return json(await invoke('aadp-publisher-adapter-core', body));
  } catch (error) {
    return json({ success: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});