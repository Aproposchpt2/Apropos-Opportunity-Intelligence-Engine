import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('artifacts', '26CRC006-first-download');
await mkdir(OUT, { recursive: true });
const HOME='https://caleprocure.ca.gov/pages/index.aspx';
const SEARCH='https://caleprocure.ca.gov/psc/psfpd1_2/SUPPLIER/ERP/c/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?EOPP.SCFName=EP_SCP_BIDDINGEVENTS&EOPP.SCLabel=My+Bidding+Events&EOPP.SCName=EP_SCP_SUPPLIER_PORTAL&EOPP.SCNode=ERP&EOPP.SCPTfname=EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&FolderPath=PORTAL_ROOT_OBJECT.EP_SCP_SUPPLIER_PORTAL.EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&NoCrumbs=yes&PORTALPARAM_PTCNAV=EP_SCP_AUC_RESP_INQ_AUC&PortalRegistryName=SUPPLIER&pslnkid=EP_SCP_AUC_RESP_INQ_AUC';
const RELAY='https://caleprocure.ca.gov/PSRelay/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?Page=AUC_RESP_INQ_AUC&Action=U&BUSINESS_UNIT=8955&AUC_ID=0000039918';
const events=[];
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({acceptDownloads:true,viewport:{width:1600,height:1200},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'});
const page=await context.newPage();
page.on('response',async r=>{if(['xhr','fetch'].includes(r.request().resourceType())||/attach|download|file|comment/i.test(r.url())){const h=await r.allHeaders().catch(()=>({}));events.push({status:r.status(),method:r.request().method(),type:r.request().resourceType(),url:r.url(),contentType:h['content-type'],disposition:h['content-disposition']});}});
page.on('download',async d=>{events.push({type:'download',url:d.url(),filename:d.suggestedFilename()});await d.saveAs(path.join(OUT,d.suggestedFilename())).catch(()=>null);});
for(const [u,w] of [[HOME,3000],[SEARCH,5000],[RELAY,7000]]){await page.goto(u,{waitUntil:'domcontentloaded',timeout:120000});await page.waitForTimeout(w);}
await page.locator('#RESP_INQ_DL0_WK_AUC_DOWNLOAD_PB').click({force:true});
await page.waitForSelector('#PV_ATTACH_WRK_SCM_DOWNLOAD\\$0',{state:'visible',timeout:45000});
await page.locator('#PV_ATTACH_WRK_SCM_DOWNLOAD\\$0').click({force:true});
await page.waitForTimeout(8000);
const state=await page.evaluate(()=>({
 url:location.href,
 downloadHref:document.querySelector('#downloadButton')?.getAttribute('href')||null,
 downloadText:document.querySelector('#downloadButton')?.textContent?.trim()||null,
 wrapperHtml:document.querySelector('[data-if-label="attachmentWrapper"]')?.outerHTML||null,
 modalHtml:document.querySelector('#attachmentWrapperModal')?.outerHTML||null,
 bodyText:document.body.innerText
}));
await writeFile(path.join(OUT,'state.json'),JSON.stringify(state,null,2));
await writeFile(path.join(OUT,'events.json'),JSON.stringify(events,null,2));
await writeFile(path.join(OUT,'page.html'),await page.content());
await page.screenshot({path:path.join(OUT,'page.png'),fullPage:true}).catch(()=>null);
await browser.close();
