import { chromium } from 'playwright';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const EVENT_ID = '0000039918';
const BUSINESS_UNIT = '8955';
const SOLICITATION = '26CRC006';
const OUT = path.resolve('artifacts', `${SOLICITATION}-package`);
const DOWNLOADS = path.join(OUT, 'official-files');
await mkdir(DOWNLOADS, { recursive: true });

const HOME = 'https://caleprocure.ca.gov/pages/index.aspx';
const SEARCH = 'https://caleprocure.ca.gov/psc/psfpd1_2/SUPPLIER/ERP/c/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?EOPP.SCFName=EP_SCP_BIDDINGEVENTS&EOPP.SCLabel=My+Bidding+Events&EOPP.SCName=EP_SCP_SUPPLIER_PORTAL&EOPP.SCNode=ERP&EOPP.SCPTfname=EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&FolderPath=PORTAL_ROOT_OBJECT.EP_SCP_SUPPLIER_PORTAL.EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&NoCrumbs=yes&PORTALPARAM_PTCNAV=EP_SCP_AUC_RESP_INQ_AUC&PortalRegistryName=SUPPLIER&pslnkid=EP_SCP_AUC_RESP_INQ_AUC';
const RELAY = `https://caleprocure.ca.gov/PSRelay/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?Page=AUC_RESP_INQ_AUC&Action=U&BUSINESS_UNIT=${BUSINESS_UNIT}&AUC_ID=${EVENT_ID}`;

const safe = value => String(value || 'file').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 200) || 'file';
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const log = [];
const manifest = [];

async function goto(page, url, waitMs = 6000) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(waitMs);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null);
  log.push({ type: 'navigation', requested: url, final: page.url(), status: response?.status() || null, title: await page.title().catch(() => null) });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  acceptDownloads: true,
  viewport: { width: 1600, height: 1200 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  locale: 'en-US'
});
const page = await context.newPage();
page.on('console', message => log.push({ type: 'console', level: message.type(), text: message.text() }));
page.on('pageerror', error => log.push({ type: 'pageerror', message: error.message }));
page.on('response', async response => {
  const request = response.request();
  if (['xhr', 'fetch'].includes(request.resourceType()) || /attach|download|file|comment/i.test(response.url())) {
    const headers = await response.allHeaders().catch(() => ({}));
    log.push({ type: 'response', status: response.status(), method: request.method(), resourceType: request.resourceType(), url: response.url(), contentType: headers['content-type'] || null, disposition: headers['content-disposition'] || null });
  }
});

await goto(page, HOME, 4000);
await goto(page, SEARCH, 7000);
await goto(page, RELAY, 9000);

await page.locator('#RESP_INQ_DL0_WK_AUC_DOWNLOAD_PB').click({ force: true, timeout: 15000 });
await page.waitForURL(/event-bid-comments\.aspx/i, { timeout: 45000 }).catch(() => null);
await page.waitForTimeout(8000);
await page.waitForSelector('#PV_ATTACH_WRK_SCM_DOWNLOAD\\$0', { state: 'visible', timeout: 45000 });

const fileNames = await page.locator("span[id^='PV_ATTACH_WRK_ATTACHUSERFILE$']").evaluateAll(nodes => nodes.map(node => (node.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean));
await writeFile(path.join(OUT, 'rendered-file-list.json'), JSON.stringify(fileNames, null, 2));

for (let index = 0; index < fileNames.length; index++) {
  const expectedName = safe(fileNames[index]);
  const button = page.locator(`#PV_ATTACH_WRK_SCM_DOWNLOAD\\$${index}`);
  const row = { index, expected_name: fileNames[index], status: 'PENDING' };
  try {
    await button.scrollIntoViewIfNeeded();
    await button.click({ force: true, timeout: 15000 });
    await page.waitForTimeout(2000);
    await page.waitForFunction(() => {
      const link = document.querySelector('#downloadButton');
      const href = link?.getAttribute('href') || '';
      return href && href !== '#' && !href.endsWith('#');
    }, { timeout: 30000 });

    const href = await page.locator('#downloadButton').getAttribute('href');
    if (!href) throw new Error('Attachment download URL was not generated.');
    const absoluteUrl = new URL(href, page.url()).toString();
    row.source_url = absoluteUrl;

    const response = await context.request.get(absoluteUrl, {
      headers: { Referer: page.url(), Accept: '*/*' },
      timeout: 120000,
      failOnStatusCode: false
    });
    row.http_status = response.status();
    if (!response.ok()) throw new Error(`Attachment HTTP ${response.status()}`);
    const body = await response.body();
    if (!body.length) throw new Error('Attachment response was empty.');
    const headers = response.headers();
    const disposition = headers['content-disposition'] || '';
    let filename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
      || disposition.match(/filename="?([^";]+)"?/i)?.[1]
      || expectedName;
    try { filename = decodeURIComponent(filename); } catch {}
    filename = safe(filename);
    const target = path.join(DOWNLOADS, filename);
    await writeFile(target, body);
    row.status = 'DOWNLOADED';
    row.filename = filename;
    row.byte_size = body.length;
    row.sha256 = sha256(body);
    row.content_type = headers['content-type'] || null;
    row.content_disposition = disposition || null;
    manifest.push(row);

    await page.evaluate(() => {
      try { clearAttachmentWrapper(); } catch {}
      const modal = document.querySelector('#attachmentWrapperModal');
      if (modal) {
        modal.classList.remove('show');
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
      }
      document.body.classList.remove('modal-open');
      document.querySelectorAll('.modal-backdrop').forEach(node => node.remove());
    });
    await page.waitForTimeout(500);
  } catch (error) {
    row.status = 'FAILED';
    row.error = error.message;
    manifest.push(row);
    log.push({ type: 'attachment-error', ...row });
    await page.keyboard.press('Escape').catch(() => null);
    await page.waitForTimeout(1000);
  }
}

for (const item of manifest.filter(item => item.status === 'DOWNLOADED')) {
  const metadata = await stat(path.join(DOWNLOADS, item.filename));
  item.byte_size = metadata.size;
}

await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(path.join(OUT, 'network-log.json'), JSON.stringify(log, null, 2));
await writeFile(path.join(OUT, 'final-page.html'), await page.content());
await page.screenshot({ path: path.join(OUT, 'final-page.png'), fullPage: true }).catch(() => null);
await writeFile(path.join(OUT, 'summary.json'), JSON.stringify({
  solicitation: SOLICITATION,
  event_id: EVENT_ID,
  business_unit: BUSINESS_UNIT,
  official_file_count: fileNames.length,
  downloaded_count: manifest.filter(item => item.status === 'DOWNLOADED').length,
  failed_count: manifest.filter(item => item.status === 'FAILED').length,
  total_bytes: manifest.reduce((sum, item) => sum + Number(item.byte_size || 0), 0),
  completed_at: new Date().toISOString()
}, null, 2));
await browser.close();
