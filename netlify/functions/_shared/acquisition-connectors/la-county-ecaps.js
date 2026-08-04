const BASE_URL = 'https://camisvr.co.la.ca.us/LACoBids/BidLookUp/OpenBidList';
const DETAIL_URL = 'https://camisvr.co.la.ca.us/LACoBids/BidLookUp/BidDetail';

const txt = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function decodeHtml(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function detailUrlFor(solicitationNumber) {
  const url = new URL(DETAIL_URL);
  url.searchParams.set('BidNumber', solicitationNumber);
  return url.toString();
}

function parseTotal(html) {
  const match = String(html || '').match(/Showing\s+\d+\s+to\s+\d+\s+of\s+total\s+(\d+)\s+records/i);
  return match ? Number(match[1]) : null;
}

function parsePageCount(html, total, pageSize) {
  const match = String(html || '').match(/Page\s+\d+\s+of\s+(\d+)/i);
  if (match) return Number(match[1]);
  return total ? Math.ceil(total / pageSize) : 1;
}

function parseRows(html, pageUrl) {
  const rows = String(html || '').match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const records = [];

  for (const row of rows) {
    const cells = row.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) || [];
    if (cells.length < 5) continue;

    const solicitationNumber = decodeHtml(cells[0]);
    if (!solicitationNumber || /solicitation\s*number/i.test(solicitationNumber)) continue;

    const titleCellText = decodeHtml(cells[1]);
    const commodityMatch = titleCellText.match(/Commodity:\s*(.+)$/i);
    const commodity = commodityMatch ? txt(commodityMatch[1]) : null;
    const title = txt(titleCellText.replace(/\bMore\b/gi, ' ').replace(/Commodity:\s*[\s\S]*$/i, ' '));
    if (!title) continue;

    records.push({
      source_record_id: solicitationNumber,
      solicitation_number: solicitationNumber,
      title,
      solicitation_type: decodeHtml(cells[2]) || null,
      department: decodeHtml(cells[3]) || null,
      commodity,
      close_date_text: decodeHtml(cells[4]) || null,
      continuous: /^continuous$/i.test(decodeHtml(cells[4]) || ''),
      status: 'OPEN',
      source_url: detailUrlFor(solicitationNumber),
      detail_page_url: detailUrlFor(solicitationNumber),
      listing_url: pageUrl,
      issuing_organization: 'County of Los Angeles',
      state_code: 'CA',
      procurement_platform: 'Los Angeles County eCAPS',
      record_type: 'SOLICITATION_LISTING',
      __detail_resolution: { method: 'BID_NUMBER_QUERY', endpoint: DETAIL_URL }
    });
  }
  return records;
}

async function fetchPage(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const startedAt = Date.now();
    const response = await fetch(url, {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'APROPOS-APIE-LA-County-Connector/1.2', 'Cache-Control': 'no-cache' },
      redirect: 'follow', signal: controller.signal
    });
    if (!response.ok) throw new Error(`LA County page request failed with HTTP ${response.status}`);
    return {
      html: await response.text(),
      finalUrl: response.url || url,
      status: response.status,
      contentType: response.headers.get('content-type') || null,
      responseMs: Date.now() - startedAt
    };
  } finally { clearTimeout(timer); }
}

function pageUrl(page, pageSize) {
  const url = new URL(BASE_URL);
  url.searchParams.set('DirectionSort', 'Asc');
  url.searchParams.set('FieldSort', 'BidTitle');
  url.searchParams.set('PageSize', String(pageSize));
  url.searchParams.set('TextSearch', '|||');
  url.searchParams.set('page', String(page));
  return url.toString();
}

async function verifyDetail(record, timeoutMs) {
  const result = await fetchPage(record.detail_page_url, timeoutMs);
  const body = decodeHtml(result.html);
  const solicitationNumber = txt(record.solicitation_number);
  const numberPresent = Boolean(solicitationNumber) && (
    body.toLowerCase().includes(solicitationNumber.toLowerCase())
    || result.finalUrl.toLowerCase().includes(encodeURIComponent(solicitationNumber).toLowerCase())
  );
  const detailSpecific = /\/BidLookUp\/BidDetail/i.test(result.finalUrl) || numberPresent;
  const requirementsFound = /description|scope of work|statement of work|specification|requirements?|commodity|service|deliverables?/i.test(body);
  const contactFound = /contact|buyer|procurement|department|email|phone/i.test(body);
  const attachmentsFound = /attachment|download|addendum|bid package|\.pdf|\.docx?|\.xlsx?/i.test(result.html);
  return {
    solicitation_number: solicitationNumber,
    title: record.title,
    detail_url: record.detail_page_url,
    final_url: result.finalUrl,
    http_status: result.status,
    response_ms: result.responseMs,
    solicitation_number_present: numberPresent,
    detail_specific: detailSpecific,
    requirements_found: requirementsFound,
    contact_found: contactFound,
    attachments_found: attachmentsFound,
    detail_passed: Boolean(result.status === 200 && detailSpecific && numberPresent)
  };
}

