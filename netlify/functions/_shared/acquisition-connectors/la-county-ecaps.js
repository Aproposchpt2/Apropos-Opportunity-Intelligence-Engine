const BASE_URL = 'https://camisvr.co.la.ca.us/LACoBids/BidLookUp/OpenBidList';

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

function resolveUrl(href, baseUrl) {
  try { return new URL(href, baseUrl).toString().replace(/#.*$/, ''); }
  catch { return null; }
}

function firstHref(html, baseUrl) {
  const href = String(html || '').match(/<a\b[^>]*href=["']([^"']+)["']/i)?.[1];
  return href ? resolveUrl(href, baseUrl) : null;
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
    const title = txt(titleCellText
      .replace(/\bMore\b/gi, ' ')
      .replace(/Commodity:\s*[\s\S]*$/i, ' '));

    const solicitationType = decodeHtml(cells[2]) || null;
    const department = decodeHtml(cells[3]) || null;
    const closeDateText = decodeHtml(cells[4]) || null;
    const detailUrl = firstHref(cells[1], pageUrl) || firstHref(row, pageUrl) || pageUrl;

    if (!title) continue;
    records.push({
      source_record_id: solicitationNumber,
      solicitation_number: solicitationNumber,
      title,
      solicitation_type: solicitationType,
      department,
      commodity,
      close_date_text: closeDateText,
      continuous: /^continuous$/i.test(closeDateText || ''),
      status: 'OPEN',
      source_url: detailUrl,
      listing_url: pageUrl,
      issuing_organization: 'County of Los Angeles',
      state_code: 'CA',
      procurement_platform: 'Los Angeles County eCAPS',
      record_type: 'SOLICITATION_LISTING'
    });
  }

  return records;
}

async function fetchPage(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'APROPOS-APIE-LA-County-Connector/1.0',
        'Cache-Control': 'no-cache'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`LA County page request failed with HTTP ${response.status}`);
    return { html: await response.text(), finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
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
    const allRecords = [];
    const seen = new Set();

    const acceptRecords = records => {
      for (const record of records) {
        const key = txt(record.source_record_id);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        allRecords.push(record);
      }
    };

    const firstRecords = parseRows(first.html, first.finalUrl);
    acceptRecords(firstRecords);
    await onPage?.({ page: 1, totalPages, totalReported, records: firstRecords.length });

    for (let page = 2; page <= totalPages; page++) {
      const result = await fetchPage(pageUrl(page, pageSize), timeoutMs);
      const records = parseRows(result.html, result.finalUrl);
      acceptRecords(records);
      await onPage?.({ page, totalPages, totalReported, records: records.length });
    }

    return {
      connector_key: 'LA_COUNTY_ECAPS',
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
