import { createHash } from 'node:crypto';

const listingUrl = 'https://in.nau.edu/facility-services/pdc/bids-rfqs/';
const centralBidBoardUrl = 'https://in.nau.edu/contracting-purchasing-services/nau-bid-board/';
const userAgent = 'APROPOS-PDAS/1.0 manual-acquisition-profile-verification';

const targetLabels = [
  'Notice of Bid',
  'Project Manual',
  'Construction Documents',
  'Pre-Submittal Conference Slides',
  'Addendum #1',
  'Addendum #2',
  'Addendum #3',
  'Bid Tab Matrix'
];

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripTags(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractAnchors(html, baseUrl) {
  const anchors = [];
  const regex = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(regex)) {
    const text = stripTags(match[2]);
    let url;
    try {
      url = new URL(decodeHtml(match[1]), baseUrl).toString();
    } catch {
      continue;
    }
    anchors.push({ text, url });
  }
  return anchors;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(60000)
  });
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    finalUrl: response.url,
    contentType: response.headers.get('content-type') || '',
    bytes: Buffer.byteLength(text),
    text
  };
}

async function fetchBinary(label, url) {
  const started = Date.now();
  const response = await fetch(url, {
    headers: { 'user-agent': userAgent, accept: 'application/pdf,application/octet-stream,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(180000)
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const signature = buffer.subarray(0, 5).toString('ascii');
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  return {
    label,
    sourceUrl: url,
    finalUrl: response.url,
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get('content-type') || '',
    contentLengthHeader: response.headers.get('content-length'),
    lastModified: response.headers.get('last-modified'),
    etag: response.headers.get('etag'),
    actualBytes: buffer.length,
    pdfSignature: signature,
    validPdf: signature === '%PDF-',
    sha256,
    elapsedMs: Date.now() - started,
    filename: decodeURIComponent(new URL(response.url).pathname.split('/').pop() || '')
  };
}

const facility = await fetchText(listingUrl);
if (!facility.ok) throw new Error(`Facility listing failed: HTTP ${facility.status}`);

const anchors = extractAnchors(facility.text, facility.finalUrl);
const selected = [];
for (const label of targetLabels) {
  const match = anchors.find(anchor => anchor.text.toLowerCase() === label.toLowerCase());
  if (!match) throw new Error(`Required portfolio link not found: ${label}`);
  selected.push({ label, url: match.url });
}

const documents = [];
for (const item of selected) {
  documents.push(await fetchBinary(item.label, item.url));
}

const central = await fetchText(centralBidBoardUrl);
const centralAnchors = central.ok ? extractAnchors(central.text, central.finalUrl) : [];
const centralBidNames = centralAnchors
  .filter(anchor => /^P\d{2}[A-Z]{2}\d{3}/i.test(anchor.text))
  .map(anchor => ({ text: anchor.text, url: anchor.url }));

const result = {
  executedAt: new Date().toISOString(),
  publisher: 'Northern Arizona University',
  channel: 'Facility Services Planning, Design & Construction — Bids and RFQs',
  testProject: {
    name: 'Fieldhouse HVAC Replacement',
    projectNumber: '09.300.251',
    lifecycleStatusObserved: 'Award selection posted; retained as complete portfolio verification case'
  },
  access: {
    authenticationRequired: false,
    cookiesRequired: false,
    javascriptRenderingRequired: false,
    listingStatus: facility.status,
    listingContentType: facility.contentType,
    listingBytes: facility.bytes,
    anchorsParsed: anchors.length
  },
  centralBidBoard: {
    status: central.status,
    contentType: central.contentType,
    bytes: central.bytes,
    solicitationLinksFound: centralBidNames
  },
  documents,
  summary: {
    linksResolved: selected.length,
    documentsDownloaded: documents.filter(d => d.ok).length,
    validPdfs: documents.filter(d => d.validPdf).length,
    failures: documents.filter(d => !d.ok || !d.validPdf).length,
    totalActualBytes: documents.reduce((sum, d) => sum + d.actualBytes, 0),
    addendaDownloaded: documents.filter(d => /^Addendum/i.test(d.label)).length
  }
};

console.log('NAU_MANUAL_ACQUISITION_RESULT_BEGIN');
console.log(JSON.stringify(result, null, 2));
console.log('NAU_MANUAL_ACQUISITION_RESULT_END');

if (result.summary.failures !== 0 || result.summary.documentsDownloaded !== targetLabels.length) {
  process.exitCode = 1;
}
