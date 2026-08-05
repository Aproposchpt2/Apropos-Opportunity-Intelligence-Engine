import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const LISTING_URL = 'https://hbex.coveredca.com/Solicitations/';
const TARGETS = [
  { solicitation_number: 'RFP 2026-01', slug: 'RFP-2026-01-INFORMATION-SECURITY' },
  { solicitation_number: 'RFP 2026-02', slug: 'RFP-2026-02-GENERAL-AGENTS' },
  { solicitation_number: 'RFP 2026-04', slug: 'RFP-2026-04-ENTERPRISE-STRATEGIC-PLANNING' }
];
const ROOT = join(process.cwd(), 'artifacts', 'covered-california-source-truth');
const USER_AGENT = 'APROPOS-PDAS/1.0 procurement-source-monitor (+https://apie.aproposgroupllc.com)';

const cleanText = value => decodeHtml(String(value || '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim());

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function safeName(value, fallback = 'document.bin') {
  const decoded = decodeURIComponent(String(value || fallback));
  const sanitized = decoded
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/g, '');
  return sanitized || fallback;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function signature(buffer, extension) {
  const prefix = buffer.subarray(0, 16);
  const ascii = prefix.toString('latin1');
  const textPrefix = buffer.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  const ext = extension.toLowerCase();
  if (ascii.startsWith('%PDF-')) return 'PDF';
  if (prefix[0] === 0x50 && prefix[1] === 0x4b) {
    if (['.docx', '.xlsx', '.xlsm', '.pptx'].includes(ext)) return 'OOXML';
    return 'ZIP';
  }
  if (prefix.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]))) return 'OLE';
  if (textPrefix.startsWith('<!doctype html') || textPrefix.startsWith('<html')) return 'HTML';
  if (textPrefix.startsWith('<?xml')) return 'XML';
  return 'BINARY';
}

function classify(label, filename) {
  const value = `${label} ${filename}`.toUpperCase();
  if (value.includes('ADDENDUM')) return 'ADDENDUM';
  if (value.includes('Q&A') || value.includes('Q & A') || value.includes('QUESTION')) return 'Q_AND_A';
  if (value.includes('MODEL CONTRACT')) return 'MODEL_CONTRACT';
  if (value.includes('ATTACHMENT')) return 'ATTACHMENTS';
  if (value.includes('RFP')) return 'SOLICITATION';
  return 'SUPPORTING_DOCUMENT';
}

function contentDispositionFilename(headerValue) {
  if (!headerValue) return null;
  const star = headerValue.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) return decodeURIComponent(star[1].trim());
  const plain = headerValue.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

function sectionFor(html, solicitationNumber) {
  const headingPattern = new RegExp(`<h2\\b[^>]*>[\\s\\S]*?${solicitationNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?<\\/h2>`, 'i');
  const match = headingPattern.exec(html);
  if (!match) throw new Error(`Solicitation heading not found: ${solicitationNumber}`);
  const start = match.index;
  const next = html.slice(start + match[0].length).search(/<h2\b/i);
  const end = next === -1 ? html.length : start + match[0].length + next;
  return html.slice(start, end);
}

function extractLinks(sectionHtml) {
  const links = [];
  const anchor = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchor.exec(sectionHtml))) {
    const href = decodeHtml(match[2]).trim();
    const label = cleanText(match[3]);
    if (!href || href.startsWith('#') || /^javascript:|^mailto:/i.test(href)) continue;
    if (/^details\s*&?\s*downloads:?$/i.test(label)) continue;
    const url = new URL(href, LISTING_URL);
    if (!/hbex\.coveredca\.com$/i.test(url.hostname)) continue;
    if (!/\/solicitations\//i.test(url.pathname)) continue;
    links.push({ label, url: url.href });
  }
  return [...new Map(links.map(item => [item.url, item])).values()];
}

