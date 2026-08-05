import { chromium } from 'playwright';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const TARGETS = [
  {
    label: 'DGS-25-322011-WINDOW-SYSTEMS',
    businessUnit: '7760',
    eventId: '0000039706',
    expectedTitleHint: 'Window Systems Repair'
  },
  {
    label: 'CALFIRE-7CA07976-GENERATOR',
    businessUnit: '3540',
    eventId: '7CA07976',
    expectedTitleHint: 'Generator Testing Maintenance and Inspection Services'
  },
  {
    label: 'DOJ-26-0060-AIRCRAFT',
    businessUnit: '0820',
    eventId: '0000039831',
    expectedTitleHint: 'Aircraft Maintenance and Repair'
  }
];

const ROOT = path.resolve('artifacts', 'caleprocure-multi-event-validation');
const HOME = 'https://caleprocure.ca.gov/pages/index.aspx';
const SEARCH = 'https://caleprocure.ca.gov/psc/psfpd1_2/SUPPLIER/ERP/c/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?EOPP.SCFName=EP_SCP_BIDDINGEVENTS&EOPP.SCLabel=My+Bidding+Events&EOPP.SCName=EP_SCP_SUPPLIER_PORTAL&EOPP.SCNode=ERP&EOPP.SCPTfname=EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&FolderPath=PORTAL_ROOT_OBJECT.EP_SCP_SUPPLIER_PORTAL.EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&NoCrumbs=yes&PORTALPARAM_PTCNAV=EP_SCP_AUC_RESP_INQ_AUC&PortalRegistryName=SUPPLIER&pslnkid=EP_SCP_AUC_RESP_INQ_AUC';
const MAX_SESSION_ATTEMPTS = 3;

await mkdir(ROOT, { recursive: true });

const safe = value => String(value || 'file')
  .replace(/[\\/:*?"<>|]+/g, '_')
  .replace(/\s+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 200) || 'file';
const sha256 = body => createHash('sha256').update(body).digest('hex');
const relayUrl = target => `https://caleprocure.ca.gov/PSRelay/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?Page=AUC_RESP_INQ_AUC&Action=U&BUSINESS_UNIT=${encodeURIComponent(target.businessUnit)}&AUC_ID=${encodeURIComponent(target.eventId)}`;
const isAddendumLike = name => /addend|amend|revision|revised|supplement|questions|q[&_ -]*a|notice of change/i.test(String(name || ''));

function verifyFile(body, filename) {
  const head = body.subarray(0, Math.min(body.length, 16));
  const headText = head.toString('latin1');
  const lowerHead = body.subarray(0, Math.min(body.length, 512)).toString('utf8').trim().toLowerCase();
  const ext = path.extname(filename).toLowerCase();
  if (body.length < 64) return { valid: false, reason: 'FILE_TOO_SMALL' };
  if (lowerHead.startsWith('<!doctype html') || lowerHead.startsWith('<html')) return { valid: false, reason: 'HTML_RESPONSE_INSTEAD_OF_FILE' };
  if (ext === '.pdf') {
    const tail = body.subarray(Math.max(0, body.length - 4096)).toString('latin1');
    return headText.startsWith('%PDF-') && tail.includes('%%EOF')
      ? { valid: true, signature: 'PDF' }
      : { valid: false, reason: 'INVALID_PDF_SIGNATURE' };
  }
  if (['.xlsx', '.xlsm', '.docx', '.pptx', '.zip'].includes(ext)) {
    return head[0] === 0x50 && head[1] === 0x4b
      ? { valid: true, signature: 'ZIP_CONTAINER' }
      : { valid: false, reason: 'INVALID_ZIP_CONTAINER_SIGNATURE' };
  }
  if (['.xls', '.doc', '.ppt'].includes(ext)) {
    const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    return ole.every((value, index) => head[index] === value)
      ? { valid: true, signature: 'OLE_COMPOUND_DOCUMENT' }
      : { valid: false, reason: 'INVALID_OLE_SIGNATURE' };
  }
  return { valid: true, signature: 'NON_HTML_BINARY_OR_TEXT' };
}

function waitOutcome(page, context, timeoutMs = 45000) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onDownload = download => finish({ kind: 'download', download });
    const onPage = popup => finish({ kind: 'popup', popup });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      page.off('download', onDownload);
      context.off('page', onPage);
    };
    page.on('download', onDownload);
    context.on('page', onPage);
  });
}

