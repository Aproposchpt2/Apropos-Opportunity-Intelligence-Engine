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
    const response = await fetch(url, {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'APROPOS-APIE-LA-County-Connector/1.1', 'Cache-Control': 'no-cache' },
      redirect: 'follow', signal: controller.signal
    });
    if (!response.ok) throw new Error(`LA County page request failed with HTTP ${response.status}`);
    return { html: await response.text(), finalUrl: response.url || url };
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

export const connector = Object.freeze({
  key: 'LA_COUNTY_ECAPS',
  publisherNames: ['County of Los Angeles', 'Los Angeles County'],
  hostnames: ['camisvr.co.la.ca.us'],
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
    return { connector_key: 'LA_COUNTY_ECAPS', connector_version: '1.1', source_url: first.finalUrl, total_reported: totalReported, pages_processed: totalPages, records: allRecords,
      reconciliation: { unique_records: allRecords.length, total_reported: totalReported, count_matches: totalReported == null ? null : allRecords.length === totalReported } };
  }
});
