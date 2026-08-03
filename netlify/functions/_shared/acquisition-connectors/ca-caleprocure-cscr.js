const GUEST_SEARCH_URLS = Object.freeze([
  'https://caleprocure.ca.gov/psc/psfpd1/SUPPLIER/ERP/c/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?NoCrumbs=yes&PortalRegistryName=SUPPLIER&pslnkid=EP_SCP_AUC_RESP_INQ_AUC',
  'https://caleprocure.ca.gov/psc/psfpd1_2/SUPPLIER/ERP/c/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?EOPP.SCFName=EP_SCP_BIDDINGEVENTS&EOPP.SCLabel=My+Bidding+Events&EOPP.SCName=EP_SCP_SUPPLIER_PORTAL&EOPP.SCNode=ERP&EOPP.SCPTfname=EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&FolderPath=PORTAL_ROOT_OBJECT.EP_SCP_SUPPLIER_PORTAL.EP_SCP_BIDDINGEVENTS.EP_SCP_AUC_RESP_INQ_AUC&IsFolder=false&NoCrumbs=yes&PORTALPARAM_PTCNAV=EP_SCP_AUC_RESP_INQ_AUC&PortalRegistryName=SUPPLIER&pslnkid=EP_SCP_AUC_RESP_INQ_AUC'
]);
const DEFAULT_SEARCH_URL = GUEST_SEARCH_URLS[0];

const txt = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const strip = value => txt(String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));

