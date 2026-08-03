import { createHash } from 'node:crypto';

const now=()=>new Date().toISOString();
const txt=v=>String(v??'').replace(/\s+/g,' ').trim();
const hash=v=>createHash('sha256').update(String(v)).digest('hex');

function decodeHtml(value){return String(value||'')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ')
  .replace(/<[^>]+>/g,' ')
  .replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"')
  .replace(/&#39;|&#x27;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
  .replace(/\s+/g,' ').trim();}
function absoluteUrl(href,base){try{return new URL(href,base).toString().replace(/#.*$/,'')}catch{return null}}
function unique(values){return [...new Set(values.filter(Boolean))]}
function links(html,base){const out=[];for(const m of String(html||'').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){const url=absoluteUrl(m[1],base);if(url)out.push({url,label:decodeHtml(m[2])})}return out}
function firstMatch(text,patterns){for(const p of patterns){const m=text.match(p);if(m?.[1])return txt(m[1])}return null}
function escapeRegex(v){return String(v||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}

async function fetchHtml(url,timeoutMs=30000){const c=new AbortController();const t=setTimeout(()=>c.abort(),timeoutMs);try{const r=await fetch(url,{headers:{Accept:'text/html,application/xhtml+xml','User-Agent':'APROPOS-APIE-Detail-Extraction/1.1','Cache-Control':'no-cache'},redirect:'follow',signal:c.signal});if(!r.ok)throw new Error(`Detail request failed with HTTP ${r.status}`);const type=r.headers.get('content-type')||'';if(!/html|text/i.test(type))throw new Error(`Unsupported detail content type: ${type||'unknown'}`);return{html:await r.text(),url:r.url||url}}finally{clearTimeout(t)}}

function labelledValue(text,label,nextLabels){const stop=nextLabels.map(escapeRegex).join('|');return firstMatch(text,[new RegExp(`${escapeRegex(label)}\\s*[:|]?\\s*(.{1,500}?)(?=\\s+(?:${stop})\\s*[:|]?|$)`,'i')])}
function validNanpPhone(value){const digits=String(value||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');return /^\d{10}$/.test(digits)&&!/^(\d)\1{9}$/.test(digits)?value:null}

export function extractDetailPayload(html,detailUrl,existing={}){
  const text=decodeHtml(html), solicitationNumber=txt(existing.solicitation_number||existing.source_record_id);
  const isDetail=/Solicitation\s+Detail/i.test(text)&&(!solicitationNumber||new RegExp(`Solicitation Number\\s*[:|]?\\s*${escapeRegex(solicitationNumber)}(?:\\s|$)`,'i').test(text));
  if(!isDetail)throw new Error(`Solicitation-specific detail page was not confirmed for ${solicitationNumber||'unknown record'}.`);

  const allLinks=links(html,detailUrl);
  const description=labelledValue(text,'Description',['Open Day','Close Date','Contact Name','Contact Phone','Contact Email','Last Changed On','Attachment File'])||null;
  const contactName=labelledValue(text,'Contact Name',['Contact Phone','Contact Email','Last Changed On','Attachment File']);
  const contactEmail=firstMatch(text,[/Contact Email\s*[:|]?\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i]);
  const labelledPhone=firstMatch(text,[/Contact Phone\s*[:|]?\s*(\+?1?\s*\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}(?:\s*(?:x|ext\.?)\s*\d+)?)/i]);
  const contactPhone=validNanpPhone(labelledPhone);
  const closeDate=labelledValue(text,'Close Date',['Contact Name','Contact Phone','Contact Email','Last Changed On','Attachment File']);
  const docs=allLinks.filter(l=>/\.(pdf|docx?|xlsx?|zip)(?:$|\?)/i.test(l.url)||/download attachment|attachment file|download/i.test(`${l.label} ${l.url}`));
  const qa=allLinks.find(l=>/questions?|q\s*&\s*a|inquir/i.test(l.label));
  const submit=allLinks.find(l=>/submit|respond|proposal|bid online|vendor portal/i.test(l.label));
  const requirements=description&&description.length>=80?description:null;

  return {...existing,
    description:requirements||existing.description||null,
    requirements_text:requirements,
    requirements:requirements?{scope:requirements,source:'official_solicitation_detail'}:existing.requirements,
    contact_name:contactName||null,contact_email:contactEmail?.toLowerCase()||null,contact_phone:contactPhone||null,
    contact_url:qa?.url||submit?.url||null,questions_url:qa?.url||null,submission_url:submit?.url||null,
    response_deadline:closeDate||existing.response_deadline||null,
    document_urls:unique(docs.map(d=>d.url)),document_manifest:docs.map(d=>({url:d.url,label:d.label||null})),
    official_source_url:detailUrl,detail_page_url:detailUrl,detail_text_length:text.length,
    __detail_extraction:{engine:'DETAIL_EXTRACTION_V1_1',extracted_at:now(),detail_page_confirmed:true,solicitation_number_confirmed:solicitationNumber||null,contact_email_labelled:Boolean(contactEmail),contact_phone_labelled:Boolean(contactPhone),documents_found:docs.length}
  };
}

export async function extractAcquisitionRun({db,acquisitionRunId,concurrency=5,onProgress}){
  const rows=await db(`acquisition_raw_records?acquisition_run_id=eq.${encodeURIComponent(acquisitionRunId)}&processing_status=eq.EXTRACTION_REQUIRED&select=id,source_record_id,source_url,raw_payload,content_fingerprint,processing_attempt_count&order=retrieval_timestamp.asc`)||[];
  const stats={targeted:rows.length,completed:0,failed:0,requirements_found:0,contact_found:0,documents_found:0};let cursor=0;
  async function worker(){while(true){const i=cursor++;if(i>=rows.length)return;const row=rows[i];try{
    const fetched=await fetchHtml(row.source_url);const payload=extractDetailPayload(fetched.html,fetched.url,{...(row.raw_payload||{}),source_record_id:row.source_record_id});
    const hasReq=Boolean(txt(payload.requirements_text).length>=80),hasContact=Boolean(payload.contact_email||payload.contact_phone||payload.contact_url||payload.questions_url||payload.submission_url);
    await db(`acquisition_raw_records?id=eq.${row.id}`,{method:'PATCH',body:JSON.stringify({raw_payload:payload,content_fingerprint:hash(JSON.stringify(payload)),processing_status:'RAW',detail_retrieval_status:'COMPLETE',detail_retrieval_error:null,detail_retrieved_at:now(),document_manifest_count:payload.document_urls?.length||0})});
    stats.completed++;if(hasReq)stats.requirements_found++;if(hasContact)stats.contact_found++;stats.documents_found+=payload.document_urls?.length||0;
  }catch(error){stats.failed++;await db(`acquisition_raw_records?id=eq.${row.id}`,{method:'PATCH',body:JSON.stringify({detail_retrieval_status:'FAILED',detail_retrieval_error:error instanceof Error?error.message:String(error),detail_retrieved_at:now(),processing_attempt_count:Number(row.processing_attempt_count||0)+1})}).catch(()=>null)}await onProgress?.({...stats,processed:stats.completed+stats.failed});}}
  await Promise.all(Array.from({length:Math.max(1,Math.min(concurrency,10))},worker));return stats;
}