async function openEvent(target, events) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1600, height: 1200 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-US'
  });
  const page = await context.newPage();
  page.on('console', message => events.push({ type: 'console', level: message.type(), text: message.text() }));
  page.on('pageerror', error => events.push({ type: 'pageerror', message: error.message }));
  const open = async (url, waitMs) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(waitMs);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
  };
  await open(HOME, 2500);
  await open(SEARCH, 4500);
  await open(relayUrl(target), 6500);
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (!bodyText.toLowerCase().includes(target.expectedTitleHint.toLowerCase().slice(0, 20))) {
    events.push({ type: 'title-warning', expected: target.expectedTitleHint, observed_excerpt: bodyText.slice(0, 500) });
  }
  await page.locator('#RESP_INQ_DL0_WK_AUC_DOWNLOAD_PB').click({ force: true, timeout: 30000 });
  await page.waitForSelector('#PV_ATTACH_WRK_SCM_DOWNLOAD\\$0', { state: 'visible', timeout: 45000 });
  await page.waitForTimeout(2500);
  const names = await page.locator('[name="ViewAttachmentsFileName"]').evaluateAll(nodes => nodes
    .map(node => (node.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean));
  return { browser, context, page, names };
}

async function resetModal(page) {
  await page.evaluate(() => {
    try { clearAttachmentWrapper(); } catch {}
    const link = document.querySelector('#downloadButton');
    if (link) link.setAttribute('href', '#');
    const modal = document.querySelector('#attachmentWrapperModal');
    if (modal) {
      modal.classList.remove('show', 'in');
      modal.style.display = 'none';
      modal.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('modal-open');
    document.querySelectorAll('.modal-backdrop').forEach(node => node.remove());
  }).catch(() => null);
  await page.waitForTimeout(500);
}

async function captureAttachment({ page, context, index, expectedName, filesDir }) {
  await page.locator(`#PV_ATTACH_WRK_SCM_DOWNLOAD\\$${index}`).click({ force: true, timeout: 20000 });
  await page.waitForFunction(() => {
    const href = document.querySelector('#downloadButton')?.getAttribute('href') || '';
    return href && href !== '#' && !href.endsWith('#');
  }, { timeout: 35000 });
  const href = await page.locator('#downloadButton').getAttribute('href');
  const outcomePromise = waitOutcome(page, context, 45000);
  await page.evaluate(url => {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, href);
  const outcome = await outcomePromise;
  if (outcome.kind === 'download') {
    const download = outcome.download;
    const filename = safe(download.suggestedFilename() || expectedName);
    const targetPath = path.join(filesDir, filename);
    await download.saveAs(targetPath);
    const body = await readFile(targetPath);
    const integrity = verifyFile(body, filename);
    if (!integrity.valid) throw new Error(`${integrity.reason}: ${filename}`);
    return {
      status: 'DOWNLOADED',
      method: 'download-event',
      filename,
      byte_size: body.length,
      sha256: sha256(body),
      source_url: href,
      integrity
    };
  }
  if (outcome.kind === 'popup') {
    const popup = outcome.popup;
    const responses = [];
    popup.on('response', response => responses.push(response));
    await popup.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => null);
    await popup.waitForTimeout(2000);
    let response = responses.find(item => /viewredirect|\.(pdf|xlsm?|xlsx|docx?|zip)(?:$|\?)/i.test(item.url()));
    if (!response) {
      await popup.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      await popup.waitForTimeout(1500);
      response = responses.find(item => /viewredirect|\.(pdf|xlsm?|xlsx|docx?|zip)(?:$|\?)/i.test(item.url()));
    }
    if (!response) throw new Error(`Popup opened but file response was not captured: ${popup.url()}`);
    const headers = await response.allHeaders().catch(() => ({}));
    const body = await response.body();
    if (!body.length) throw new Error('Popup file response was empty.');
    let filename = headers['content-disposition']?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
      || headers['content-disposition']?.match(/filename="?([^";]+)"?/i)?.[1]
      || expectedName;
    try { filename = decodeURIComponent(filename); } catch {}
    filename = safe(filename);
    const integrity = verifyFile(body, filename);
    if (!integrity.valid) throw new Error(`${integrity.reason}: ${filename}`);
    await writeFile(path.join(filesDir, filename), body);
    await popup.close().catch(() => null);
    return {
      status: 'DOWNLOADED',
      method: 'popup-response',
      filename,
      byte_size: body.length,
      sha256: sha256(body),
      source_url: href,
      content_type: headers['content-type'] || null,
      integrity
    };
  }
  throw new Error('No browser download or popup event within 45 seconds.');
}

