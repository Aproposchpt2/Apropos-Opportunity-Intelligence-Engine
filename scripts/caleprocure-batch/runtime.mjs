import path from 'node:path';
import { createHash } from 'node:crypto';

export const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Required Supabase runtime configuration is unavailable.');
}

export const STORAGE_BUCKET = 'solicitation-packages';
export const CALEPROCURE_HOME = 'https://caleprocure.ca.gov/pages/index.aspx';
export const CALEPROCURE_SEARCH = 'https://caleprocure.ca.gov/psc/psfpd1_2/SUPPLIER/ERP/c/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?EOPP.SCFName=EP_SCP_BIDDINGEVENTS&EOPP.SCLabel=My+Bidding+Events&EOPP.SCName=EP_SCP_SUPPLIER_PORTAL&EOPP.SCNode=ERP&EOPP.SCPTfname=EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&FolderPath=PORTAL_ROOT_OBJECT.EP_SCP_SUPPLIER_PORTAL.EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&NoCrumbs=yes&PORTALPARAM_PTCNAV=EP_SCP_AUC_RESP_INQ_AUC&PortalRegistryName=SUPPLIER&pslnkid=EP_SCP_AUC_RESP_INQ_AUC';
const requestedTarget = Number(process.env.TARGET_COMPLETIONS || 5);
export const TARGET_COMPLETIONS = Number.isFinite(requestedTarget)
  ? Math.max(1, Math.min(Math.trunc(requestedTarget), 5))
  : 5;
export const TARGET_SOURCE_RECORD_ID = String(process.env.TARGET_SOURCE_RECORD_ID || '').trim() || null;
export const MAX_SESSION_ATTEMPTS = 3;
export const CANDIDATE_POOL_LIMIT = 30;
export const ARTIFACT_ROOT = path.resolve('artifacts', 'caleprocure-package-batch');
export const BATCH_ID = `caleprocure-batch-${process.env.GITHUB_RUN_ID || Date.now()}-${process.env.GITHUB_RUN_ATTEMPT || 1}`;

export const authHeaders = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
};

