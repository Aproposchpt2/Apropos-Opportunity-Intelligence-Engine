import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const OUT = path.resolve('artifacts', '26CRC006-package-v3');
const FILES = path.join(OUT, 'official-files');
await mkdir(FILES, { recursive: true });
const HOME='https://caleprocure.ca.gov/pages/index.aspx';
const SEARCH='https://caleprocure.ca.gov/psc/psfpd1_2/SUPPLIER/ERP/c/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?EOPP.SCFName=EP_SCP_BIDDINGEVENTS&EOPP.SCLabel=My+Bidding+Events&EOPP.SCName=EP_SCP_SUPPLIER_PORTAL&EOPP.SCNode=ERP&EOPP.SCPTfname=EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&FolderPath=PORTAL_ROOT_OBJECT.EP_SCP_SUPPLIER_PORTAL.EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&NoCrumbs=yes&PORTALPARAM_PTCNAV=EP_SCP_AUC_RESP_INQ_AUC&PortalRegistryName=SUPPLIER&pslnkid=EP_SCP_AUC_RESP_INQ_AUC';
const RELAY='https://caleprocure.ca.gov/PSRelay/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?Page=AUC_RESP_INQ_AUC&Action=U&BUSINESS_UNIT=8955&AUC_ID=0000039918';
const safe=v=>String(v||'file').replace(/[\\/:*?"<>|]+/g,'_').replace(/\s+/g,'_').replace(/^_+|_+$/g,'').slice(0,200)||'file';
const sha=b=>createHash('sha256').update(b).digest('hex');
const manifest=[];

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1600,height:1200},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',locale:'en-US'});
const page=await context.newPage();
async function open(url,wait){await page.goto(url,{waitUntil:'domcontentloaded',timeout:120000});await page.waitForTimeout(wait);await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>null);}
await open(HOME,3000);await open(SEARCH,5000);await open(RELAY,7000);
await page.locator('#RESP_INQ_DL0_WK_AUC_DOWNLOAD_PB').click({force:true});
await page.waitForSelector('#PV_ATTACH_WRK_SCM_DOWNLOAD\\$0',{state:'visible',timeout:45000});
await page.waitForTimeout(4000);
const names=await page.locator('[name="ViewAttachmentsFileName"]').evaluateAll(nodes=>nodes.map(n=>(n.textContent||'').replace(/\s+/g,' ').trim()).filter(Boolean));
await writeFile(path.join(OUT,'rendered-file-list.json'),JSON.stringify(names,null,2));

let previousHref='';
for(let index=0;index<names.length;index++){
  const item={index,expected_name:names[index],status:'PENDING'};
  try{
    await page.locator(`#PV_ATTACH_WRK_SCM_DOWNLOAD\\$${index}`).click({force:true,timeout:15000});
    await page.waitForFunction(prev=>{
      const href=document.querySelector('#downloadButton')?.getAttribute('href')||'';
      return href && href!=='#' && !href.endsWith('#') && href!==prev;
    },previousHref,{timeout:30000});
    const href=await page.locator('#downloadButton').getAttribute('href');
    previousHref=href||previousHref;
    const result=await page.evaluate(async url=>{
      const response=await fetch(url,{credentials:'include',redirect:'follow',headers:{Accept:'*/*'}});
      const buffer=new Uint8Array(await response.arrayBuffer());
      let binary='';
      const step=0x8000;
      for(let i=0;i<buffer.length;i+=step) binary+=String.fromCharCode(...buffer.subarray(i,Math.min(i+step,buffer.length)));
      return {status:response.status,ok:response.ok,url:response.url,contentType:response.headers.get('content-type'),disposition:response.headers.get('content-disposition'),base64:btoa(binary)};
    },href);
    item.http_status=result.status;item.source_url=href;item.final_url=result.url;
    if(!result.ok) throw new Error(`HTTP ${result.status}`);
    const body=Buffer.from(result.base64,'base64');
    if(!body.length) throw new Error('Empty response');
    let filename=result.disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]||result.disposition?.match(/filename="?([^";]+)"?/i)?.[1]||names[index];
    try{filename=decodeURIComponent(filename);}catch{}
    filename=safe(filename);
    await writeFile(path.join(FILES,filename),body);
    Object.assign(item,{status:'DOWNLOADED',filename,byte_size:body.length,sha256:sha(body),content_type:result.contentType,content_disposition:result.disposition});
  }catch(error){item.status='FAILED';item.error=error.message;}
  manifest.push(item);
  await page.evaluate(()=>{
    try{clearAttachmentWrapper();}catch{}
    const link=document.querySelector('#downloadButton');if(link)link.setAttribute('href','#');
    const modal=document.querySelector('#attachmentWrapperModal');if(modal){modal.classList.remove('show','in');modal.style.display='none';modal.setAttribute('aria-hidden','true');}
    document.body.classList.remove('modal-open');document.querySelectorAll('.modal-backdrop').forEach(n=>n.remove());
  }).catch(()=>null);
  await page.waitForTimeout(400);
}
await writeFile(path.join(OUT,'manifest.json'),JSON.stringify(manifest,null,2));
await writeFile(path.join(OUT,'summary.json'),JSON.stringify({solicitation:'26CRC006',official_file_count:names.length,downloaded_count:manifest.filter(x=>x.status==='DOWNLOADED').length,failed_count:manifest.filter(x=>x.status==='FAILED').length,total_bytes:manifest.reduce((s,x)=>s+Number(x.byte_size||0),0),completed_at:new Date().toISOString()},null,2));
await browser.close();