function decodeHtml(value) {
  return strip(String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>'));
}

function absoluteUrl(href, base) {
  try { return new URL(href, base).toString().replace(/#.*$/, ''); }
  catch { return null; }
}

function buildRelayDetailUrl(businessUnit, eventId) {
  const unit = txt(businessUnit), id = txt(eventId);
  if (!unit || !id) return null;
  const url = new URL('https://caleprocure.ca.gov/PSRelay/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL');
  url.searchParams.set('Page', 'AUC_RESP_INQ_AUC');
  url.searchParams.set('Action', 'U');
  url.searchParams.set('BUSINESS_UNIT', unit);
  url.searchParams.set('AUC_ID', id);
  return url.toString();
}

function parseReportedTotal(html) {
  const text = decodeHtml(html);
  const match = text.match(/\b1\s*-\s*[\d,]+\s+of\s+([\d,]+)\b/i) || text.match(/\bof\s+([\d,]+)\s+(?:rows?|results?|events?)\b/i);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function cellLinks(cell, base) {
  const links = [];
  for (const match of String(cell || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const url = absoluteUrl(match[1], base);
    if (url) links.push(url);
  }
  return links;
}

function normalizeEndDate(value) {
  const text = txt(value);
  if (!text) return null;
  const match = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*(?:AM|PM))\s*([A-Z]{2,4})?/i);
  return match ? `${match[1]} ${match[2]}${match[3] ? ` ${match[3]}` : ''}` : text;
}

export function parseCalEProcureRows(html, pageUrl = DEFAULT_SEARCH_URL) {
  const rows = String(html || '').match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const records = [], seen = new Set();
  for (const row of rows) {
    const cells = row.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) || [];
    if (cells.length < 8) continue;
    const values = cells.map(decodeHtml);
    const eventIndex = values.findIndex((value, index) => index >= 1 && /^(?:\d{6,10}|[A-Z0-9][A-Z0-9._-]{4,30})$/i.test(value));
    if (eventIndex < 0 || eventIndex + 5 >= values.length) continue;
    const department = values[eventIndex - 2] || null;
    const departmentName = values[eventIndex - 1] || null;
    const eventId = values[eventIndex];
    const eventName = values[eventIndex + 1] || null;
    const format = values[eventIndex + 2] || null;
    const type = values[eventIndex + 3] || null;
    const endDate = normalizeEndDate(values[eventIndex + 4]);
    const status = values[eventIndex + 5] || null;
    const buyerName = values[eventIndex + 6] || null;
    const buyerEmail = values.slice(eventIndex + 7).find(value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) || null;
    if (!eventName || !/posted|open/i.test(status || '')) continue;
    const linkedDetailUrl = cells.flatMap(cell => cellLinks(cell, pageUrl)).find(url => /AUC_RESP_INQ_DTL|PSRelay\/AUC_MANAGE_BIDS|AUC_ID=/i.test(url)) || null;
    const detailUrl = linkedDetailUrl || buildRelayDetailUrl(department, eventId);
    if (!detailUrl) continue;
    const key = `${department || ''}|${eventId}`.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({
      source_record_id: key, solicitation_number: eventId, event_id: eventId, title: eventName,
      solicitation_type: type, procurement_format: format, department_code: department,
      department: departmentName || department, issuing_organization: departmentName || 'State of California',
      buyer_name: buyerName, contact_name: buyerName, contact_email: buyerEmail,
      close_date_text: endDate, response_deadline: endDate, status: 'OPEN', source_url: detailUrl,
      listing_url: pageUrl, state_code: 'CA', procurement_platform: 'Cal eProcure / California State Contracts Register',
      record_type: 'SOLICITATION_LISTING', requirements: eventName ? { summary: eventName, source: 'official_cscr_listing' } : null,
      __connector_evidence: { connector: 'CA_CALEPROCURE_CSCR', detail_url_resolved: true, detail_url_strategy: linkedDetailUrl ? 'PUBLISHED_DETAIL_LINK' : 'PSRELAY_BUSINESS_UNIT_EVENT_ID', public_guest_search: true }
    });
  }
  return records;
}

function mergeCookies(session, response) {
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  if (!setCookies.length) return;
  const jar = new Map((session.cookie || '').split(/;\s*/).filter(Boolean).map(item => {
    const index = item.indexOf('=');
    return [item.slice(0, index), item.slice(index + 1)];
  }));
  for (const raw of setCookies) {
    const first = String(raw).split(';', 1)[0];
    const index = first.indexOf('=');
    if (index > 0) jar.set(first.slice(0, index), first.slice(index + 1));
  }
  session.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
}

async function fetchPage(url, timeoutMs = 45000, session = {}, referer = 'https://caleprocure.ca.gov/') {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const started = Date.now();
    const headers = {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      Referer: referer,
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Upgrade-Insecure-Requests': '1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
    };
    if (session.cookie) headers.Cookie = session.cookie;
    const response = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    mergeCookies(session, response);
    const html = await response.text();
    return { html, finalUrl: response.url || url, responseMs: Date.now() - started, status: response.status, ok: response.ok };
  } finally { clearTimeout(timer); }
}

function approvedEndpoint(endpoint) {
  const value = txt(endpoint);
  if (!value || !/caleprocure\.ca\.gov/i.test(value)) return null;
  if (!/AUC_RESP_INQ_AUC\.GBL/i.test(value)) return null;
  if (/psfpd1_1\//i.test(value)) return null;
  return value;
}

async function acquireCore(endpoint, timeoutMs) {
  const session = {};
  const candidates = [...new Set([...GUEST_SEARCH_URLS, approvedEndpoint(endpoint)].filter(Boolean))];
  const attempts = [];
  for (const startUrl of candidates) {
    const result = await fetchPage(startUrl, timeoutMs, session);
    const records = result.ok ? parseCalEProcureRows(result.html, result.finalUrl) : [];
    const totalReported = result.ok ? parseReportedTotal(result.html) : null;
    attempts.push({ url: startUrl, status: result.status, records: records.length, final_url: result.finalUrl });
    if (!result.ok || !records.length) continue;
    if (records.some(record => record.source_url === result.finalUrl || !/AUC_ID=/i.test(record.source_url))) continue;
    return { result, records, totalReported, session, attempts };
  }
  const summary = attempts.map(item => `${item.status}:${item.records}:${item.url}`).join(' | ');
  throw new Error(`Cal eProcure guest search did not return structured contract records. Attempts: ${summary}`);
}

export const connector = Object.freeze({
  key: 'CA_CALEPROCURE_CSCR', version: '1.3.0',
  publisherNames: ['State of California — California State Contracts Register (CSCR) / Cal eProcure','State of California — California State Contracts Register (Cal eProcure)','California State Contracts Register (CSCR)','Cal eProcure'],
  hostnames: ['caleprocure.ca.gov'],

  async verify({ endpoint, sampleSize = 10, timeoutMs = 45000, onSample }) {
    const started = Date.now();
    const { result, records, totalReported, session, attempts } = await acquireCore(endpoint, timeoutMs);
    const sample = records.slice(0, Math.max(1, Math.min(Number(sampleSize) || 10, 20)));
    const checks = [];
    for (let i = 0; i < sample.length; i++) {
      const record = sample[i];
      try {
        const detail = await fetchPage(record.source_url, timeoutMs, session, result.finalUrl);
        if (!detail.ok) throw new Error(`HTTP ${detail.status}`);
        const text = decodeHtml(detail.html);
        const eventPresent = text.includes(record.event_id) || detail.finalUrl.includes(encodeURIComponent(record.event_id));
        const detailSpecific = /AUC_RESP_INQ_DTL|AUC_ID=/i.test(detail.finalUrl) || eventPresent;
        const requirements = text.length > 500 && /description|event details|scope|specification|bid factor|line item/i.test(text);
        const contact = Boolean(record.contact_email) || /contact|buyer|email|phone/i.test(text);
        const attachments = /attachment|event package|bid package|file name|download/i.test(text);
        const passed = Boolean(detailSpecific && eventPresent && requirements && contact);
        checks.push({ event_id: record.event_id, department: record.department_code, title: record.title, detail_url: record.source_url, final_url: detail.finalUrl, http_status: detail.status, response_ms: detail.responseMs, event_present: eventPresent, detail_specific: detailSpecific, requirements_found: requirements, contact_found: contact, attachments_found: attachments, passed });
      } catch (error) {
        checks.push({ event_id: record.event_id, department: record.department_code, title: record.title, detail_url: record.source_url, passed: false, error: error instanceof Error ? error.message : String(error) });
      }
      await onSample?.({ processed: i + 1, total: sample.length, passed: checks.filter(item => item.passed).length });
    }
    const passed = checks.filter(item => item.passed).length;
    const criticalPass = records.length > 0 && sample.length > 0 && passed === sample.length;
    return {
      gate: 'EAG-001', connector_key: this.key, connector_version: this.version, verified_at: new Date().toISOString(),
      connection: 'PASS', source_url: result.finalUrl, endpoint_attempts: attempts, publisher_reported_total: totalReported,
      records_parsed: records.length, structured_records: true, search_response_ms: result.responseMs,
      sample_size: sample.length, detail_pages_successful: passed,
      requirements_successful: checks.filter(item => item.requirements_found).length,
      contacts_successful: checks.filter(item => item.contact_found).length,
      attachments_detected: checks.filter(item => item.attachments_found).length,
      failures: checks.filter(item => !item.passed).length, pagination_status: totalReported == null || records.length === totalReported ? 'PASS' : 'REQUIRES_STATEFUL_PAGINATION',
      certification_status: criticalPass ? 'CERTIFIED' : 'TESTING', ready_for_acquisition: criticalPass, elapsed_ms: Date.now() - started, sample_results: checks
    };
  },

  async acquire({ endpoint, onPage, timeoutMs = 45000 }) {
    const { result, records, totalReported, attempts } = await acquireCore(endpoint, timeoutMs);
    await onPage?.({ page: 1, totalPages: 1, totalReported, records: records.length });
    return { connector_key: this.key, connector_version: this.version, source_url: result.finalUrl, endpoint_attempts: attempts, total_reported: totalReported, pages_processed: 1, records, reconciliation: { unique_records: records.length, total_reported: totalReported, count_matches: totalReported == null ? null : records.length === totalReported } };
  }
});