function firstParagraphAfterHeading(sectionHtml) {
  const body = sectionHtml.replace(/^<h2\b[\s\S]*?<\/h2>/i, '');
  const paragraph = body.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  return paragraph ? cleanText(paragraph[1]) : '';
}

function extractPdfDates(text) {
  const line = key => {
    const pattern = new RegExp(`${key}\\s*:?\\s*([^\\n\\r]+(?:\\n(?![A-Z][A-Za-z ]+\\s*:)[^\\n\\r]+)?)`, 'i');
    const match = text.match(pattern);
    return match ? match[1].replace(/\s+/g, ' ').trim() : null;
  };
  return {
    release_date: line('Request for Proposal Release Date'),
    questions_due: line('RFP Questions Due Date and Time'),
    responses_posted_by: line('Responses to Questions Posted By'),
    proposal_due: line('Proposal Due Date and Time'),
    notice_of_intent: line('Notice of Intent to Award'),
    anticipated_contract_term: line('Anticipated Contract Term')
  };
}

async function fetchBuffer(url) {
  const started = Date.now();
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': '*/*'
    }
  });
  const arrayBuffer = await response.arrayBuffer();
  return {
    response,
    buffer: Buffer.from(arrayBuffer),
    elapsed_ms: Date.now() - started
  };
}

async function extractArchive(zipPath, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  try {
    execFileSync('unzip', ['-qq', '-o', zipPath, '-d', destination], { stdio: 'pipe' });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error), files: [] };
  }
  const output = execFileSync('find', [destination, '-type', 'f', '-printf', '%P\n'], { encoding: 'utf8' });
  const files = output.split('\n').map(v => v.trim()).filter(Boolean);
  return { success: true, files };
}

async function textFromPdf(pdfPath, txtPath) {
  try {
    execFileSync('pdftotext', ['-layout', pdfPath, txtPath], { stdio: 'pipe' });
    return await readFile(txtPath, 'utf8');
  } catch {
    return '';
  }
}

async function processSolicitation(html, target) {
  const targetDir = join(ROOT, target.slug);
  const officialDir = join(targetDir, 'official-files');
  const expandedDir = join(targetDir, 'expanded-archives');
  const textDir = join(targetDir, 'extracted-text');
  await mkdir(officialDir, { recursive: true });
  await mkdir(expandedDir, { recursive: true });
  await mkdir(textDir, { recursive: true });

  const sectionHtml = sectionFor(html, target.solicitation_number);
  const links = extractLinks(sectionHtml);
  await writeFile(join(targetDir, 'listing-section.html'), sectionHtml, 'utf8');

  const manifest = [];
  for (const [index, link] of links.entries()) {
    const result = {
      sequence: index + 1,
      label: link.label,
      source_url: link.url,
      retrieved_at: new Date().toISOString(),
      retrieval_status: 'FAILED'
    };
    try {
      const { response, buffer, elapsed_ms } = await fetchBuffer(link.url);
      const disposition = contentDispositionFilename(response.headers.get('content-disposition'));
      const pathnameName = basename(new URL(response.url).pathname);
      const filename = safeName(disposition || pathnameName || `${target.slug}-${index + 1}.bin`);
      const destination = join(officialDir, filename);
      const extension = extname(filename).toLowerCase();
      const detected = signature(buffer, extension);
      result.final_url = response.url;
      result.http_status = response.status;
      result.response_ms = elapsed_ms;
      result.content_type = response.headers.get('content-type');
      result.content_length_header = response.headers.get('content-length');
      result.filename = filename;
      result.file_extension = extension || null;
      result.byte_size = buffer.length;
      result.sha256 = sha256(buffer);
      result.signature = detected;
      result.document_type = classify(link.label, filename);
      result.retrieval_status = response.ok && buffer.length > 0 && detected !== 'HTML' ? 'VERIFIED' : 'REJECTED';
      if (result.retrieval_status !== 'VERIFIED') {
        result.error = `Rejected download: status=${response.status}, bytes=${buffer.length}, signature=${detected}`;
        manifest.push(result);
        continue;
      }
      await writeFile(destination, buffer);
      result.storage_path = destination.replace(`${process.cwd()}/`, '');

      if (detected === 'PDF') {
        const textPath = join(textDir, `${filename}.txt`);
        const text = await textFromPdf(destination, textPath);
        result.extracted_text_path = text ? textPath.replace(`${process.cwd()}/`, '') : null;
        result.extracted_char_count = text.length;
        result.detected_dates = extractPdfDates(text);
      }

      if (detected === 'ZIP' && extension === '.zip') {
        const archiveDestination = join(expandedDir, filename.replace(/\.zip$/i, ''));
        const archive = await extractArchive(destination, archiveDestination);
        result.archive_expansion = {
          success: archive.success,
          error: archive.error || null,
          file_count: archive.files.length,
          files: archive.files
        };
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    manifest.push(result);
  }

  const verified = manifest.filter(item => item.retrieval_status === 'VERIFIED');
  const failed = manifest.filter(item => item.retrieval_status !== 'VERIFIED');
  const addenda = verified.filter(item => item.document_type === 'ADDENDUM');
  const packageComplete = links.length > 0 && verified.length === links.length && failed.length === 0;
  const summary = {
    solicitation_number: target.solicitation_number,
    title: cleanText(sectionHtml.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || target.solicitation_number),
    description: firstParagraphAfterHeading(sectionHtml),
    listing_url: LISTING_URL,
    source_section_sha256: sha256(Buffer.from(sectionHtml)),
    listed_document_links: links.length,
    verified_documents: verified.length,
    failed_documents: failed.length,
    addendum_documents: addenda.length,
    total_verified_bytes: verified.reduce((sum, item) => sum + Number(item.byte_size || 0), 0),
    expanded_archive_files: verified.reduce((sum, item) => sum + Number(item.archive_expansion?.file_count || 0), 0),
    package_complete: packageComplete,
    document_labels: links.map(item => item.label),
    current_dates_by_document: Object.fromEntries(
      verified
        .filter(item => item.detected_dates)
        .map(item => [item.filename, item.detected_dates])
    )
  };
  await writeFile(join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(targetDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return { summary, manifest };
}

async function main() {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });

  const listing = await fetchBuffer(LISTING_URL);
  if (!listing.response.ok) throw new Error(`Listing retrieval failed: HTTP ${listing.response.status}`);
  const html = listing.buffer.toString('utf8');
  await writeFile(join(ROOT, 'official-listing.html'), html, 'utf8');

  const results = [];
  for (const target of TARGETS) {
    results.push(await processSolicitation(html, target));
  }

  const summaries = results.map(item => item.summary);
  const allPackagesComplete = summaries.every(item => item.package_complete);
  const campaign = {
    publisher: 'California Health Benefit Exchange (Covered California)',
    executed_at: new Date().toISOString(),
    official_website: 'https://hbex.coveredca.com/',
    procurement_website: LISTING_URL,
    listing_http_status: listing.response.status,
    listing_response_ms: listing.elapsed_ms,
    listing_byte_size: listing.buffer.length,
    listing_sha256: sha256(listing.buffer),
    target_records: summaries.length,
    complete_packages: summaries.filter(item => item.package_complete).length,
    listed_document_links: summaries.reduce((sum, item) => sum + item.listed_document_links, 0),
    verified_documents: summaries.reduce((sum, item) => sum + item.verified_documents, 0),
    failed_documents: summaries.reduce((sum, item) => sum + item.failed_documents, 0),
    addendum_documents: summaries.reduce((sum, item) => sum + item.addendum_documents, 0),
    expanded_archive_files: summaries.reduce((sum, item) => sum + item.expanded_archive_files, 0),
    total_verified_bytes: summaries.reduce((sum, item) => sum + item.total_verified_bytes, 0),
    access_experience: {
      listing_access: 'PUBLIC_STATIC_HTML',
      detail_model: 'SOLICITATION_SECTION_ON_SINGLE_PUBLIC_PAGE',
      document_access: 'DIRECT_STATIC_FILE_LINKS',
      authentication_required: false,
      registration_required: false,
      cookies_required: false,
      javascript_required: false,
      stateful_session_required: false,
      browser_automation_required: false,
      pagination_required: false,
      addendum_detection: 'EXPLICIT_LINK_LABEL_WITHIN_SOLICITATION_SECTION',
      durable_record_key: 'RFP_NUMBER',
      refresh_method: 'REFETCH_LISTING_AND_COMPARE_SECTION_AND_DOCUMENT_HASHES'
    },
    approval_assessment: {
      publisher_profile_qualifies: allPackagesComplete,
      recommended_approval_status: allPackagesComplete ? 'APPROVED' : 'REVIEW_REQUIRED',
      recommended_certification_status: allPackagesComplete ? 'TESTING' : 'DEVELOPMENT',
      connector_key: 'CA_COVERED_CALIFORNIA_HBEX',
      connector_strategy: 'DIRECT_NETLIFY_CONNECTOR',
      access_class: 'CLASS_A',
      reason: allPackagesComplete
        ? 'Three current public solicitations and every listed document link were acquired without authentication, browser state, or download failure.'
        : 'One or more listed document links were not acquired and reconciled.'
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
    connector_version: '0.1.0-manual-validation',
    connector_strategy: 'DIRECT_NETLIFY_CONNECTOR',
    access_class: 'CLASS_A',
    machine_to_machine_supported: true,
    public_access_verified: allPackagesComplete,
    authentication_required: false,
    registration_required: false,
    login_required: false,
    javascript_required: false,
    stateful_session_required: false,
    browser_automation_required: false,
    profile_complete: allPackagesComplete,
    publisher_profile_approved: allPackagesComplete,
    approved_for_operator_menu: allPackagesComplete,
    approval_status: allPackagesComplete ? 'APPROVED' : 'REVIEW_REQUIRED',
    certification_status: allPackagesComplete ? 'TESTING' : 'DEVELOPMENT',
    operational_status: 'ACTIVE',
    access_instructions: 'Fetch the official solicitation page, isolate each RFP section by heading, use the RFP number as the durable identifier, and download every direct document link within that section. Reconcile link count, file signatures, byte sizes, hashes, and explicit addenda before package completion.',
    known_limitations: [
      'Current and historical solicitations share one long page.',
      'Open status and current deadline must be derived from the RFP and latest addendum, not page position.',
      'Archive links may contain multiple required files and must be expanded while preserving the original archive.',
      'Addenda can replace key dates and requirements; the latest addendum controls.'
    ],
    evidence: campaign
  };

  await writeFile(join(ROOT, 'campaign-summary.json'), JSON.stringify(campaign, null, 2));
  await writeFile(join(ROOT, 'publisher-profile-draft.json'), JSON.stringify(profile, null, 2));
  await writeFile(join(ROOT, 'README.txt'), [
    'APROPOS Covered California Manual Source-of-Truth Experience',
    '',
    `Official listing: ${LISTING_URL}`,
    `Target records: ${campaign.target_records}`,
    `Complete packages: ${campaign.complete_packages}`,
    `Listed document links: ${campaign.listed_document_links}`,
    `Verified documents: ${campaign.verified_documents}`,
    `Failed documents: ${campaign.failed_documents}`,
    `Approval recommendation: ${campaign.approval_assessment.recommended_approval_status}`,
    '',
    'This artifact preserves the official listing HTML, each target section, original downloaded files, SHA-256 hashes, extracted PDF text, expanded ZIP contents, manifests, summaries, and the Publisher Profile draft.'
  ].join('\n'));

  console.log(JSON.stringify(campaign, null, 2));
  if (!allPackagesComplete) process.exitCode = 2;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
