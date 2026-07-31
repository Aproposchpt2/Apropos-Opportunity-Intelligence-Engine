const ECC={data:null,state:'ALL',timer:null};
const q=id=>document.getElementById(id);
const esc=v=>String(v??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]));
const when=v=>v?new Date(v).toLocaleString():'—';
const cls=s=>`ecc-${String(s||'unknown').toLowerCase().replaceAll('_','-').replaceAll(' ','-')}`;
const num=v=>Number(v||0).toLocaleString();
function stateLabel(s){return ({OPERATIONAL:'Operational',ONBOARDING:'Onboarding',MISSION_RUNNING:'Mission Running',ACTION_REQUIRED:'Action Required',UNEVALUATED:'Unevaluated',PAUSED:'Paused'})[s]||s||'Unevaluated'}
function execLabel(r){const s=String(r.status||'').toLowerCase();if(r.action_required)return'Action Required';if(s==='completed'&&r.warning_count)return'Completed with Warnings';return s.replaceAll('_',' ').replace(/\b\w/g,x=>x.toUpperCase())||'Unknown'}
async function eccLoad(){try{ECC.data=await invoke('command-executive-status',{});eccRender();}catch(e){console.error(e)}}
function healthCard(label,item={}){return `<article><span>${esc(label)}</span><strong>${esc(item.status||'UNKNOWN')}</strong><small>${esc(item.source||'No evidence source')} · ${when(item.observed_at)}</small>${item.detail?`<small>${esc(item.detail)}</small>`:''}</article>`}
function eccRender(){
  const d=ECC.data;if(!d)return;
  const states=d.states||[];const selected=ECC.state==='ALL'?null:ECC.state;
  q('eccUpdated').textContent=`Updated ${new Date(d.generated_at).toLocaleTimeString()}`;
  const connectorEvidence=d.health?.connector_health?.status||'UNKNOWN';
  const enterpriseStatus=connectorEvidence==='STALE'?'STALE EVIDENCE':(d.system?.operational_status||'UNEVALUATED');
  q('systemStatus').textContent=enterpriseStatus;
  q('systemStatus').className=`status-pill ${cls(enterpriseStatus)}`;
  q('eccStateSelector').innerHTML=`<button class="${ECC.state==='ALL'?'active':''}" data-state="ALL">Enterprise</button>`+states.map(s=>`<button class="${ECC.state===s.state_code?'active':''}" data-state="${s.state_code}"><i class="state-dot ${cls(s.inventory_status)}"></i>${esc(s.state_name)} — ${esc(stateLabel(s.inventory_status))}</button>`).join('');
  const totals=d.totals||{};
  const cards=[['States Operational',totals.states_operational],['States Onboarding',totals.states_onboarding],['Active Missions',totals.active_missions],['Action Required',totals.missions_requiring_attention],['Publishers',totals.publishers],['Acquisition Sources',totals.acquisition_sources],['Active Opportunities',totals.active_procurement_opportunities],['Canonical Opportunities',totals.canonical_procurement_opportunities]];
  q('eccTotals').innerHTML=cards.map(([a,b])=>`<article><span>${a}</span><strong>${num(b)}</strong></article>`).join('');
  const runs=(d.active_runs||[]).filter(r=>!selected||r.state_code===selected);
  q('eccActiveMissions').innerHTML=runs.length?runs.map(missionCard).join(''):'<p class="ecc-empty">No active missions in this context.</p>';
  q('eccStateInventory').innerHTML=states.filter(s=>!selected||s.state_code===selected).map(s=>stateCard(s,d)).join('')||'<p class="ecc-empty">No state evidence in this context.</p>';
  const rec=(d.recommendations||[]).find(r=>!selected||r.state_code===selected)||states.find(s=>(!selected||s.state_code===selected)&&s.next_recommended_mission_type);
  q('eccRecommendation').innerHTML=rec?`<strong>${esc(rec.state_code)} · ${esc(rec.recommended_mission_type_key||rec.next_recommended_mission_type)}</strong><p>${esc(rec.reason||'Next unresolved eligible capability based on current state evidence.')}</p><small>System recommends. Operator authorizes.</small>`:'<p class="ecc-empty">No recommendation is currently supported by sufficient evidence.</p>';
  renderPublisherDiscovery(d,selected);
  renderPublisherRegistry(d,selected);
  renderAcquisition(d,selected);
  renderInventory(d,selected);
  renderOTF(d.otf||{});
  renderSchedules(d,selected);
  renderExceptions(d,selected);
  renderLifecycle(d);
  renderHealth(d);
  renderAudit(d,selected);
  renderDeliverables(d);
  renderNotifications(d,selected);
}
function renderPublisherDiscovery(d,selected){
  const pd=d.publisher_discovery||{};
  const runs=(pd.runs||[]).filter(r=>!selected||r.state_code===selected);
  const candidates=(pd.candidates||[]).filter(c=>!selected||c.state_code===selected);
  const pending=candidates.filter(c=>String(c.review_status||'').toLowerCase()==='pending_review').length;
  const verified=candidates.filter(c=>c.source_verified).length;
  const summary=`<article><div><strong>${num(runs.length)} recent run(s)</strong><small>${num(candidates.length)} candidate(s) · ${num(verified)} source-verified · ${num(pending)} pending human review</small></div></article>`;
  const recent=runs.slice(0,5).map(r=>`<article><div><strong>${esc(r.state_code||'—')} · ${esc(r.mission_type_key||'Discovery')}</strong><small>${esc(r.current_stage||'—')} · ${num(r.result_count)} result(s)</small></div><div><span class="status-pill ${cls(r.status)}">${esc(r.status||'UNEVALUATED')}</span><small>${when(r.updated_at||r.completed_at||r.started_at)}</small></div></article>`).join('');
  q('eccPublisherDiscovery').innerHTML=summary+(recent||'<p class="ecc-empty">No publisher discovery run evidence.</p>');
}
function renderPublisherRegistry(d,selected){
  const rows=(d.publisher_registry||[]).filter(p=>!selected||p.state_code===selected);
  q('eccPublisherRegistry').innerHTML=rows.length?rows.slice(0,10).map(p=>`<article><div><strong>${esc(p.publisher_name)}</strong><small>${esc(p.state_code)} · ${esc(p.organization_type||'Publisher')} · ${esc(p.acquisition_method||'Method unverified')}</small></div><div><span class="status-pill ${cls(p.verified?'verified':'unevaluated')}">${p.verified?'Verified':'Unverified'}</span><small>Last verified ${when(p.last_verified_at)}</small></div></article>`).join(''):'<p class="ecc-empty">No publisher registry evidence in this context.</p>';
}
function renderAcquisition(d,selected){
  const a=d.acquisition||{};
  const runs=a.recent_runs||[];
  const latest=a.latest_run;
  const summary=`<article><div><strong>${num(runs.length)} recent acquisition run(s)</strong><small>${num(a.recent_raw_record_count)} recent raw record(s) · ${num(a.failed_recent_runs)} failed recent run(s)</small></div>${latest?`<div><span class="status-pill ${cls(latest.status)}">${esc(latest.status)}</span><small>${when(latest.completed_at||latest.started_at||latest.created_at)}</small></div>`:''}</article>`;
  const recent=runs.slice(0,5).map(r=>`<article><div><strong>Run ${esc(String(r.id||'').slice(0,8))}</strong><small>Discovered ${num(r.records_discovered)} · Acquired ${num(r.records_acquired)} · Failures ${num(r.retrieval_failures)}</small></div><div><span class="status-pill ${cls(r.status)}">${esc(r.status||'UNEVALUATED')}</span><small>${when(r.completed_at||r.started_at||r.created_at)}</small></div></article>`).join('');
  q('eccAcquisitionOps').innerHTML=summary+(recent||'<p class="ecc-empty">No acquisition run evidence.</p>');
}
function renderInventory(d,selected){
  const rows=(d.procurement_inventory?.recent||[]).filter(o=>!selected||o.state_code===selected);
  const s=d.procurement_inventory?.summary||{};
  const cards=[['Canonical',s.total],['Open',s.open],['Released',s.released],['Lifecycle Review',s.lifecycle_verification_required],['Contract DNA Complete',s.contract_dna_complete]];
  q('eccProcurementInventory').innerHTML=cards.map(([a,b])=>`<article><span>${a}</span><strong>${num(b)}</strong></article>`).join('')+(rows.length?`<article><span>Context Sample</span><strong>${num(rows.length)}</strong><small>Recent records matching the selected state context.</small></article>`:'');
}
function renderOTF(otf){
  const k=otf.kpis||{};
  const cards=[['Nomination Ready',k.nomination_ready],['Enrichment Required',k.enrichment_required],['Business Search',k.discovery_running],['Selected Businesses',k.selected_businesses],['Outreach Pending',k.outreach_pending],['Awaiting Response',k.awaiting_response],['Interested',k.interested],['Analyze Fit',k.analyze_fit_complete],['Report Ready',k.reports_ready],['Repository Members',k.active_repository_members],['Subscription MRR',`$${Number(k.subscription_mrr||0).toFixed(2)}`],['OTF VAR',otf.exceptions?.length||0]];
  q('eccOtfKpis').innerHTML=cards.map(([a,b])=>`<article><span>${a}</span><strong>${typeof b==='number'?num(b):esc(b)}</strong></article>`).join('');
  q('eccOtfQueues').innerHTML=(otf.queues||[]).map(x=>`<article class="ecc-queue-row"><span>${esc(x.name)}</span><strong>${num(x.value)}</strong></article>`).join('')||'<p class="ecc-empty">No OTF queue state.</p>';
  q('eccOtfSelected').innerHTML=(otf.selected_candidates||[]).map(c=>`<article><div><strong>${esc(c.business_name)}</strong><small>Rank ${esc(c.discovery_rank)} · Score ${esc(c.discovery_score)} · ${esc(c.verification_status)}</small></div><div><span class="status-pill ${c.contact_verified?'ecc-complete':'ecc-action-required'}">${c.contact_verified?'Contact Verified':'Contact Review'}</span></div></article>`).join('')||'<p class="ecc-empty">No business is currently selected.</p>';
  q('eccOtfExceptions').innerHTML=(otf.exceptions||[]).map(x=>`<article class="needs-action"><strong>${esc(x.classification)}</strong><p>${esc(x.title||x.detail)}</p><small>${esc(x.detail)} · ${x.retry_available?'Retry available':'Review required'}</small></article>`).join('')||'<p class="ecc-empty">No OTF exceptions require attention.</p>';
  const link=q('eccOtfOpen');if(link)link.href=otf.operator_url||'https://natcorp.aproposgroupllc.com/opportunity-fulfillment';
}
function renderSchedules(d,selected){
  const schedules=(d.schedules||[]).filter(s=>!selected||!s.state_codes?.length||s.state_codes.includes(selected));
  q('eccSchedules').innerHTML=schedules.length?schedules.map(s=>`<article><div><strong>${esc(s.schedule_name)}</strong><small>${esc(s.operation_type)} · ${(s.state_codes||[]).join(', ')||'Enterprise'}</small></div><div><span class="status-pill ${cls(s.current_status)}">${esc(s.current_status)}</span><small>Last ${when(s.last_run_at)} · Next ${when(s.next_run_at)}</small></div></article>`).join(''):'<p class="ecc-empty">No Executive Operations schedules configured. Scheduler remains disabled.</p>';
}
function renderExceptions(d,selected){
  const attention=(d.attention_runs||[]).filter(r=>!selected||r.state_code===selected);
  q('eccActionRequired').innerHTML=attention.length?attention.map(missionCard).join(''):'<p class="ecc-empty">No mission exceptions require operator action.</p>';
}
function renderLifecycle(d){
  const totals=d.totals||{};const lc=d.lifecycle_events||[];const apply=d.health?.lifecycle_apply||{};
  q('eccLifecycle').innerHTML=`<div class="ecc-lifecycle-grid"><article><span>Verification Required</span><strong>${num(totals.lifecycle_verification_required)}</strong></article><article><span>Recent Evaluations</span><strong>${num(lc.length)}</strong></article><article><span>Apply Mode</span><strong>${esc(apply.status||'UNKNOWN')}</strong></article></div><p>Lifecycle intelligence is observable. Apply authority remains governed and separately authorized.</p>`;
}
function renderHealth(d){
  const h=d.health||{};
  q('eccHealth').innerHTML=[['Database',h.database],['Command Runtime',h.command_runtime],['Connector Health',h.connector_health],['Publisher Registry',h.publisher_registry],['Acquisition',h.acquisition],['Scheduler',h.scheduler],['Lifecycle Apply',h.lifecycle_apply],['NAT-CORP OTF Data Plane',h.natcorp_otf]].map(([label,item])=>healthCard(label,item)).join('');
}
function renderAudit(d,selected){
  const rows=(d.audit||[]).filter(a=>!selected||!a.state_code||a.state_code===selected);
  q('eccAuditHistory').innerHTML=rows.length?rows.slice(0,10).map(a=>`<article><div><strong>${esc(a.action||a.event_type||a.operation||a.audit_type||'Governed activity')}</strong><small>${esc(a.state_code||'Enterprise')} · ${esc(a.actor||a.actor_type||a.authorized_by||'System')}</small></div><div><small>${when(a.occurred_at||a.created_at)}</small></div></article>`).join(''):'<p class="ecc-empty">No audit history in this context.</p>';
}
function renderDeliverables(d){
  const x=d.deliverables||{};const briefs=x.executive_briefs||[];const reports=x.analyze_fit_reports||[];
  const rows=[...briefs.slice(0,5).map(b=>({title:`Executive Brief · ${b.brief_date||'—'}`,status:b.overall_status||'GENERATED',time:b.generated_at||b.created_at})),...reports.slice(0,5).map(r=>({title:r.file_name||'Analyze Fit Report',status:'GENERATED',time:r.generated_at}))].sort((a,b)=>new Date(b.time||0)-new Date(a.time||0));
  q('eccDeliverables').innerHTML=rows.length?rows.map(r=>`<article><div><strong>${esc(r.title)}</strong><small>${esc(r.status)}</small></div><div><small>${when(r.time)}</small></div></article>`).join(''):'<p class="ecc-empty">No generated deliverables recorded.</p>';
}
function renderNotifications(d,selected){
  const notes=(d.notifications||[]).filter(n=>!selected||n.state_code===selected);
  q('eccNotifications').innerHTML=notes.length?notes.slice(0,10).map(n=>`<article class="${n.action_required?'needs-action':''}"><strong>${esc(n.title)}</strong><p>${esc(n.message)}</p><small>${esc(n.state_code||'Enterprise')} · ${when(n.created_at)}</small></article>`).join(''):'<p class="ecc-empty">No operational notifications.</p>';
}
function missionCard(r){let pct=r.progress_value;const measurable=pct!==null&&pct!==undefined;return `<article class="ecc-mission-card"><header><div><small>${esc(r.state_code||'Enterprise')} · ${esc(r.mission_type_key||'Mission')}</small><strong>${esc(r.mission_name||r.id)}</strong></div><span class="status-pill ${cls(execLabel(r))}">${esc(execLabel(r))}</span></header><div class="ecc-progress"><i style="width:${measurable?Math.max(0,Math.min(100,Number(pct))):0}%"></i></div><div class="ecc-mission-meta"><span>Stage <b>${esc(r.current_stage||'—')}</b></span><span>Progress <b>${measurable?`${pct}%`:esc(r.progress_mode||'Stage based')}</b></span><span>Last Activity <b>${when(r.last_activity_at||r.updated_at)}</b></span><span>Warnings <b>${r.warning_count||0}</b></span><span>Failures <b>${r.failure_count||0}</b></span></div><a href="/missions/?id=${encodeURIComponent(r.id)}">Open Mission Workspace →</a></article>`}
function stateCard(s,d){const caps=(d.capabilities||[]).filter(c=>c.state_code===s.state_code);const counts=d.state_counts?.[s.state_code]||{};return `<article class="ecc-state-card"><header><div><i class="state-dot ${cls(s.inventory_status)}"></i><strong>${esc(s.state_name)}</strong></div><span>${esc(stateLabel(s.inventory_status))}</span></header><div class="ecc-capabilities">${caps.map(c=>`<div><span>${esc(c.capability_key.replaceAll('_',' '))}</span><b class="${cls(c.readiness_status)}">${esc(c.readiness_status)}</b></div>`).join('')}</div><footer><span>Contracts ${num(counts.total)}</span><span>Open ${num(counts.open)}</span><span>Readiness ${esc(s.overall_readiness)}</span></footer></article>`}
document.addEventListener('click',e=>{const b=e.target.closest('[data-state]');if(b){ECC.state=b.dataset.state;eccRender();}});
window.addEventListener('apie:authenticated',()=>{eccLoad();ECC.timer=setInterval(eccLoad,15000)});
window.eccLoad=eccLoad;
