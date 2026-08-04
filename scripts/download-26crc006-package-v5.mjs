import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const OUT = path.resolve('artifacts', '26CRC006-package-v5');
const FILES = path.join(OUT, 'official-files');
await mkdir(FILES, { recursive: true });
const HOME='https://caleprocure.ca.gov/pages/index.aspx';
const SEARCH='https://caleprocure.ca.gov/psc/psfpd1_2/SUPPLIER/ERP/c/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?EOPP.SCFName=EP_SCP_BIDDINGEVENTS&EOPP.SCLabel=My+Bidding+Events&EOPP.SCName=EP_SCP_SUPPLIER_PORTAL&EOPP.SCNode=ERP&EOPP.SCPTfname=EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&FolderPath=PORTAL_ROOT_OBJECT.EP_SCP_SUPPLIER_PORTAL.EP_SCP_BIDDINGEVENTS&EOPP.SCPortal=SUPPLIER&EOPP.SCSecondary=true&NoCrumbs=yes&PORTALPARAM_PTCNAV=EP_SCP_AUC_RESP_INQ_AUC&PortalRegistryName=SUPPLIER&pslnkid=EP_SCP_AUC_RESP_INQ_AUC';
const RELAY='https://caleprocure.ca.gov/PSRelay/AUC_MANAGE_BIDS.AUC_RESP_INQ_AUC.GBL?Page=AUC_RESP_INQ_AUC&Action=U&BUSINESS_UNIT=8955&AUC_ID=0000039918';
const safe=v=>String(v||'file').replace(/[\\/:*?"<>|]+/g,'_').replace(/\s+/g,'_').replace(/^_+|_+$/g,'').slice(0,200)||'file';
const sha=b=>createHash('sha256').update(b).digest('hex');
const manifest=[];
const events=[];

function waitForBrowserOutcome(page, context, timeoutMs=20000){
  return new Promise(resolve=>{
    let settled=false;
    const finish=value=>{if(settled)return;settled=true;cleanup();resolve(value);};
    const onDownload=download=>finish({kind:'download',download});
    const onPage=popup=>finish({kind:'popup',popup});
    const timer=setTimeout(()=>finish({kind:'timeout'}),timeoutMs);
    const cleanup=()=>{clearTimeout(timer);page.off('download',onDownload);context.off('page',onPage);};
    page.on('download',onDownload);
    context.on('page',onPage);
  });
}

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({acceptDownloads:true,viewport:{width:1600,height:1200},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',locale:'en-US'});
const page=await context.newPage();
page.on('console',m=>events.push({type:'console',level:m.type(),text:m.text()}));
page.on('pageerror',e=>events.push({type:'pageerror',message:e.message}));
async function open(url,wait){await page.goto(url,{waitUntil:'domcontentloaded',timeout:120000});await page.waitForTimeout(wait);await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>null);}
await open(HOME,2500);await open(SEARCH,4500);await open(RELAY,6500);
await page.locator('#RESP_INQ_DL0_WK_AUC_DOWNLOAD_PB').click({force:true});
await page.waitForSelector('#PV_ATTACH_WRK_SCM_DOWNLOAD\\$0',{state:'visible',timeout:45000});
await page.waitForTimeout(3000);
const names=await page.locator('[name="ViewAttachmentsFileName"]').evaluateAll(ns=>ns.map(n=>(n.textContent||'').replace(/\s+/g,' ').trim()).filter(Boolean));
await writeFile(path.join(OUT,'rendered-file-list.json'),JSON.stringify(names,null,2));

for(let index=0;index<names.length;index++){
  const record={index,expected_name:names[index],status:'PENDING'};
  try{
    await page.locator(`#PV_ATTACH_WRK_SCM_DOWNLOAD\\$${index}`).click({force:true,timeout:15000});
    await page.waitForFunction(()=>{const a=document.querySelector('#downloadButton');const h=a?.getAttribute('href')||'';return h&&h!=='#'&&!h.endsWith('#');},{timeout:30000});
    record.source_url=await page.locator('#downloadButton').getAttribute('href');
    const outcomePromise=waitForBrowserOutcome(page,context,20000);
    await page.locator('#downloadButton').click({force:true,timeout:15000});
    const outcome=await outcomePromise;

    if(outcome.kind==='download'){
      const download=outcome.download;
      const filename=safe(download.suggestedFilename()||names[index]);
      const target=path.join(FILES,filename);
      await download.saveAs(target);
      const body=await readFile(target);
      Object.assign(record,{status:'DOWNLOADED',method:'download-event',filename,byte_size:body.length,sha256:sha(body),failure:await download.failure()});
    }else if(outcome.kind==='popup'){
      const popup=outcome.popup;
      let captured=null;
      popup.on('response',async response=>{
        if(captured)return;
        if(/viewredirect|\.pdf|\.xlsm/i.test(response.url())){
          try{captured={response,headers:await response.allHeaders(),body:await response.body()};}catch{}
        }
      });
      await popup.waitForLoadState('domcontentloaded',{timeout:30000}).catch(()=>null);
      await popup.waitForTimeout(3000);
      if(!captured){
        const current=popup.url();
        const response=await context.request.get(current,{headers:{Referer:page.url()},timeout:30000,failOnStatusCode:false}).catch(()=>null);
        if(response?.ok()) captured={response,headers:response.headers(),body:await response.body()};
      }
      if(!captured?.body?.length) throw new Error(`Popup produced no capturable file bytes: ${popup.url()}`);
      let filename=captured.headers['content-disposition']?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]||captured.headers['content-disposition']?.match(/filename="?([^";]+)"?/i)?.[1]||names[index];
      try{filename=decodeURIComponent(filename);}catch{}
      filename=safe(filename);
      await writeFile(path.join(FILES,filename),captured.body);
      Object.assign(record,{status:'DOWNLOADED',method:'popup-response',filename,byte_size:captured.body.length,sha256:sha(captured.body),content_type:captured.headers['content-type'],content_disposition:captured.headers['content-disposition'],popup_url:popup.url()});
      await popup.close().catch(()=>null);
    }else{
      throw new Error('Download action produced no browser event within 20 seconds.');
    }
  }catch(error){record.status='FAILED';record.error=error.message;}
  manifest.push(record);
  await page.evaluate(()=>{
    try{clearAttachmentWrapper();}catch{}
    const a=document.querySelector('#downloadButton');if(a)a.setAttribute('href','#');
    const modal=document.querySelector('#attachmentWrapperModal');if(modal){modal.classList.remove('show','in');modal.style.display='none';modal.setAttribute('aria-hidden','true');}
    document.body.classList.remove('modal-open');document.querySelectorAll('.modal-backdrop').forEach(n=>n.remove());
  }).catch(()=>null);
  await page.waitForTimeout(400);
}
await writeFile(path.join(OUT,'manifest.json'),JSON.stringify(manifest,null,2));
await writeFile(path.join(OUT,'events.json'),JSON.stringify(events,null,2));
await writeFile(path.join(OUT,'summary.json'),JSON.stringify({solicitation:'26CRC006',official_file_count:names.length,downloaded_count:manifest.filter(x=>x.status==='DOWNLOADED').length,failed_count:manifest.filter(x=>x.status==='FAILED').length,total_bytes:manifest.reduce((s,x)=>s+Number(x.byte_size||0),0),completed_at:new Date().toISOString()},null,2));
await browser.close();
