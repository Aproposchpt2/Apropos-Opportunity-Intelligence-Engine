import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const LISTING_URL = 'https://hbex.coveredca.com/Solicitations/';
const ROOT = join(process.cwd(), 'artifacts', 'covered-california-source-truth');
const USER_AGENT = 'APROPOS-PDAS/1.0 procurement-source-monitor (+https://apie.aproposgroupllc.com)';
const TARGETS = [
  { number: 'RFP 2026-01', headingId: 'RFP-2026-01', slug: 'RFP-2026-01-INFORMATION-SECURITY' },
  { number: 'RFP 2026-02', headingId: 'RFP-2026-02', slug: 'RFP-2026-02-GENERAL-AGENTS' },
  { number: 'RFP 2026-04', headingId: 'RFP-2026-04', slug: 'RFP-2026-04-ENTERPRISE-STRATEGIC-PLANNING' }
];

const decodeHtml = value => String(value || '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

const cleanText = value => decodeHtml(String(value || ''))
  .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const hash = buffer => createHash('sha256').update(buffer).digest('hex');

function safeName(value, fallback) {
  let decoded = String(value || fallback || 'document.bin');
  try { decoded = decodeURIComponent(decoded); } catch {}
  return decoded
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/g, '') || fallback || 'document.bin';
}

function fileSignature(buffer, extension = '') {
  const prefix = buffer.subarray(0, 16);
  const ascii = prefix.toString('latin1');
  const text = buffer.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  if (ascii.startsWith('%PDF-')) return 'PDF';
  if (prefix[0] === 0x50 && prefix[1] === 0x4b) {
    return ['.docx', '.xlsx', '.xlsm', '.pptx'].includes(extension.toLowerCase()) ? 'OOXML' : 'ZIP';
  }
  if (prefix.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]))) return 'OLE';
  if (text.startsWith('<!doctype html') || text.startsWith('<html')) return 'HTML';
  if (text.startsWith('<?xml')) return 'XML';
  return 'BINARY';
}

function classify(label, filename) {
  const value = `${label} ${filename}`.toUpperCase();
  if (value.includes('ADDENDUM')) return 'ADDENDUM';
  if (/Q\s*&?\s*A|QUESTION/.test(value)) return 'Q_AND_A';
  if (value.includes('MODEL CONTRACT')) return 'MODEL_CONTRACT';
  if (value.includes('ATTACHMENT')) return 'ATTACHMENTS';
  if (value.includes('RFP')) return 'SOLICITATION';
  return 'SUPPORTING_DOCUMENT';
}

function filenameFromDisposition(value) {
  if (!value) return null;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded) return decodeURIComponent(encoded[1].trim());
  const plain = value.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