async function validateTarget(target) {
  const targetDir = path.join(ROOT, safe(target.label));
  const filesDir = path.join(targetDir, 'official-files');
  await mkdir(filesDir, { recursive: true });
  const manifest = [];
  const events = [];
  let authoritativeNames = null;
  let sessionAttempts = 0;

  while (sessionAttempts < MAX_SESSION_ATTEMPTS) {
    sessionAttempts += 1;
    let session;
    try {
      session = await openEvent(target, events);
      if (!authoritativeNames) {
        authoritativeNames = session.names;
        await writeFile(path.join(targetDir, 'rendered-file-list.json'), JSON.stringify(authoritativeNames, null, 2));
      } else if (JSON.stringify(authoritativeNames) !== JSON.stringify(session.names)) {
        events.push({ type: 'file-list-changed-on-resume', prior: authoritativeNames, current: session.names });
        authoritativeNames = session.names;
        await writeFile(path.join(targetDir, 'rendered-file-list.json'), JSON.stringify(authoritativeNames, null, 2));
      }

      for (let index = 0; index < authoritativeNames.length; index += 1) {
        const expectedName = authoritativeNames[index];
        const completed = manifest.find(item => item.index === index && item.status === 'DOWNLOADED');
        if (completed) continue;
        const record = { index, expected_name: expectedName, session_attempt: sessionAttempts, status: 'PENDING' };
        try {
          const result = await captureAttachment({
            page: session.page,
            context: session.context,
            index,
            expectedName,
            filesDir
          });
          Object.assign(record, result, { addendum_like: isAddendumLike(expectedName) || isAddendumLike(result.filename) });
          manifest.push(record);
          await writeFile(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
          await resetModal(session.page);
        } catch (error) {
          Object.assign(record, { status: 'FAILED_ATTEMPT', error: error.message });
          manifest.push(record);
          await writeFile(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
          throw error;
        }
      }
      await session.browser.close().catch(() => null);
      break;
    } catch (error) {
      events.push({ type: 'session-attempt-failed', session_attempt: sessionAttempts, error: error.message });
      await session?.browser?.close().catch(() => null);
      if (sessionAttempts >= MAX_SESSION_ATTEMPTS) break;
    }
  }

  const latestByIndex = new Map();
  for (const row of manifest) latestByIndex.set(row.index, row);
  const finalRows = [...latestByIndex.values()].sort((a, b) => a.index - b.index);
  const downloaded = finalRows.filter(row => row.status === 'DOWNLOADED');
  const failed = finalRows.filter(row => row.status !== 'DOWNLOADED');
  const summary = {
    label: target.label,
    business_unit: target.businessUnit,
    event_id: target.eventId,
    relay_url: relayUrl(target),
    official_file_count: authoritativeNames?.length || 0,
    downloaded_count: downloaded.length,
    failed_count: failed.length,
    addendum_like_count: downloaded.filter(row => row.addendum_like).length,
    total_bytes: downloaded.reduce((sum, row) => sum + Number(row.byte_size || 0), 0),
    unique_sha256_count: new Set(downloaded.map(row => row.sha256)).size,
    session_attempts: sessionAttempts,
    package_complete: Boolean(authoritativeNames?.length) && downloaded.length === authoritativeNames.length && failed.length === 0,
    completed_at: new Date().toISOString()
  };
  await writeFile(path.join(targetDir, 'manifest.json'), JSON.stringify(finalRows, null, 2));
  await writeFile(path.join(targetDir, 'events.json'), JSON.stringify(events, null, 2));
  await writeFile(path.join(targetDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

const summaries = [];
for (const target of TARGETS) {
  summaries.push(await validateTarget(target));
}

const campaign = {
  target_count: TARGETS.length,
  complete_count: summaries.filter(item => item.package_complete).length,
  incomplete_count: summaries.filter(item => !item.package_complete).length,
  official_file_count: summaries.reduce((sum, item) => sum + item.official_file_count, 0),
  downloaded_count: summaries.reduce((sum, item) => sum + item.downloaded_count, 0),
  failed_count: summaries.reduce((sum, item) => sum + item.failed_count, 0),
  addendum_like_count: summaries.reduce((sum, item) => sum + item.addendum_like_count, 0),
  total_bytes: summaries.reduce((sum, item) => sum + item.total_bytes, 0),
  session_attempts: summaries.reduce((sum, item) => sum + item.session_attempts, 0),
  summaries,
  completed_at: new Date().toISOString()
};
await writeFile(path.join(ROOT, 'campaign-summary.json'), JSON.stringify(campaign, null, 2));
if (campaign.incomplete_count > 0) process.exitCode = 1;
