import { createHash } from 'node:crypto';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import AdmZip from 'adm-zip';
import { storageUpload } from './native-runtime.js';

const BUCKET = 'solicitation-packages';
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_CHARS = 1_500_000;
const now = () => new Date().toISOString();
const txt = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const cleanId = value => txt(value).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160) || 'unknown';

function parseJson(value, fallback = []) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function extOf(filename = '', mime = '') {
  const match = String(filename).toLowerCase().match(/\.([a-z0-9]{1,8})(?:$|\?)/);
  if (match) return `.${match[1]}`;
  const map = {
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'application/x-zip-compressed': '.zip',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'text/plain': '.txt',
    'text/csv': '.csv'
  };
  return map[String(mime).split(';')[0].toLowerCase()] || '';
}

function filenameFromHeaders(headers, url, fallback = 'attachment') {
  const disposition = headers.get('content-disposition') || '';
  const utf = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const basic = disposition.match(/filename="?([^";]+)"?/i);
  const fromHeader = utf?.[1] ? decodeURIComponent(utf[1]) : basic?.[1];
  if (fromHeader) return cleanId(fromHeader);
  try {
    const candidate = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    if (candidate && candidate.includes('.')) return cleanId(candidate);
  } catch {}
  return cleanId(fallback);
}

function classifyDocument(name, label = '', text = '') {
  const hay = `${name} ${label} ${text.slice(0, 3000)}`.toLowerCase();
  if (/addendum|addenda/.test(hay)) return 'ADDENDUM';
  if (/amendment|modification/.test(hay)) return 'AMENDMENT';
  if (/question|answer|q\s*&\s*a|inquir/.test(hay)) return 'Q_AND_A';
  if (/scope of work|statement of work|\bsow\b|work statement/.test(hay)) return 'SCOPE_OF_WORK';
  if (/specification|technical requirement|technical exhibit/.test(hay)) return 'SPECIFICATIONS';
  if (/evaluation|selection criteria|scoring|proposal rating/.test(hay)) return 'EVALUATION';
  if (/instruction|information to proposer|submission requirement/.test(hay)) return 'INSTRUCTIONS';
  if (/price|pricing|bid schedule|cost proposal|rate sheet/.test(hay)) return 'PRICING';
  if (/insurance|bond|bonding|indemnif/.test(hay)) return 'INSURANCE_BONDING';
  if (/form|certification|declaration|affidavit/.test(hay)) return 'FORMS';
  if (/drawing|plan set|blueprint/.test(hay)) return 'DRAWINGS';
  if (/appendix|exhibit|attachment/.test(hay)) return 'EXHIBIT';
  return 'OTHER';
}

function extractSentences(text, pattern, limit = 50) {
  const lines = String(text || '').split(/(?<=[.!?])\s+|\n+/).map(txt).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (pattern.test(line) && line.length >= 20 && !out.includes(line)) out.push(line.slice(0, 1200));
    if (out.length >= limit) break;
  }
  return out;
}

