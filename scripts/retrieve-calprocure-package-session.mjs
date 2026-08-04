import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const EVENT_ID = '0000039918';
const BUSINESS_UNIT = '8955';
const SOLICITATION = '26CRC006';
const OUT = path.resolve('artifacts', `${SOLICITATION}-session`);
const DOWNLOADS = path.join(OUT, 'downloads');
await mkdir(DOWNLOADS, { recursive: true });

const HOME = 'https://caleprocure.ca.gov/pages/index.aspx';
const SEARCH = 'https://caleprocure.ca.gov/psc/psfpd1_2/SUPPLIER/ERP/c/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?EOPP.SCFName=EP_SCP_BIDDINGEVENTS&EOPP.SCLabel=My+Bidding+Events&EOPP.SCName=EP_SCP_SUPPLIER_PORTAL&EOPP.SCNode=ERP&EOPP.SCPTfname=EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&FolderPath=PORTAL_ROOT_OBJECT.EP_SCP_SUPPLIER_PORTAL.EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&NoCrumbs=yes&PORTALPARAM_PTCNAV=EP_SCP_AUC_RESP_INQ_AUC&PortalRegistryName=SUPPLIER&pslnkid=EP_SCP_AUC_RESP_INQ_AUC';
const RELAY = `https://caleprocure.ca.gov/PSRelay/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?Page=AUC_RESP_INQ_AUC&Action=U&BUSINESS_UNIT=${BUSINESS_UNIT}&AUC_ID=${EVENT_ID}`;

const safe = value => String(value || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 180) || 'file';
const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
const log = [];
const saved = new Set();

function extension(type = '', url = '') {
  const pathname = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
  const match = pathname.match(/\.([a-z0-9]{2,8})$/i);
  if (match) return `.${match[1]}`;
  const value = type.toLowerCase();
  if (value.includes('pdf')) return '.pdf';
  if (value.includes('zip')) return '.zip';
  if (value.includes('wordprocessingml')) return '.docx';
  if (value.includes('spreadsheetml')) return '.xlsx';
  if (value.includes('msword')) return '.doc';
  if (value.includes('excel')) return '.xls';
  if (value.includes('json')) return '.json';
  if (value.includes('html')) return '.html';
  return '.bin';
}

async function saveResponse(response) {
  const request = response.request();
  const headers = await response.allHeaders().catch(() => ({}));
  const contentType = String(headers['content-type'] || '');
  const disposition = String(headers['content-disposition'] || '');
  const url = response.url();
  const interesting = ['xhr', 'fetch'].includes(request.resourceType())
    || /attach|download|file|comment|document|event-bid|auc_/i.test(url)
    || /pdf|zip|octet-stream|word|excel|spreadsheet|attachment/i.test(`${contentType} ${disposition}`);
  log.push({ type: 'response', status: response.status(), method: request.method(), resourceType: request.resourceType(), url, contentType, disposition, interesting });
  if (!interesting || response.status() >= 400) return;
  const key = `${response.status()}|${url}|${disposition}`;
  if (saved.has(key)) return;
  saved.add(key);
  try {
    const body = await response.body();
    if (!body.length || body.length > 100 * 1024 * 1024) return;
    let filename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
      || disposition.match(/filename="?([^";]+)"?/i)?.[1]
      || `${request.resourceType()}-${hash(url)}${extension(contentType, url)}`;
    try { filename = decodeURIComponent(filename); } catch {}
    filename = safe(filename);
    if (!/\.[a-z0-9]{2,8}$/i.test(filename)) filename += extension(contentType, url);
    await writeFile(path.join(DOWNLOADS, `${hash(url)}-${filename}`), body);
  } catch (error) {
    log.push({ type: 'save-error', url, message: error.message });
  }
}

