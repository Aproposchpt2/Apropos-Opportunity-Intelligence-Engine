import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CALEPROCURE_HOME,
  CALEPROCURE_SEARCH,
  digest,
  isAddendum,
  relayUrl,
  safeFilename,
  verifyFile,
} from './runtime.mjs';

function waitForDownloadOrPopup(page, context, timeoutMs = 45_000) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      page.off('download', onDownload);
      context.off('page', onPopup);
      resolve(value);
    };
    const onDownload = (download) => finish({ kind: 'download', download });
    const onPopup = (popup) => finish({ kind: 'popup', popup });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    page.on('download', onDownload);
    context.on('page', onPopup);
  });
}

export async function openEvent(target, events) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1600, height: 1200 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await context.newPage();
  page.on('console', (message) => events.push({ type: 'console', level: message.type(), text: message.text() }));
  page.on('pageerror', (error) => events.push({ type: 'pageerror', message: error.message }));

  const open = async (url, waitMs) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForTimeout(waitMs);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => null);
  };

  await open(CALEPROCURE_HOME, 2_500);
  await open(CALEPROCURE_SEARCH, 4_500);
  await open(relayUrl(target), 6_500);
  await page.locator('#RESP_INQ_DL0_WK_AUC_DOWNLOAD_PB').click({ force: true, timeout: 30_000 });
  await page.waitForSelector('#PV_ATTACH_WRK_SCM_DOWNLOAD\\$0', { state: 'visible', timeout: 45_000 });
  await page.waitForTimeout(2_500);

  const names = await page.locator('[name="ViewAttachmentsFileName"]').evaluateAll((nodes) =>
    nodes.map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean),
  );

  return { browser, context, page, names };
}

export async function resetAttachmentModal(page) {
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
    document.querySelectorAll('.modal-backdrop').forEach((node) => node.remove());
  }).catch(() => null);
  await page.waitForTimeout(500);
}

export async function captureAttachment({ page, context, index, expectedName, filesDirectory }) {
  await page.locator(`#PV_ATTACH_WRK_SCM_DOWNLOAD\\$${index}`).click({ force: true, timeout: 20_000 });
  await page.waitForFunction(() => {
    const href = document.querySelector('#downloadButton')?.getAttribute('href') || '';
    return href && href !== '#' && !href.endsWith('#');
  }, { timeout: 35_000 });

  const sourceUrl = await page.locator('#downloadButton').getAttribute('href');
  const outcomePromise = waitForDownloadOrPopup(page, context);
  await page.evaluate((url) => {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, sourceUrl);

  const outcome = await outcomePromise;
  let body;
  let filename;
  let method;
  let responseContentType = null;

  if (outcome.kind === 'download') {
    filename = safeFilename(outcome.download.suggestedFilename() || expectedName);
    const localPath = path.join(filesDirectory, filename);
    await outcome.download.saveAs(localPath);
    body = await readFile(localPath);
    method = 'download-event';
  } else if (outcome.kind === 'popup') {
    const popup = outcome.popup;
    const responses = [];
    popup.on('response', (response) => responses.push(response));
    await popup.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => null);
    await popup.waitForTimeout(2_000);
    let response = responses.find((item) => /viewredirect|\.(pdf|xlsm?|xlsx|docx?|pptx?|zip)(?:$|\?)/i.test(item.url()));
    if (!response) {
      await popup.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
      await popup.waitForTimeout(1_500);
      response = responses.find((item) => /viewredirect|\.(pdf|xlsm?|xlsx|docx?|pptx?|zip)(?:$|\?)/i.test(item.url()));
    }
    if (!response) throw new Error(`POPUP_FILE_RESPONSE_NOT_CAPTURED ${popup.url()}`);
    const headers = await response.allHeaders().catch(() => ({}));
    body = await response.body();
    responseContentType = headers['content-type'] || null;
    filename = headers['content-disposition']?.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ||
      headers['content-disposition']?.match(/filename="?([^";]+)"?/i)?.[1] || expectedName;
    try { filename = decodeURIComponent(filename); } catch {}
    filename = safeFilename(filename);
    method = 'popup-response';
    await writeFile(path.join(filesDirectory, filename), body);
    await popup.close().catch(() => null);
  } else {
    throw new Error('NO_BROWSER_DOWNLOAD_OR_POPUP_WITHIN_45_SECONDS');
  }

  const integrity = verifyFile(body, filename);
  if (!integrity.valid) throw new Error(`${integrity.reason}: ${filename}`);

  return {
    body,
    record: {
      index,
      expected_name: expectedName,
      status: 'DOWNLOADED',
      method,
      filename,
      byte_size: body.length,
      sha256: digest(body),
      source_url: sourceUrl,
      content_type: responseContentType,
      integrity,
      addendum_like: isAddendum(expectedName) || isAddendum(filename),
    },
  };
}