export function buildRequirementsMatrix(documents, listing = {}) {
  const ordered = [...documents].sort((a, b) => {
    const priority = { ADDENDUM: 1, AMENDMENT: 2, SCOPE_OF_WORK: 3, SPECIFICATIONS: 4, INSTRUCTIONS: 5, EVALUATION: 6, INSURANCE_BONDING: 7, PRICING: 8, FORMS: 9, EXHIBIT: 10, OTHER: 20 };
    return (priority[a.document_type] || 50) - (priority[b.document_type] || 50);
  });
  const combined = ordered.map(d => `\n\n### ${d.document_type}: ${d.original_filename || d.source_url}\n${d.extracted_text || ''}`).join('').slice(0, MAX_TEXT_CHARS);
  const listingText = [listing.description, listing.requirements_text, listing.title].filter(Boolean).join('\n');
  const source = `${combined}\n${listingText}`;
  const mandatory = extractSentences(source, /\b(must|shall|required|minimum mandatory|will be disqualified|condition of award)\b/i, 120);
  const matrix = {
    scope_of_work: extractSentences(source, /scope of work|statement of work|services? (?:to be )?provided|deliverables?/i, 50),
    mandatory_requirements: mandatory,
    licenses_required: extractSentences(source, /licen[cs]e|licensed contractor|professional registration/i, 40),
    certifications_required: extractSentences(source, /certif(?:ication|ied)|credential|accredit/i, 40),
    experience_requirements: extractSentences(source, /years? of experience|past performance|references?|similar projects?/i, 60),
    staffing_requirements: extractSentences(source, /staff|personnel|project manager|key personnel|resume|trainer/i, 60),
    equipment_requirements: extractSentences(source, /equipment|vehicle|tools?|facility|technology platform/i, 50),
    insurance_requirements: extractSentences(source, /insurance|general liability|workers.? compensation|automobile liability/i, 60),
    bonding_requirements: extractSentences(source, /bid bond|performance bond|payment bond|surety/i, 40),
    geographic_restrictions: extractSentences(source, /place of performance|within los angeles|local preference|service area|countywide/i, 40),
    mandatory_meetings: extractSentences(source, /mandatory (?:conference|meeting|walkthrough|site visit)|proposers? conference/i, 40),
    subcontracting_rules: extractSentences(source, /subcontract|subconsultant|small business enterprise|local small business/i, 50),
    evaluation_factors: extractSentences(source, /evaluation|selection criteria|scor(?:e|ing)|weighted|responsiveness/i, 80),
    pricing_requirements: extractSentences(source, /price proposal|cost proposal|pricing|rate sheet|bid schedule/i, 60),
    submission_requirements: extractSentences(source, /submit|submission|proposal format|statement of qualifications|due no later/i, 80),
    document_count: documents.length,
    extracted_document_count: documents.filter(d => d.extraction_status === 'EXTRACTED').length,
    source: 'official_solicitation_package',
    extraction_engine: 'AADP_PACKAGE_EXTRACTION_V1'
  };
  const substantive = combined.length >= 500 && (mandatory.length > 0 || matrix.scope_of_work.length > 0 || matrix.evaluation_factors.length > 0);
  return { combined_text: combined, matrix, substantive };
}

function cookies(session, response) {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const jar = new Map(String(session.cookie || '').split(/;\s*/).filter(Boolean).map(x => {
    const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)];
  }));
  for (const value of raw) {
    const pair = String(value).split(';', 1)[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  session.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function fetchWithSession(url, session, init = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'APROPOS-APIE-Package-Acquisition/1.0',
      ...init.headers
    };
    if (session.cookie) headers.Cookie = session.cookie;
    const response = await fetch(url, { ...init, headers, redirect: 'follow', signal: controller.signal });
    cookies(session, response);
    return response;
  } finally { clearTimeout(timer); }
}

function dateFromDotNet(value) {
  const match = String(value || '').match(/Date\((\d+)\)/);
  return match ? new Date(Number(match[1])).toISOString() : null;
}

