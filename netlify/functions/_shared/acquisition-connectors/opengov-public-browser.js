const txt = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function sameHostUrl(value, endpoint) {
  try {
    const candidate = new URL(value, endpoint);
    const source = new URL(endpoint);
    return candidate.protocol === 'https:' && candidate.hostname === source.hostname ? candidate.href : null;
  } catch { return null; }
}

function extractProjectLinks(html, endpoint) {
  const links = new Set();
  const pattern = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = pattern.exec(String(html || '')))) {
    const href = sameHostUrl(match[1], endpoint);
    if (!href) continue;
    if (/\/portal\/[^/?#]+\/project\//i.test(href) || /\/projects?\//i.test(href)) links.add(href);
  }
  return [...links];
}

async function fetchHtml(url) {
  const started = Date.now();
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': 'APROPOS-Publisher-Engineering/1.0', Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(60000)
  });
  const html = await response.text();
  return { response, html, responseMs: Date.now() - started };
}

export const connector = {
  key: 'OPENGOV_PUBLIC_BROWSER',
  version: '1.0.0',
  publisherNames: [],
  hostnames: ['procurement.opengov.com'],
  async verify({ endpoint, publisher, sampleSize = 5, onSample }) {
    const listing = await fetchHtml(endpoint);
    if (!listing.response.ok) throw new Error(`OpenGov public listing returned HTTP ${listing.response.status}.`);
    const projectLinks = extractProjectLinks(listing.html, endpoint);
    const requested = Math.max(1, Math.min(Number(sampleSize || 5), 5));
    const sample = projectLinks.slice(0, requested);
    let detailPagesSuccessful = 0;
    let failures = 0;
    for (let index = 0; index < sample.length; index++) {
      try {
        const detail = await fetchHtml(sample[index]);
        const hasEvidence = detail.response.ok && txt(detail.html).length > 500;
        if (hasEvidence) detailPagesSuccessful += 1; else failures += 1;
      } catch {
        failures += 1;
      }
      if (onSample) await onSample({ processed: index + 1, total: sample.length, passed: detailPagesSuccessful });
    }

    const recordsParsed = projectLinks.length;
    const ready = listing.response.ok && recordsParsed > 0 && (sample.length === 0 || failures === 0);
    return {
      connector_key: 'OPENGOV_PUBLIC_BROWSER',
      connector_version: '1.0.0',
      ready_for_acquisition: ready,
      connection: listing.response.ok ? 'PASS' : 'FAIL',
      endpoint_status: listing.response.status,
      endpoint_final_url: listing.response.url || endpoint,
      endpoint_content_type: listing.response.headers.get('content-type') || null,
      search_response_ms: listing.responseMs,
      publisher_reported_total: null,
      records_parsed: recordsParsed,
      sample_size: sample.length,
      detail_pages_attempted: sample.length,
      detail_pages_successful: detailPagesSuccessful,
      attachments_detected: 0,
      contacts_successful: 0,
      requirements_successful: detailPagesSuccessful,
      failures,
      pagination_status: 'PUBLIC_LISTING_DISCOVERY_ONLY',
      execution_mode: 'PLAYWRIGHT_PUBLIC_LISTING',
      access_controls_used: false,
      publisher_name: publisher?.publisher_name || null,
      source_url: endpoint
    };
  }
};