async function capture(page, name) {
  await writeFile(path.join(OUT, `${name}.html`), await page.content());
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => null);
  const elements = await page.locator('a,button,input,img,[role="button"],[onclick]').evaluateAll(nodes => nodes.map((node, index) => ({
    index,
    tag: node.tagName,
    text: (node.innerText || node.textContent || node.getAttribute('alt') || node.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    id: node.id || null,
    name: node.getAttribute('name'),
    href: node.getAttribute('href'),
    src: node.getAttribute('src'),
    onclick: node.getAttribute('onclick'),
    title: node.getAttribute('title'),
    alt: node.getAttribute('alt'),
    visible: !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length)
  })).filter(item => /attach|download|file|comment|document|line/i.test(JSON.stringify(item))));
  await writeFile(path.join(OUT, `${name}-elements.json`), JSON.stringify(elements, null, 2));
  const bodyText = await page.locator('body').innerText().catch(() => '');
  await writeFile(path.join(OUT, `${name}-text.txt`), bodyText);
  return elements;
}

async function navigate(page, name, url, waitMs = 7000) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(error => {
    log.push({ type: 'navigation-error', name, url, message: error.message });
    return null;
  });
  await page.waitForTimeout(waitMs);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null);
  log.push({ type: 'navigation', name, requested: url, final: page.url(), status: response?.status() || null, title: await page.title().catch(() => null) });
  return capture(page, name);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  acceptDownloads: true,
  viewport: { width: 1600, height: 1200 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  locale: 'en-US',
  extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
});
const page = await context.newPage();
page.on('response', saveResponse);
page.on('console', message => log.push({ type: 'console', level: message.type(), text: message.text() }));
page.on('pageerror', error => log.push({ type: 'pageerror', message: error.message }));
page.on('download', async download => {
  const filename = safe(download.suggestedFilename());
  await download.saveAs(path.join(DOWNLOADS, `${Date.now()}-${filename}`)).catch(error => log.push({ type: 'download-error', message: error.message }));
  log.push({ type: 'download', filename, url: download.url() });
});

await navigate(page, '01-home', HOME, 5000);
await navigate(page, '02-search-session', SEARCH, 8000);
const relayElements = await navigate(page, '03-event-details', RELAY, 10000);

const candidates = relayElements.filter(item => item.visible && /attach|download|line comments?\s*\/\s*files?|bid comments?|document/i.test(JSON.stringify(item)));
let clicked = 0;
for (const candidate of candidates.slice(0, 12)) {
  const locator = page.locator('a,button,input,img,[role="button"],[onclick]').nth(candidate.index);
  if (!(await locator.isVisible().catch(() => false))) continue;
  try {
    const downloadPromise = page.waitForEvent('download', { timeout: 6000 }).catch(() => null);
    const popupPromise = page.waitForEvent('popup', { timeout: 6000 }).catch(() => null);
    await locator.click({ force: true, timeout: 10000 });
    const download = await downloadPromise;
    if (download) await download.saveAs(path.join(DOWNLOADS, `${Date.now()}-${safe(download.suggestedFilename())}`));
    const popup = await popupPromise;
    if (popup) {
      popup.on('response', saveResponse);
      await popup.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => null);
      await popup.waitForTimeout(5000);
      await capture(popup, `04-popup-${clicked + 1}`).catch(() => null);
      await popup.close().catch(() => null);
    }
    await page.waitForTimeout(5000);
    clicked++;
    await capture(page, `04-after-click-${clicked}`);
  } catch (error) {
    log.push({ type: 'click-error', candidate, message: error.message });
  }
}

const frames = [];
for (const frame of page.frames()) {
  frames.push({ name: frame.name(), url: frame.url() });
  await writeFile(path.join(OUT, `frame-${hash(frame.url())}.html`), await frame.content()).catch(() => null);
}

await writeFile(path.join(OUT, 'cookies.json'), JSON.stringify(await context.cookies(), null, 2));
await writeFile(path.join(OUT, 'frames.json'), JSON.stringify(frames, null, 2));
await writeFile(path.join(OUT, 'network-log.json'), JSON.stringify(log, null, 2));
await writeFile(path.join(OUT, 'summary.json'), JSON.stringify({
  solicitation: SOLICITATION,
  event_id: EVENT_ID,
  business_unit: BUSINESS_UNIT,
  final_url: page.url(),
  clicked,
  captured_responses: saved.size,
  completed_at: new Date().toISOString()
}, null, 2));
await browser.close();