async function resolveLaCountyManifest(raw, session) {
  const detailUrl = raw.source_url || raw.raw_payload?.detail_page_url;
  const detailResponse = await fetchWithSession(detailUrl, session, { headers: { Accept: 'text/html,application/xhtml+xml' } });
  if (!detailResponse.ok) throw new Error(`LA County detail request failed with HTTP ${detailResponse.status}`);
  const html = await detailResponse.text();
  const bidRef = html.match(/GetBidAttachs'[\s\S]{0,250}?BidRefNbr:\s*'([^']+)'/i)?.[1]
    || html.match(/GetBidAmendments'[\s\S]{0,250}?BidRefNbr:\s*'([^']+)'/i)?.[1];
  if (!bidRef) throw new Error(`LA County attachment reference was not found for ${raw.source_record_id}.`);
  const base = new URL(detailResponse.url || detailUrl).origin;
  const attachmentsUrl = `${base}/LACoBids/BidLookUp/GetBidAttachs?BidRefNbr=${encodeURIComponent(bidRef)}`;
  const amendmentsUrl = `${base}/LACoBids/BidLookUp/GetBidAmendments?BidRefNbr=${encodeURIComponent(bidRef)}`;
  const [aRes, mRes] = await Promise.all([
    fetchWithSession(attachmentsUrl, session, { headers: { Accept: 'application/json' } }),
    fetchWithSession(amendmentsUrl, session, { headers: { Accept: 'application/json' } })
  ]);
  const attachments = aRes.ok ? parseJson(await aRes.text(), []) : [];
  const amendments = mRes.ok ? parseJson(await mRes.text(), []) : [];
  const docs = [];
  for (const item of attachments || []) {
    if (!item?.AttachIDI || !item?.AttFileName || item?.Inactive === true) continue;
    docs.push({
      source_url: `${base}/LACoBids/BidLookUp/DownloadBidAttachFile?BidAttachIDI=${encodeURIComponent(item.AttachIDI)}&BidAttFileName=${encodeURIComponent(item.AttFileName)}`,
      retrieval: { method: 'POST_FORM', endpoint: `${base}/LACoBids/BidLookUp/DownloadBidAttachFile`, fields: { BidAttachIDI: String(item.AttachIDI), BidAttFileName: item.AttFileName } },
      original_filename: item.AttFileName,
      label: item.AttFileDesc || 'Solicitation attachment',
      declared_size: Number(item.AttFileSize || 0),
      declared_type: item.AttFileType || null,
      last_updated_at: dateFromDotNet(item.LastUpdateDate),
      document_type: classifyDocument(item.AttFileName, item.AttFileDesc || ''),
      is_addendum: false,
      is_amendment: false,
      version_label: item.AttFileNbr == null ? null : String(item.AttFileNbr)
    });
  }
  for (const item of amendments || []) {
    if (!item?.AttachIDI || !item?.AttFileName) continue;
    docs.push({
      source_url: `${base}/LACoBids/BidLookUp/DownloadAmendAttachFile?AmendAttachIDI=${encodeURIComponent(item.AttachIDI)}&AmendAttFileName=${encodeURIComponent(item.AttFileName)}`,
      retrieval: { method: 'POST_FORM', endpoint: `${base}/LACoBids/BidLookUp/DownloadAmendAttachFile`, fields: { AmendAttachIDI: String(item.AttachIDI), AmendAttFileName: item.AttFileName } },
      original_filename: item.AttFileName,
      label: item.AmendDesc || `Amendment ${txt(item.AmendNbr)}`,
      declared_size: Number(item.AttFileSize || 0),
      declared_type: item.AttFileType || null,
      last_updated_at: dateFromDotNet(item.AmendDate),
      document_type: /addendum/i.test(`${item.AttFileName} ${item.AmendDesc}`) ? 'ADDENDUM' : 'AMENDMENT',
      is_addendum: /addendum/i.test(`${item.AttFileName} ${item.AmendDesc}`),
      is_amendment: true,
      version_label: txt(item.AmendNbr) || null
    });
  }
  return { documents: docs, evidence: { resolver: 'LA_COUNTY_ECAPS_ATTACHMENT_API', bid_ref_number: bidRef, attachment_count: attachments.length, amendment_count: amendments.length, detail_url: detailResponse.url || detailUrl } };
}

async function resolveGenericManifest(raw) {
  const payload = raw.raw_payload || {};
  const manifest = Array.isArray(payload.document_manifest) ? payload.document_manifest : [];
  const urls = Array.isArray(payload.document_urls) ? payload.document_urls : [];
  const documents = (manifest.length ? manifest : urls.map(url => ({ url }))).map((item, index) => ({
    source_url: item.url || item.source_url,
    retrieval: { method: 'GET', endpoint: item.url || item.source_url },
    original_filename: item.filename || null,
    label: item.label || item.description || `Attachment ${index + 1}`,
    document_type: classifyDocument(item.filename || '', item.label || item.description || ''),
    is_addendum: /addendum/i.test(`${item.filename || ''} ${item.label || ''}`),
    is_amendment: /amendment|addendum/i.test(`${item.filename || ''} ${item.label || ''}`),
    version_label: item.version || null
  })).filter(d => d.source_url);
  return { documents, evidence: { resolver: 'GENERIC_DOCUMENT_LINKS', attachment_count: documents.length } };
}

export async function resolvePackageManifest(raw, session = {}) {
  const host = (() => { try { return new URL(raw.source_url || '').hostname; } catch { return ''; } })();
  if (/camisvr\.co\.la\.ca\.us$/i.test(host) || /Los Angeles County eCAPS/i.test(raw.raw_payload?.procurement_platform || '')) {
    return resolveLaCountyManifest(raw, session);
  }
  return resolveGenericManifest(raw);
}

async function downloadDocument(document, session) {
  const init = {};
  const url = document.retrieval?.endpoint || document.source_url;
  if (document.retrieval?.method === 'POST_FORM') {
    init.method = 'POST';
    init.headers = { 'Content-Type': 'application/x-www-form-urlencoded', Referer: document.source_url };
    init.body = new URLSearchParams(document.retrieval.fields || {}).toString();
  }
  const response = await fetchWithSession(url, session, init, 90000);
  if (!response.ok) throw new Error(`Document request failed with HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_FILE_BYTES) throw new Error(`Document exceeds ${MAX_FILE_BYTES} bytes.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_FILE_BYTES) throw new Error(`Document exceeds ${MAX_FILE_BYTES} bytes.`);
  const mime = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (/text\/html/i.test(mime)) throw new Error('Attachment download returned HTML instead of a file.');
  const filename = filenameFromHeaders(response.headers, response.url || url, document.original_filename || 'attachment');
  return { buffer, mime, filename, final_url: response.url || url };
}

async function extractFromZip(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter(e => !e.isDirectory).slice(0, 30);
  const embedded = [];
  let text = '';
  let total = 0;
  for (const entry of entries) {
    const data = entry.getData();
    total += data.length;
    if (total > 100 * 1024 * 1024) break;
    const ext = extOf(entry.entryName);
    const mime = ext === '.pdf' ? 'application/pdf' : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : ext === '.txt' || ext === '.csv' ? 'text/plain' : 'application/octet-stream';
    const extracted = await extractText(data, mime, entry.entryName, false);
    embedded.push({ filename: entry.entryName, byte_size: data.length, extraction_status: extracted.status, extracted_char_count: extracted.text.length });
    if (extracted.text) text += `\n\n### ZIP ENTRY: ${entry.entryName}\n${extracted.text}`;
    if (text.length >= MAX_TEXT_CHARS) break;
  }
  return { text: text.slice(0, MAX_TEXT_CHARS), embedded };
}

async function extractText(buffer, mime, filename, allowZip = true) {
  const ext = extOf(filename, mime);
  if (mime === 'application/pdf' || ext === '.pdf') {
    const result = await pdfParse(buffer);
    return { status: 'EXTRACTED', text: txt(result.text).slice(0, MAX_TEXT_CHARS), metadata: { pages: result.numpages || null } };
  }
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return { status: 'EXTRACTED', text: txt(result.value).slice(0, MAX_TEXT_CHARS), metadata: { messages: result.messages?.length || 0 } };
  }
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mime === 'application/vnd.ms-excel' || ['.xlsx', '.xls'].includes(ext)) {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const text = workbook.SheetNames.map(name => `### SHEET: ${name}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`).join('\n\n');
    return { status: 'EXTRACTED', text: txt(text).slice(0, MAX_TEXT_CHARS), metadata: { sheets: workbook.SheetNames } };
  }
  if (allowZip && (mime === 'application/zip' || mime === 'application/x-zip-compressed' || ext === '.zip')) {
    const result = await extractFromZip(buffer);
    return { status: result.text ? 'EXTRACTED' : 'NOT_TEXTUAL', text: result.text, metadata: { embedded_documents: result.embedded } };
  }
  if (/^text\//i.test(mime) || ['.txt', '.csv'].includes(ext)) {
    return { status: 'EXTRACTED', text: txt(buffer.toString('utf8')).slice(0, MAX_TEXT_CHARS), metadata: {} };
  }
  return { status: 'NOT_TEXTUAL', text: '', metadata: {} };
}

async function upsertDocument(db, body) {
  return db('contract_package_documents?on_conflict=raw_record_id,source_url', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(body)
  });
}

async function setRawStatus(db, rawId, values) {
  await db(`acquisition_raw_records?id=eq.${rawId}`, { method: 'PATCH', body: JSON.stringify(values) });
}

export async function processContractPackage({ db, rawRecordId }) {
  const raw = (await db(`acquisition_raw_records?id=eq.${encodeURIComponent(rawRecordId)}&select=*`))?.[0];
  if (!raw) throw new Error('Acquisition raw record not found.');
  const session = {};
  await setRawStatus(db, raw.id, { package_status: 'PACKAGE_DOWNLOADING', match_readiness_status: 'BLOCKED_PACKAGE_INCOMPLETE' });
  let resolved;
  try { resolved = await resolvePackageManifest(raw, session); }
  catch (error) {
    await setRawStatus(db, raw.id, { package_status: 'PACKAGE_FAILED', package_failed_count: 1, match_readiness_status: 'REVIEW_REQUIRED' });
    throw error;
  }
  const documents = resolved.documents || [];
  await db('aadp_document_manifests?on_conflict=acquisition_run_id,raw_record_id', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ acquisition_run_id: raw.acquisition_run_id, raw_record_id: raw.id, source_record_id: raw.source_record_id, manifest: documents, document_count: documents.length, package_status: 'PACKAGE_DISCOVERED', updated_at: now() })
  });
  if (!documents.length) {
    await setRawStatus(db, raw.id, { package_status: 'PACKAGE_PARTIAL', package_document_count: 0, package_failed_count: 0, match_readiness_status: 'REVIEW_REQUIRED' });
    return { raw_record_id: raw.id, source_record_id: raw.source_record_id, package_status: 'PACKAGE_PARTIAL', document_count: 0, reason: 'No official attachment files were returned.' };
  }

  const processed = [];
  for (const document of documents.slice(0, 50)) {
    const base = {
      acquisition_run_id: raw.acquisition_run_id,
      raw_record_id: raw.id,
      publisher_id: raw.publisher_id,
      canonical_opportunity_id: raw.canonical_opportunity_id || null,
      source_record_id: raw.source_record_id,
      source_url: document.source_url,
      original_filename: document.original_filename || null,
      document_type: document.document_type || 'OTHER',
      version_label: document.version_label || null,
      is_addendum: document.is_addendum === true,
      is_amendment: document.is_amendment === true,
      retrieval_status: 'DOWNLOADING',
      extraction_status: 'NOT_STARTED',
      retrieval_attempt_count: 1,
      metadata: { label: document.label || null, resolver: resolved.evidence, declared_size: document.declared_size || null, declared_type: document.declared_type || null, last_updated_at: document.last_updated_at || null, retrieval: document.retrieval }
    };
    await upsertDocument(db, base);
    try {
      const downloaded = await downloadDocument(document, session);
      const digest = sha256(downloaded.buffer);
      const extension = extOf(downloaded.filename, downloaded.mime);
      const storagePath = `${cleanId(raw.publisher_id)}/${cleanId(raw.source_record_id)}/${digest.slice(0, 16)}/${cleanId(downloaded.filename)}`;
      await storageUpload(BUCKET, storagePath, downloaded.buffer, downloaded.mime, true);
      const extracted = await extractText(downloaded.buffer, downloaded.mime, downloaded.filename);
      const documentType = classifyDocument(downloaded.filename, document.label || '', extracted.text);
      const body = {
        ...base,
        final_url: downloaded.final_url,
        storage_bucket: BUCKET,
        storage_path: storagePath,
        original_filename: downloaded.filename,
        document_type: documentType,
        mime_type: downloaded.mime,
        file_extension: extension,
        byte_size: downloaded.buffer.length,
        sha256: digest,
        retrieval_status: 'STORED',
        extraction_status: extracted.status,
        extracted_text: extracted.text || null,
        extracted_char_count: extracted.text.length,
        last_error: null,
        retrieved_at: now(),
        extracted_at: extracted.status === 'EXTRACTED' ? now() : null,
        metadata: { ...base.metadata, ...extracted.metadata },
        updated_at: now()
      };
      await upsertDocument(db, body);
      processed.push(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = { ...base, retrieval_status: 'FAILED', extraction_status: 'FAILED', last_error: message, updated_at: now() };
      await upsertDocument(db, failed);
      processed.push(failed);
    }
  }

  const stored = processed.filter(d => d.retrieval_status === 'STORED');
  const failed = processed.filter(d => d.retrieval_status === 'FAILED' || d.extraction_status === 'FAILED');
  const extracted = stored.filter(d => d.extraction_status === 'EXTRACTED');
  const requirements = buildRequirementsMatrix(extracted, raw.raw_payload || {});
  const packageComplete = processed.length === documents.length && failed.length === 0 && stored.length === documents.length && requirements.substantive;
  const packageStatus = packageComplete ? 'PACKAGE_COMPLETE' : stored.length ? (requirements.substantive ? 'PACKAGE_EXTRACTED' : 'PACKAGE_PARTIAL') : 'PACKAGE_FAILED';
  const requirementsStatus = requirements.substantive ? 'COMPLETE' : requirements.combined_text.length ? 'PARTIAL' : failed.length ? 'FAILED' : 'REVIEW_REQUIRED';
  const readiness = packageComplete ? 'MATCH_READY' : requirements.substantive ? 'BLOCKED_PACKAGE_INCOMPLETE' : 'BLOCKED_REQUIREMENTS_INCOMPLETE';
  const completedAt = packageComplete ? now() : null;
  const manifest = processed.map(d => ({ source_url: d.source_url, storage_bucket: d.storage_bucket || null, storage_path: d.storage_path || null, filename: d.original_filename || null, document_type: d.document_type, sha256: d.sha256 || null, byte_size: d.byte_size || null, retrieval_status: d.retrieval_status, extraction_status: d.extraction_status, version_label: d.version_label || null, is_addendum: d.is_addendum, is_amendment: d.is_amendment }));

  await db('solicitation_documents?on_conflict=opportunity_id', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      opportunity_id: raw.canonical_opportunity_id || raw.source_record_id,
      raw_record_id: raw.id,
      source_record_id: raw.source_record_id,
      raw_text: requirements.combined_text || null,
      sow_summary: requirements.matrix.scope_of_work.slice(0, 20).join('\n') || null,
      section_l: requirements.matrix.submission_requirements.slice(0, 40).join('\n') || null,
      section_m: requirements.matrix.evaluation_factors.slice(0, 40).join('\n') || null,
      requirements_matrix: requirements.matrix,
      win_theme_candidates: [],
      ingestion_status: packageComplete ? 'COMPLETE' : 'PARTIAL',
      ingested_at: requirements.combined_text ? now() : null,
      document_manifest: manifest,
      package_status: packageStatus,
      extraction_engine: 'AADP_PACKAGE_EXTRACTION_V1',
      requirements_extracted_at: requirements.combined_text ? now() : null,
      updated_at: now()
    })
  });

  await setRawStatus(db, raw.id, {
    package_status: packageStatus,
    package_document_count: documents.length,
    package_extracted_count: extracted.length,
    package_failed_count: failed.length,
    package_completed_at: completedAt,
    requirements_extracted_at: requirements.combined_text ? now() : null,
    match_readiness_status: readiness,
    processing_status: packageComplete && raw.processing_status === 'EXTRACTION_REQUIRED' ? 'RAW' : raw.processing_status
  });
  await db(`aadp_document_manifests?acquisition_run_id=eq.${raw.acquisition_run_id}&raw_record_id=eq.${raw.id}`, {
    method: 'PATCH', body: JSON.stringify({ manifest, document_count: documents.length, package_status: packageStatus, storage_document_count: stored.length, extracted_document_count: extracted.length, failed_document_count: failed.length, requirements_char_count: requirements.combined_text.length, completed_at: completedAt, updated_at: now() })
  });

  if (raw.canonical_opportunity_id) {
    const existing = (await db(`state_contract_opportunities?id=eq.${raw.canonical_opportunity_id}&select=requirements,raw_source_payload`))?.[0] || {};
    await db(`state_contract_opportunities?id=eq.${raw.canonical_opportunity_id}`, {
      method: 'PATCH', body: JSON.stringify({
        package_status: packageStatus,
        package_document_count: documents.length,
        package_extracted_count: extracted.length,
        package_failed_count: failed.length,
        requirements_extraction_status: requirementsStatus,
        match_readiness_status: readiness,
        package_manifest: manifest,
        package_completed_at: completedAt,
        package_last_checked_at: now(),
        document_urls: manifest,
        requirements: { ...(existing.requirements || {}), ...requirements.matrix, package_status: packageStatus, requirements_extraction_status: requirementsStatus },
        raw_source_payload: { ...(existing.raw_source_payload || {}), aadp_package: { status: packageStatus, document_count: documents.length, extracted_count: extracted.length, failed_count: failed.length, requirements_char_count: requirements.combined_text.length, resolver: resolved.evidence, completed_at: completedAt } },
        updated_at: now()
      })
    });
  }

  return { raw_record_id: raw.id, source_record_id: raw.source_record_id, canonical_opportunity_id: raw.canonical_opportunity_id, package_status: packageStatus, requirements_extraction_status: requirementsStatus, match_readiness_status: packageComplete ? 'MATCH_READY' : readiness, document_count: documents.length, stored_count: stored.length, extracted_count: extracted.length, failed_count: failed.length, requirements_char_count: requirements.combined_text.length, resolver: resolved.evidence };
}

