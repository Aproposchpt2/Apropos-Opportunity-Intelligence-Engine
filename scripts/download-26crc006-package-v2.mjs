import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const OUT = path.resolve('artifacts', '26CRC006-package-v2');
const FILES = path.join(OUT, 'official-files');
await mkdir(FILES, { recursive: true });

const HOME = 'https://caleprocure.ca.gov/pages/index.aspx';
const SEARCH = 'https://caleprocure.ca.gov/psc/psfpd1_2/SUPPLIER/ERP/c/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?EOPP.SCFName=EP_SCP_BIDDINGEVENTS&EOPP.SCLabel=My+Bidding+Events&EOPP.SCName=EP_SCP_SUPPLIER_PORTAL&EOPP.SCNode=ERP&EOPP.SCPTfname=EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&FolderPath=PORTAL_ROOT_OBJECT.EP_SCP_SUPPLIER_PORTAL.EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&NoCrumbs=yes&PORTALPARAM_PTCNAV=EP_SCP_AUC_RESP_INQ_AUC&PortalRegistryName=SUPPLIER&pslnkid=EP_SCP_AUC_RESP_INQ_AUC';
const RELAY = 'https://caleprocure.ca.gov/PSRelay/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?Page=AUC_RESP_INQ_AUC&Action=U&BUSINESS_UNIT=8955&AUC_ID=0000039918';

const safe = value => String(value || 'file').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 200) || 'file';
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const manifest = [];
const events = [];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  acceptDownloads: true,
  viewport: { width: 1600, height: 1200 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  locale: 'en-US'
});
const page = await context.newPage();
page.on('console', message => events.push({ type: 'console', level: message.type(), text: message.text() }));
page.on('pageerror', error => events.push({ type: 'pageerror', message: error.message }));
page.on('response', async response => {
  if (/attach|download|file|comment/i.test(response.url()) || ['xhr', 'fetch'].includes(response.request().resourceType())) {
    const headers = await response.allHeaders().catch(() => ({}));
    events.push({ type: 'response', status: response.status(), method: response.request().method(), resourceType: response.request().resourceType(), url: response.url(), contentType: headers['content-type'] || null, disposition: headers['content-disposition'] || null });
  }
});

async function open(url, wait = 6000) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(wait);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null);
  events.push({ type: 'navigation', requested: url, final: page.url(), status: response?.status() || null });
}

await open(HOME, 4000);
await open(SEARCH, 7000);
await open(RELAY, 9000);
await page.locator('#RESP_INQ_DL0_WK_AUC_DOWNLOAD_PB').click({ force: true, timeout: 15000 });
await page.waitForURL(/event-bid-comments\.aspx/i, { timeout: 45000 }).catch(() => null);
await page.waitForSelector('#PV_ATTACH_WRK_SCM_DOWNLOAD\\$0', { state: 'visible', timeout: 45000 });
await page.waitForTimeout(5000);

const names = await page.locator('[name="ViewAttachmentsFileName"]').evaluateAll(nodes => nodes.map(node => (node.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean));
await writeFile(path.join(OUT, 'rendered-file-list.json'), JSON.stringify(names, null, 2));

for (let index = 0; index < names.length; index++) {
  const record = { index, expected_name: names[index], status: 'PENDING' };
  try {
    const button = page.locator(`#PV_ATTACH_WRK_SCM_DOWNLOAD\\$${index}`);
    await button.scrollIntoViewIfNeeded();
    await button.click({ force: true, timeout: 15000 });
    await page.waitForFunction(() => {
      const link = document.querySelector('#downloadButton');
      const href = link?.getAttribute('href') || '';
      return href && href !== '#' && !href.endsWith('#');
    }, { timeout: 30000 });

    const relative = await page.locator('#downloadButton').getAttribute('href');
    const url = new URL(relative, page.url()).toString();
    record.source_url = url;
    const response = await context.request.get(url, { headers: { Referer: page.url(), Accept: '*/*' }, timeout: 120000, failOnStatusCode: false });
    record.http_status = response.status();
    if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
    const body = await response.body();
    if (!body.length) throw new Error('Empty attachment response');
    const headers = response.headers();
    const disposition = headers['content-disposition'] || '';
    let filename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] || disposition.match(/filename="?([^";]+)"?/i)?.[1] || names[index];
    try { filename = decodeURIComponent(filename); } catch {}
    filename = safe(filename);
    await writeFile(path.join(FILES, filename), body);
    Object.assign(record, { status: 'DOWNLOADED', filename, byte_size: body.length, sha256: digest(body), content_type: headers['content-type'] || null, content_disposition: disposition || null });
  } catch (error) {
    record.status = 'FAILED';
    record.error = error.message;
  }
  manifest.push(record);
  await page.evaluate(() => {
    try { clearAttachmentWrapper(); } catch {}
    const modal = document.querySelector('#attachmentWrapperModal');
    if (modal) { modal.classList.remove('show'); modal.style.display = 'none'; modal.setAttribute('aria-hidden', 'true'); }
    document.body.classList.remove('modal-open');
    document.querySelectorAll('.modal-backdrop').forEach(node => node.remove());
  }).catch(() => null);
  await page.waitForTimeout(500);
}

await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(path.join(OUT, 'network-log.json'), JSON.stringify(events, null, 2));
await writeFile(path.join(OUT, 'summary.json'), JSON.stringify({
  solicitation: '26CRC006',
  official_file_count: names.length,
  downloaded_count: manifest.filter(item => item.status === 'DOWNLOADED').length,
  failed_count: manifest.filter(item => item.status === 'FAILED').length,
  total_bytes: manifest.reduce((sum, item) => sum + Number(item.byte_size || 0), 0),
  completed_at: new Date().toISOString()
}, null, 2));
await browser.close();
