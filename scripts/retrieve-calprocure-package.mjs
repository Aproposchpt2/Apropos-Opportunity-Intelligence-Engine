import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const EVENT_ID = '0000039918';
const BUSINESS_UNIT = '8955';
const EVENT_VERSION = '2';
const SOLICITATION = '26CRC006';
const OUT = path.resolve('artifacts', SOLICITATION);
const FRONTEND_URL = `https://caleprocure.ca.gov/event/${BUSINESS_UNIT}/${EVENT_ID}`;
const LEGACY_URL = `https://caleprocure.ca.gov/psc/psfpd1/SUPPLIER/ERP/c/AUC_MANAGE_BIDS.AUC_RESP_INQ_DTL.GBL?AUC_ID=${EVENT_ID}&AUC_ROUND=1&AUC_VERSION=${EVENT_VERSION}&BIDDER_ID=BID0000001&BIDDER_LOC=1&BIDDER_SETID=STATE&BIDDER_TYPE=B&BUSINESS_UNIT=${BUSINESS_UNIT}&NoCrumbs=yes&PAGE=AUC_RESP_INQ_DTL`;

await mkdir(path.join(OUT, 'downloads'), { recursive: true });

const safe = value => String(value || 'file')
  .replace(/[^a-zA-Z0-9._-]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 180) || 'file';
const hash8 = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 8);

const network = [];
const saved = new Set();

async function saveResponse(response) {
  const url = response.url();
  const headers = await response.allHeaders().catch(() => ({}));
  const type = String(headers['content-type'] || '').toLowerCase();
  const disposition = String(headers['content-disposition'] || '');
  const interesting = /attachment|download|document|file|event-bid-comment|auc_attach|auc_file/i.test(url)
    || /application\/(pdf|zip|octet-stream|msword|vnd\.)/i.test(type)
    || /attachment/i.test(disposition);
  network.push({
    time: new Date().toISOString(),
    status: response.status(),
    method: response.request().method(),
    resource_type: response.request().resourceType(),
    url,
    content_type: type || null,
    content_disposition: disposition || null,
    interesting
  });
  if (!interesting || response.status() >= 400) return;
  const key = `${response.status()}|${url}|${disposition}`;
  if (saved.has(key)) return;
  saved.add(key);
  try {
    const body = await response.body();
    if (!body?.length || body.length > 100 * 1024 * 1024) return;
    let filename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
      || disposition.match(/filename="?([^";]+)"?/i)?.[1]
      || new URL(url).pathname.split('/').pop()
      || `response-${hash8(url)}`;
    try { filename = decodeURIComponent(filename); } catch {}
    filename = safe(filename);
    if (!/\.[a-z0-9]{2,8}$/i.test(filename)) {
      const ext = type.includes('pdf') ? '.pdf'
        : type.includes('zip') ? '.zip'
        : type.includes('wordprocessingml') ? '.docx'
        : type.includes('spreadsheetml') ? '.xlsx'
        : type.includes('msword') ? '.doc'
        : type.includes('excel') ? '.xls'
        : type.includes('json') ? '.json'
        : type.includes('html') ? '.html'
        : '.bin';
      filename += ext;
    }
    const target = path.join(OUT, 'downloads', `${hash8(url)}-${filename}`);
    await writeFile(target, body);
  } catch (error) {
    network.push({ time: new Date().toISOString(), url, save_error: error.message });
  }
}

async function snapshot(page, name) {
  await writeFile(path.join(OUT, `${name}.html`), await page.content());
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => null);
  const candidates = await page.locator('a,button,input,[role="button"],img').evaluateAll(nodes => nodes.map((node, index) => ({
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
  })).filter(item => /attach|file|download|comment|document|solicitation|bid line/i.test(`${item.text} ${item.id} ${item.name} ${item.href} ${item.src} ${item.onclick} ${item.title} ${item.alt}`)));
  await writeFile(path.join(OUT, `${name}-candidates.json`), JSON.stringify(candidates, null, 2));
  return candidates;
}

