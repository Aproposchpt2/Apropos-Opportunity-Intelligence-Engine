import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const out = path.resolve('artifacts', '26CRC006-fast');
const downloads = path.join(out, 'downloads');
await mkdir(downloads, { recursive: true });

const url = 'https://caleprocure.ca.gov/pages/Events-BS3/event-details.aspx?Page=AUC_RESP_INQ_DTL&Action=U&AUC_ID=0000039918&AUC_ROUND=1&BIDDER_ID=BID0000001&BIDDER_LOC=1&BIDDER_SETID=STATE&BIDDER_TYPE=B&BUSINESS_UNIT=8955';
const log = [];
const safe = value => String(value || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180) || 'file';
const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 10);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1200 } });
const page = await context.newPage();

page.on('console', message => log.push({ type: 'console', level: message.type(), text: message.text() }));
page.on('pageerror', error => log.push({ type: 'pageerror', message: error.message }));
page.on('download', async download => {
  const name = safe(download.suggestedFilename());
  await download.saveAs(path.join(downloads, `${Date.now()}-${name}`)).catch(error => log.push({ type: 'download-error', message: error.message }));
  log.push({ type: 'download', filename: name, url: download.url() });
});
page.on('response', async response => {
  const request = response.request();
  const headers = await response.allHeaders().catch(() => ({}));
  const contentType = String(headers['content-type'] || '');
  const disposition = String(headers['content-disposition'] || '');
  const entry = { type: 'response', status: response.status(), method: request.method(), resourceType: request.resourceType(), url: response.url(), contentType, disposition };
  log.push(entry);
  const interesting = ['xhr', 'fetch', 'document'].includes(request.resourceType())
    || /attach|download|file|comment|document|event/i.test(response.url())
    || /pdf|zip|octet-stream|word|excel|spreadsheet|attachment/i.test(`${contentType} ${disposition}`);
  if (!interesting || response.status() >= 400) return;
  try {
    const body = await response.body();
    if (!body.length || body.length > 100 * 1024 * 1024) return;
    const extension = contentType.includes('json') ? '.json'
      : contentType.includes('html') ? '.html'
      : contentType.includes('pdf') ? '.pdf'
      : contentType.includes('zip') ? '.zip'
      : contentType.includes('wordprocessingml') ? '.docx'
      : contentType.includes('spreadsheetml') ? '.xlsx'
      : '.bin';
    const filename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
      || disposition.match(/filename="?([^";]+)"?/i)?.[1]
      || `${request.resourceType()}-${hash(response.url())}${extension}`;
    await writeFile(path.join(downloads, `${hash(response.url())}-${safe(decodeURIComponent(filename))}`), body);
  } catch (error) {
    log.push({ type: 'response-save-error', url: response.url(), message: error.message });
  }
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(15000);
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);

async function capture(name) {
  await writeFile(path.join(out, `${name}.html`), await page.content());
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true }).catch(() => null);
  const elements = await page.locator('a,button,input,img,[role="button"],[onclick]').evaluateAll(nodes => nodes.map((node, index) => ({
    index,
    tag: node.tagName,
    text: (node.innerText || node.textContent || node.getAttribute('alt') || node.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    id: node.id || null,
    name: node.getAttribute('name'),
    href: node.getAttribute('href'),
    src: node.getAttribute('src'),
    onclick: node.getAttribute('onclick'),
    title: node.getAttribute('title'),
    alt: node.getAttribute('alt'),
    visible: !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length)
  })).filter(item => /attach|download|file|comment|document|line/i.test(JSON.stringify(item))));
  await writeFile(path.join(out, `${name}-elements.json`), JSON.stringify(elements, null, 2));
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(item => ({ name: item.name, initiatorType: item.initiatorType, duration: item.duration })));
  await writeFile(path.join(out, `${name}-resources.json`), JSON.stringify(resources, null, 2));
}

await capture('initial');

const exactTexts = [
  /line comments?\s*\/\s*files?/i,
  /bid line comment\s*\/\s*attachments?/i,
  /download attachment/i,
  /attachments?/i
];
let step = 0;
for (const pattern of exactTexts) {
  const matches = page.getByText(pattern, { exact: false });
  const count = Math.min(await matches.count(), 8);
  for (let i = 0; i < count; i++) {
    const target = matches.nth(i);
    if (!(await target.isVisible().catch(() => false))) continue;
    try {
      await target.click({ force: true, timeout: 10000 });
      await page.waitForTimeout(5000);
      step++;
      await capture(`step-${step}`);
    } catch (error) {
      log.push({ type: 'click-error', pattern: String(pattern), index: i, message: error.message });
    }
  }
}

for (const frame of page.frames()) {
  const name = safe(frame.name() || `frame-${hash(frame.url())}`);
  await writeFile(path.join(out, `${name}.html`), await frame.content()).catch(() => null);
}

await writeFile(path.join(out, 'network-log.json'), JSON.stringify(log, null, 2));
await writeFile(path.join(out, 'summary.json'), JSON.stringify({ url, captured_at: new Date().toISOString(), events: log.length, steps: step }, null, 2));
await browser.close();