function findArticle(html, headingId) {
  const articlePattern = /<article\b[^>]*class=(["'])[^"']*\bsolicitation-item\b[^"']*\1[^>]*>[\s\S]*?<\/article>/gi;
  let match;
  while ((match = articlePattern.exec(html))) {
    const article = match[0];
    const headingPattern = new RegExp(`<h2\\b[^>]*id=(["'])${headingId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1[^>]*>`, 'i');
    if (headingPattern.test(article)) return article;
  }
  throw new Error(`Publisher article not found for ${headingId}`);
}

function articleMetadata(article) {
  const heading = cleanText(article.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1]);
  const description = cleanText(article.match(/<div\b[^>]*class=(["'])id\1[^>]*>([\s\S]*?)<\/div>/i)?.[2]);
  return { heading, description };
}

function articleLinks(article) {
  const links = [];
  const anchor = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchor.exec(article))) {
    const href = decodeHtml(match[2]).trim();
    const label = cleanText(match[3]);
    if (!href || href.startsWith('#') || /^(javascript:|mailto:|cloudcannon:)/i.test(href)) continue;
    const url = new URL(href, LISTING_URL);
    if (url.hostname.toLowerCase() !== 'hbex.coveredca.com') continue;
    if (!url.pathname.toLowerCase().startsWith('/solicitations/')) continue;
    links.push({ label, url: url.href });
  }
  return [...new Map(links.map(link => [link.url, link])).values()];
}

async function fetchBytes(url) {
  const started = Date.now();
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { response, buffer, response_ms: Date.now() - started };
}

async function expandZip(filePath, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  try {
    execFileSync('unzip', ['-qq', '-o', filePath, '-d', destination], { stdio: 'pipe' });
    const output = execFileSync('find', [destination, '-type', 'f', '-printf', '%P\n'], { encoding: 'utf8' });
    const files = output.split('\n').map(value => value.trim()).filter(Boolean);
    return { success: true, file_count: files.length, files };
  } catch (error) {
    return { success: false, file_count: 0, files: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function extractPdfText(filePath, outputPath) {
  try {
    execFileSync('pdftotext', ['-layout', filePath, outputPath], { stdio: 'pipe' });
    const text = await readFile(outputPath, 'utf8');
    return { success: true, char_count: text.length, path: outputPath.replace(`${process.cwd()}/`, '') };
  } catch (error) {
    return { success: false, char_count: 0, path: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function processTarget(html, target) {
  const article = findArticle(html, target.headingId);
  const metadata = articleMetadata(article);
  const links = articleLinks(article);
  const targetDir = join(ROOT, target.slug);
  const officialDir = join(targetDir, 'official-files');
  const expandedDir = join(targetDir, 'expanded-archives');
  const textDir = join(targetDir, 'extracted-text');
  await mkdir(officialDir, { recursive: true });
  await mkdir(expandedDir, { recursive: true });
  await mkdir(textDir, { recursive: true });
  await writeFile(join(targetDir, 'listing-article.html'), article, 'utf8');

  const manifest = [];
  for (const [index, link] of links.entries()) {
    const record = {
      sequence: index + 1,
      label: link.label,
      source_url: link.url,
      retrieved_at: new Date().toISOString(),
      retrieval_status: 'FAILED'
    };
    try {
      const { response, buffer, response_ms } = await fetchBytes(link.url);
      const dispositionName = filenameFromDisposition(response.headers.get('content-disposition'));
      const urlName = basename(new URL(response.url).pathname);
      const filename = safeName(dispositionName || urlName, `${target.slug}-${index + 1}.bin`);
      const extension = extname(filename).toLowerCase();
      const signature = fileSignature(buffer, extension);
      Object.assign(record, {
        final_url: response.url,
        http_status: response.status,
        response_ms,
        content_type: response.headers.get('content-type'),
        filename,
        file_extension: extension || null,
        byte_size: buffer.length,
        sha256: hash(buffer),
        signature,
        document_type: classify(link.label, filename)
      });
      if (!response.ok || buffer.length === 0 || signature === 'HTML') {
        record.retrieval_status = 'REJECTED';
        record.error = `status=${response.status}; bytes=${buffer.length}; signature=${signature}`;
        manifest.push(record);
        continue;
      }
      const destination = join(officialDir, filename);
      await writeFile(destination, buffer);
      record.storage_path = destination.replace(`${process.cwd()}/`, '');
      record.retrieval_status = 'VERIFIED';
      if (signature === 'PDF') {
        record.text_extraction = await extractPdfText(destination, join(textDir, `${filename}.txt`));
      }
      if (signature === 'ZIP' && extension === '.zip') {
        record.archive_expansion = await expandZip(destination, join(expandedDir, filename.replace(/\.zip$/i, '')));
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
    }
    manifest.push(record);
  }

  const verified = manifest.filter(item => item.retrieval_status === 'VERIFIED');
  const failed = manifest.filter(item => item.retrieval_status !== 'VERIFIED');
  const addenda = verified.filter(item => item.document_type === 'ADDENDUM');
  const archives = verified.filter(item => item.signature === 'ZIP');
  const summary = {
    solicitation_number: target.number,
    title: metadata.heading,
    description: metadata.description,
    listing_url: LISTING_URL,
    article_sha256: hash(Buffer.from(article)),
    listed_document_links: links.length,
    verified_documents: verified.length,
    failed_documents: failed.length,
    addendum_documents: addenda.length,
    archive_documents: archives.length,
    expanded_archive_files: archives.reduce((sum, item) => sum + Number(item.archive_expansion?.file_count || 0), 0),
    total_verified_bytes: verified.reduce((sum, item) => sum + Number(item.byte_size || 0), 0),
    package_complete: links.length > 0 && verified.length === links.length && failed.length === 0,
    document_labels: links.map(item => item.label),
    filenames: verified.map(item => item.filename)
  };
  await writeFile(join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(targetDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return { summary, manifest };
}

async function main() {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  const listing = await fetchBytes(LISTING_URL);
  if (!listing.response.ok) throw new Error(`Listing retrieval failed: HTTP ${listing.response.status}`);
  const html = listing.buffer.toString('utf8');
  await writeFile(join(ROOT, 'official-listing.html'), html, 'utf8');

  const results = [];
  for (const target of TARGETS) results.push(await processTarget(html, target));
  const summaries = results.map(result => result.summary);
  const allComplete = summaries.every(summary => summary.package_complete);
  const distinctUrls = new Set(results.flatMap(result => result.manifest.map(item => item.source_url)));
  const distinctHashes = new Set(results.flatMap(result => result.manifest.filter(item => item.retrieval_status === 'VERIFIED').map(item => item.sha256)));

  const campaign = {
    publisher: 'California Health Benefit Exchange (Covered California)',
    executed_at: new Date().toISOString(),
    official_website: 'https://hbex.coveredca.com/',
    procurement_website: LISTING_URL,
    listing_http_status: listing.response.status,
    listing_response_ms: listing.response_ms,
    listing_byte_size: listing.buffer.length,
    listing_sha256: hash(listing.buffer),
    target_records: summaries.length,
    complete_packages: summaries.filter(summary => summary.package_complete).length,
    listed_document_links: summaries.reduce((sum, summary) => sum + summary.listed_document_links, 0),
    verified_documents: summaries.reduce((sum, summary) => sum + summary.verified_documents, 0),
    failed_documents: summaries.reduce((sum, summary) => sum + summary.failed_documents, 0),
    addendum_documents: summaries.reduce((sum, summary) => sum + summary.addendum_documents, 0),
    archive_documents: summaries.reduce((sum, summary) => sum + summary.archive_documents, 0),
    expanded_archive_files: summaries.reduce((sum, summary) => sum + summary.expanded_archive_files, 0),
    total_verified_bytes: summaries.reduce((sum, summary) => sum + summary.total_verified_bytes, 0),
    distinct_source_urls: distinctUrls.size,
    distinct_file_hashes: distinctHashes.size,
    access_experience: {
      listing_access: 'PUBLIC_STATIC_HTML',
      record_boundary: 'ARTICLE.solicitation-item WITH EXACT H2 ID',
      detail_model: 'SOLICITATION_ARTICLE_ON_SINGLE_PUBLIC_PAGE',
      document_access: 'DIRECT_STATIC_FILE_LINKS',
      authentication_required: false,
      registration_required: false,
      cookies_required: false,
      javascript_required: false,
      stateful_session_required: false,
      browser_automation_required: false,
      pagination_required: false,
      addendum_detection: 'EXPLICIT_LINK_LABEL_WITHIN_EXACT_SOLICITATION_ARTICLE',
      durable_record_key: 'RFP_NUMBER',
      refresh_method: 'REFETCH_LISTING; COMPARE ARTICLE HASH, LINK SET, FILE HASHES AND EXPLICIT ADDENDA'
    },
    approval_assessment: {
      publisher_profile_qualifies: allComplete && distinctUrls.size === summaries.reduce((sum, summary) => sum + summary.listed_document_links, 0),
      recommended_approval_status: allComplete ? 'APPROVED' : 'REVIEW_REQUIRED',
      recommended_certification_status: allComplete ? 'TESTING' : 'DEVELOPMENT',
      connector_key: 'CA_COVERED_CALIFORNIA_HBEX',
      connector_strategy: 'DIRECT_NETLIFY_CONNECTOR',
      access_class: 'CLASS_A',
      reason: allComplete
        ? 'Each current solicitation was isolated by its exact publisher article boundary and every listed document was independently acquired, signature-validated, hashed and reconciled.'
        : 'At least one exact solicitation article contained an unverified document.'
    },
    solicitations: summaries
  };

  const profile = {
    publisher_name: 'California Health Benefit Exchange (Covered California)',
    state_code: 'CA',
    organization_type: 'STATE_AUTHORITY',
    jurisdiction_level: 'STATE',
    official_website: 'https://hbex.coveredca.com/',
    procurement_website: LISTING_URL,
    search_endpoint: LISTING_URL,
    acquisition_method: 'DIRECT_PUBLIC_HTML_DOCUMENT_LINKS',
    connector_key: 'CA_COVERED_CALIFORNIA_HBEX',
    connector_version: '0.2.0-manual-validation',
    connector_strategy: 'DIRECT_NETLIFY_CONNECTOR',
    access_class: 'CLASS_A',
    machine_to_machine_supported: true,
    public_access_verified: allComplete,
    authentication_required: false,
    registration_required: false,
    login_required: false,
    javascript_required: false,
    stateful_session_required: false,
    browser_automation_required: false,
    profile_complete: allComplete,
    publisher_profile_approved: allComplete,
    approved_for_operator_menu: allComplete,
    approval_status: allComplete ? 'APPROVED' : 'REVIEW_REQUIRED',
    certification_status: allComplete ? 'TESTING' : 'DEVELOPMENT',
    operational_status: 'ACTIVE',
    access_instructions: 'Fetch the official solicitation page. Isolate an article.solicitation-item using the exact h2 id derived from the RFP number. Download only direct hbex.coveredca.com/solicitations/ links inside that article. Preserve and hash original archives, expand working copies, and reconcile the exact article link count before package completion.',
    known_limitations: [
      'Current and historical solicitations share one long page.',
      'A broad heading-to-heading parser can contaminate packages; exact article boundaries are mandatory.',
      'Open status and current deadline must be derived from the solicitation and latest addendum, not page position.',
      'ZIP archives contain required internal files and must be preserved and expanded.',
      'The latest explicit addendum controls changed dates and requirements.'
    ],
    evidence: campaign
  };

  await writeFile(join(ROOT, 'campaign-summary.json'), JSON.stringify(campaign, null, 2));
  await writeFile(join(ROOT, 'publisher-profile-draft.json'), JSON.stringify(profile, null, 2));
  await writeFile(join(ROOT, 'README.txt'), [
    'APROPOS Covered California Manual Source-of-Truth Experience - Corrected Article-Boundary Validation',
    '',
    `Official listing: ${LISTING_URL}`,
    `Target solicitations: ${campaign.target_records}`,
    `Complete packages: ${campaign.complete_packages}`,
    `Listed links: ${campaign.listed_document_links}`,
    `Verified documents: ${campaign.verified_documents}`,
    `Failed documents: ${campaign.failed_documents}`,
    `Distinct URLs: ${campaign.distinct_source_urls}`,
    `Distinct hashes: ${campaign.distinct_file_hashes}`,
    `Approval recommendation: ${campaign.approval_assessment.recommended_approval_status}`,
    '',
    'The first validation run exposed cross-article contamination from a heading-boundary parser. Version 2 uses exact article.solicitation-item boundaries and exact h2 IDs. Approval evidence must come from this corrected run.'
  ].join('\n'));

  console.log(JSON.stringify(campaign, null, 2));
  if (!campaign.approval_assessment.publisher_profile_qualifies) process.exitCode = 2;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