async function clickCandidates(page, phase) {
  const selector = 'a,button,input,[role="button"],img';
  const count = await page.locator(selector).count();
  let clicked = 0;
  for (let i = 0; i < count && clicked < 30; i++) {
    const node = page.locator(selector).nth(i);
    const info = await node.evaluate(el => ({
      text: (el.innerText || el.textContent || el.getAttribute('alt') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim(),
      id: el.id || '',
      name: el.getAttribute('name') || '',
      href: el.getAttribute('href') || '',
      src: el.getAttribute('src') || '',
      onclick: el.getAttribute('onclick') || '',
      title: el.getAttribute('title') || '',
      alt: el.getAttribute('alt') || ''
    })).catch(() => null);
    if (!info) continue;
    const hay = Object.values(info).join(' ');
    if (!/attach|line comments?\/files?|download|document|solicitation file|bid file/i.test(hay)) continue;
    if (/close|privacy|help|logout|clearAttachmentWrapper/i.test(hay) && !/download/i.test(hay)) continue;
    if (!(await node.isVisible().catch(() => false))) continue;
    clicked++;
    const label = safe(info.text || info.title || info.alt || info.id || `candidate-${i}`);
    try {
      const downloadPromise = page.waitForEvent('download', { timeout: 7000 }).catch(() => null);
      const popupPromise = page.waitForEvent('popup', { timeout: 7000 }).catch(() => null);
      await node.click({ timeout: 10000, force: true });
      const download = await downloadPromise;
      if (download) {
        const suggested = safe(download.suggestedFilename());
        await download.saveAs(path.join(OUT, 'downloads', `${phase}-${clicked}-${suggested}`));
      }
      const popup = await popupPromise;
      if (popup) {
        popup.on('response', saveResponse);
        await popup.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
        await writeFile(path.join(OUT, `${phase}-popup-${clicked}.html`), await popup.content()).catch(() => null);
        await popup.screenshot({ path: path.join(OUT, `${phase}-popup-${clicked}.png`), fullPage: true }).catch(() => null);
        await popup.close().catch(() => null);
      }
      await page.waitForTimeout(2500);
      await snapshot(page, `${phase}-after-${clicked}-${label.slice(0, 50)}`).catch(() => null);
    } catch (error) {
      network.push({ time: new Date().toISOString(), phase, candidate: info, click_error: error.message });
    }
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  acceptDownloads: true,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
  viewport: { width: 1600, height: 1200 }
});
context.on('page', page => page.on('response', saveResponse));
const page = await context.newPage();
page.on('response', saveResponse);
page.on('download', async download => {
  const suggested = safe(download.suggestedFilename());
  await download.saveAs(path.join(OUT, 'downloads', `${Date.now()}-${suggested}`)).catch(() => null);
});

for (const [name, url] of [['frontend', FRONTEND_URL], ['legacy', LEGACY_URL]]) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(12000);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
    await snapshot(page, name);
    await clickCandidates(page, name);
  } catch (error) {
    network.push({ time: new Date().toISOString(), phase: name, url, navigation_error: error.message });
  }
}

await writeFile(path.join(OUT, 'network.json'), JSON.stringify(network, null, 2));
await writeFile(path.join(OUT, 'cookies.json'), JSON.stringify(await context.cookies(), null, 2));
await writeFile(path.join(OUT, 'summary.json'), JSON.stringify({
  solicitation: SOLICITATION,
  event_id: EVENT_ID,
  business_unit: BUSINESS_UNIT,
  event_version: EVENT_VERSION,
  frontend_url: FRONTEND_URL,
  legacy_url: LEGACY_URL,
  captured_at: new Date().toISOString(),
  network_events: network.length,
  interesting_responses: network.filter(item => item.interesting).length,
  saved_response_keys: saved.size
}, null, 2));

await browser.close();