export const now = () => new Date().toISOString();
export const encode = encodeURIComponent;
export const digest = (body) => createHash('sha256').update(body).digest('hex');
export const safeFilename = (value) => String(value || 'file')
  .replace(/[\\/:*?"<>|]+/g, '_')
  .replace(/\s+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 200) || 'file';
export const isAddendum = (name) => /addend|amend|revision|revised|supplement|questions|q[&_ -]*a|notice of change/i.test(String(name || ''));

export async function rest(table, method = 'GET', body = null, query = '') {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method,
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
      Prefer: 'return=representation,resolution=merge-duplicates',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${table} ${method} ${response.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}

export function parseIdentifiers(record) {
  const value = String(record.source_record_id || '').trim();
  const businessUnitFromUrl = value.match(/[?&](?:BUSINESS_UNIT|business_unit)=([^&#]+)/i)?.[1];
  const eventIdFromUrl = value.match(/[?&](?:AUC_ID|auc_id)=([^&#]+)/i)?.[1];
  if (businessUnitFromUrl && eventIdFromUrl) {
    return {
      businessUnit: decodeURIComponent(businessUnitFromUrl),
      eventId: decodeURIComponent(eventIdFromUrl),
    };
  }
  const match = value.match(/(?:^|[^A-Za-z0-9])([A-Za-z0-9]{3,12})\s*[:|/]\s*([A-Za-z0-9-]{4,30})(?:$|[^A-Za-z0-9-])/);
  return match ? { businessUnit: match[1], eventId: match[2] } : null;
}

export async function loadCandidatePool() {
  const targetFilter = TARGET_SOURCE_RECORD_ID
    ? `&source_record_id=eq.${encode(TARGET_SOURCE_RECORD_ID)}`
    : '';
  const query = '?source_platform=eq.caleprocure' +
    '&is_latest_version=eq.true' +
    '&status=eq.open' +
    '&or=(package_status.is.null,package_status.in.(PACKAGE_NOT_STARTED,PACKAGE_DISCOVERED,PACKAGE_DOWNLOADING,PACKAGE_PARTIAL,PACKAGE_EXTRACTED))' +
    '&id=not.is.null' +
    '&source_record_id=not.is.null' +
    targetFilter +
    '&select=id,source_record_id,response_deadline,title,package_status' +
    `&order=response_deadline.asc.nullslast,source_record_id.asc&limit=${CANDIDATE_POOL_LIMIT}`;
  const rows = await rest('state_contract_opportunities', 'GET', null, query);
  const candidates = [];
  for (const row of rows) {
    const identifiers = parseIdentifiers(row);
    if (identifiers) candidates.push({ ...row, ...identifiers });
  }
  if (TARGET_SOURCE_RECORD_ID && candidates.length !== 1) {
    throw new Error(`TARGET_SOURCE_RECORD_NOT_ELIGIBLE ${TARGET_SOURCE_RECORD_ID}`);
  }
  if (candidates.length < TARGET_COMPLETIONS) {
    throw new Error(`ELIGIBLE_RESOLVABLE_TARGET_COUNT ${candidates.length}/${TARGET_COMPLETIONS}`);
  }
  return candidates;
}

export const relayUrl = (target) => `https://caleprocure.ca.gov/PSRelay/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?Page=AUC_RESP_INQ_AUC&Action=U&BUSINESS_UNIT=${encode(target.businessUnit)}&AUC_ID=${encode(target.eventId)}`;

export function verifyFile(body, filename) {
  const head = body.subarray(0, 16);
  const headText = head.toString('latin1');
  const initialText = body.subarray(0, 512).toString('utf8').trim().toLowerCase();
  const extension = path.extname(filename).toLowerCase();
  if (body.length < 64) return { valid: false, reason: 'FILE_TOO_SMALL' };
  if (initialText.startsWith('<!doctype html') || initialText.startsWith('<html')) return { valid: false, reason: 'HTML_RESPONSE_INSTEAD_OF_FILE' };
  if (extension === '.pdf') {
    const tail = body.subarray(Math.max(0, body.length - 4096)).toString('latin1');
    return headText.startsWith('%PDF-') && tail.includes('%%EOF') ? { valid: true, signature: 'PDF' } : { valid: false, reason: 'INVALID_PDF_SIGNATURE' };
  }
  if (['.xlsx', '.xlsm', '.docx', '.pptx', '.zip'].includes(extension)) {
    return head[0] === 0x50 && head[1] === 0x4b ? { valid: true, signature: 'ZIP_CONTAINER' } : { valid: false, reason: 'INVALID_ZIP_CONTAINER_SIGNATURE' };
  }
  if (['.xls', '.doc', '.ppt'].includes(extension)) {
    const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    return ole.every((value, index) => head[index] === value) ? { valid: true, signature: 'OLE_COMPOUND_DOCUMENT' } : { valid: false, reason: 'INVALID_OLE_SIGNATURE' };
  }
  return { valid: true, signature: 'NON_HTML_BINARY_OR_TEXT' };
}

export function contentType(filename) {
  const types = {
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.zip': 'application/zip',
    '.txt': 'text/plain',
  };
  return types[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

export async function uploadAndVerify(storagePath, body, type) {
  const endpoint = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath.split('/').map(encode).join('/')}`;
  const upload = await fetch(endpoint, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': type, 'x-upsert': 'false' },
    body,
  });
  if (!upload.ok && upload.status !== 409) throw new Error(`STORAGE_UPLOAD_${upload.status}: ${await upload.text()}`);
  const confirmation = await fetch(endpoint, { headers: authHeaders });
  if (!confirmation.ok) throw new Error(`STORAGE_CONFIRM_${confirmation.status}: ${await confirmation.text()}`);
  const storedBody = Buffer.from(await confirmation.arrayBuffer());
  if (storedBody.length !== body.length || digest(storedBody) !== digest(body)) throw new Error(`STORAGE_OBJECT_INTEGRITY_CONFLICT ${storagePath}`);
}