export const connector = Object.freeze({
  key: 'LA_COUNTY_ECAPS',
  version: '1.2.0',
  publisherNames: ['County of Los Angeles', 'Los Angeles County'],
  hostnames: ['camisvr.co.la.ca.us'],

  async verify({ endpoint, sampleSize = 10, timeoutMs = 30000, onSample }) {
    const startedAt = Date.now();
    const startUrl = endpoint && /camisvr\.co\.la\.ca\.us/i.test(endpoint) ? endpoint : BASE_URL;
    const listing = await fetchPage(startUrl, timeoutMs);
    const totalReported = parseTotal(listing.html);
    const pageSize = 10;
    const totalPages = parsePageCount(listing.html, totalReported, pageSize);
    const records = parseRows(listing.html, listing.finalUrl);
    if (!records.length) throw new Error('LA County eCAPS returned no structured open solicitation rows.');

    const sample = records.slice(0, Math.max(1, Math.min(Number(sampleSize) || 10, 20)));
    const checks = [];
    for (let index = 0; index < sample.length; index++) {
      try {
        checks.push(await verifyDetail(sample[index], timeoutMs));
      } catch (error) {
        checks.push({
          solicitation_number: sample[index].solicitation_number,
          title: sample[index].title,
          detail_url: sample[index].detail_page_url,
          detail_passed: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      await onSample?.({
        processed: index + 1,
        total: sample.length,
        passed: checks.filter(item => item.detail_passed).length
      });
    }

    const detailPagesSuccessful = checks.filter(item => item.detail_passed).length;
    const failures = checks.length - detailPagesSuccessful;
    const paginationStatus = Number.isFinite(totalPages) && totalPages >= 1 ? 'PASS' : 'WARNING';
    const readyForAcquisition = failures === 0 && records.length > 0 && paginationStatus === 'PASS';

    return {
      gate: 'EAG-001',
      connector_key: this.key,
      connector_version: this.version,
      verified_at: new Date().toISOString(),
      connection: 'PASS',
      source_url: listing.finalUrl,
      publisher_reported_total: totalReported,
      records_parsed: records.length,
      structured_records: true,
      search_response_ms: listing.responseMs,
      sample_size: sample.length,
      detail_pages_successful: detailPagesSuccessful,
      requirements_successful: checks.filter(item => item.requirements_found).length,
      contacts_successful: checks.filter(item => item.contact_found).length,
      attachments_detected: checks.filter(item => item.attachments_found).length,
      failures,
      pagination_status: paginationStatus,
      total_pages_reported: totalPages,
      requirements_status: checks.every(item => item.requirements_found) ? 'PASS' : 'SECONDARY_DOCUMENT_EXTRACTION_REQUIRED',
      certification_status: readyForAcquisition ? 'CERTIFIED' : 'TESTING',
      ready_for_acquisition: readyForAcquisition,
      elapsed_ms: Date.now() - startedAt,
      sample_results: checks
    };
  },

  async acquire({ endpoint, onPage, maxPages = 100, pageSize = 10, timeoutMs = 30000 }) {
    const startUrl = endpoint && /camisvr\.co\.la\.ca\.us/i.test(endpoint) ? endpoint : BASE_URL;
    const first = await fetchPage(startUrl, timeoutMs);
    const totalReported = parseTotal(first.html);
    const totalPages = Math.min(parsePageCount(first.html, totalReported, pageSize), maxPages);
    const allRecords = [], seen = new Set();
    const acceptRecords = records => { for (const record of records) { const key = txt(record.source_record_id); if (key && !seen.has(key)) { seen.add(key); allRecords.push(record); } } };
    const firstRecords = parseRows(first.html, first.finalUrl); acceptRecords(firstRecords);
    await onPage?.({ page: 1, totalPages, totalReported, records: firstRecords.length });
    for (let page = 2; page <= totalPages; page++) {
      const result = await fetchPage(pageUrl(page, pageSize), timeoutMs);
      const records = parseRows(result.html, result.finalUrl); acceptRecords(records);
      await onPage?.({ page, totalPages, totalReported, records: records.length });
    }
    return {
      connector_key: this.key,
      connector_version: this.version,
      source_url: first.finalUrl,
      total_reported: totalReported,
      pages_processed: totalPages,
      records: allRecords,
      reconciliation: {
        unique_records: allRecords.length,
        total_reported: totalReported,
        count_matches: totalReported == null ? null : allRecords.length === totalReported
      }
    };
  }
});