export async function processPackageBatch({ db, acquisitionRunId, batchSize = 3, onRecord }) {
  const statuses = 'PACKAGE_DISCOVERED,PACKAGE_PARTIAL,PACKAGE_FAILED,PACKAGE_REVALIDATION_REQUIRED,PACKAGE_NOT_STARTED';
  const rows = await db(`acquisition_raw_records?acquisition_run_id=eq.${encodeURIComponent(acquisitionRunId)}&package_status=in.(${statuses})&select=id,source_record_id,package_status,document_manifest_count,raw_payload&order=retrieval_timestamp.asc&limit=${Math.max(1, Math.min(Number(batchSize) || 3, 10))}`) || [];
  const candidates = rows.filter(row => Number(row.document_manifest_count || 0) > 0 || Array.isArray(row.raw_payload?.document_urls));
  const results = [];
  for (const row of candidates) {
    try { results.push(await processContractPackage({ db, rawRecordId: row.id })); }
    catch (error) {
      results.push({ raw_record_id: row.id, source_record_id: row.source_record_id, package_status: 'PACKAGE_FAILED', error: error instanceof Error ? error.message : String(error) });
    }
    await onRecord?.(results[results.length - 1]);
  }
  const remainingRows = await db(`acquisition_raw_records?acquisition_run_id=eq.${encodeURIComponent(acquisitionRunId)}&package_status=in.(${statuses})&select=id,document_manifest_count,raw_payload&limit=1000`) || [];
  const remaining = remainingRows.filter(row => Number(row.document_manifest_count || 0) > 0 || Array.isArray(row.raw_payload?.document_urls)).length;
  return { processed: results.length, results, remaining };
}
