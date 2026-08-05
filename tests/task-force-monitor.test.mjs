import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const root=new URL('../',import.meta.url);
const files=['assets/task-force-monitors/monitor-common.js','assets/task-force-monitors/monitor-registry.js','assets/task-force-monitors/publisher-discovery-monitor.js','assets/task-force-monitors/publisher-verification-monitor.js','assets/task-force-monitors/acquisition-discovery-monitor.js','assets/task-force-monitors/contract-package-monitor.js','assets/task-force-monitors/business-development-monitor.js','assets/task-force-monitors/opportunity-partner-monitor.js','assets/task-force-monitors/institutional-buyer-monitor.js','assets/task-force-monitors/supplemental-monitors.js'];
const context=vm.createContext({console,Date,Map,Set,JSON,Math,Number,String,Boolean,encodeURIComponent,globalThis:null});
context.globalThis=context;
for(const file of files)vm.runInContext(await readFile(new URL(file,root),'utf8'),context,{filename:file});
const Registry=context.APIEMissionMonitors;
const now=Date.parse('2026-08-05T20:00:00Z');
const base=(overrides={})=>({id:'run-001',mission_type_key:'VERIFY_PUBLISHER_CONNECTION',state_code:'CA',publisher_name:'County of Los Angeles',status:'queued',aadp_state:'QUEUED',current_stage:'NETLIFY_EXECUTION_QUEUED',created_at:'2026-08-05T19:59:30Z',updated_at:'2026-08-05T19:59:30Z',last_activity_at:'2026-08-05T19:59:30Z',execution_evidence:{publisher_id:'publisher-1',worker_claimed:false},...overrides});
const registered=['PUBLISHER_DISCOVERY','VERIFY_PUBLISHER_CONNECTION','ACQUISITION_DISCOVERY','CONTRACT_PACKAGE_ACQUISITION','BUSINESS_DEVELOPMENT_DISCOVERY','OPPORTUNITY_PARTNER_DISCOVERY','INSTITUTIONAL_BUYER_DISCOVERY','STATE_MISSION','AADP_PROCESSING','AOIE_ANALYSIS','PROCUREMENT_INVENTORY','CONTRACT_LIFECYCLE'];

test('every current launch mission has a dedicated monitor definition',()=>{for(const key of registered)assert.ok(Registry.get(key),key);assert.equal(Registry.get('PUBLISHER_DISCOVERY_CLASS').key,'PUBLISHER_DISCOVERY')});

test('Verify Publisher Connection never displays Publisher Discovery or Assignment Creation stages',()=>{
  const labels=Array.from(Registry.buildModel(base(),now).stages,stage=>String(stage.label));
  assert.deepEqual(labels,['Approved Publisher Profile Loaded','Connector Resolved','Listing or Search Connection Tested','Detail and Evidence Validation','EAG-001 Certification Decision']);
  assert.ok(!labels.includes('Publisher Discovery'));assert.ok(!labels.includes('Assignment Creation'));
});

test('Complete Contract Packages never displays Publisher Validation',()=>{const labels=Registry.buildModel(base({mission_type_key:'CONTRACT_PACKAGE_ACQUISITION'}),now).stages.map(stage=>stage.label);assert.ok(labels.includes('Documents Downloaded and Verified'));assert.ok(!labels.includes('Publisher Validation'))});

test('Publisher Discovery displays only its discovery stages',()=>{
  const labels=Array.from(Registry.buildModel(base({mission_type_key:'PUBLISHER_DISCOVERY'}),now).stages,stage=>String(stage.label));
  assert.deepEqual(labels,['Geographic Scope Initialized','Official Publisher Sources Researched','Sources Validated and Duplicates Checked','Publisher Candidates Classified','Profiles Admitted or Sent to Review']);
});

test('queued run older than 60 seconds is derived STALLED without changing authoritative status',()=>{const model=Registry.buildModel(base({created_at:'2026-08-05T19:58:00Z',updated_at:'2026-08-05T19:58:00Z',last_activity_at:'2026-08-05T19:58:00Z'}),now);assert.equal(model.runState.key,'STALLED');assert.equal(model.runState.authoritative,'QUEUED');assert.equal(model.runState.derived,true)});

test('recent queued run remains QUEUED',()=>{assert.equal(Registry.buildModel(base(),now).runState.key,'QUEUED')});

test('stopped run displays operator stop evidence and does not fabricate completed stages',()=>{
  const run=base({status:'stopped',aadp_state:'CANCELLED',current_stage:'OPERATOR_FORCE_STOPPED',stop_requested_at:'2026-08-05T19:59:50Z',completed_at:'2026-08-05T19:59:50Z',execution_evidence:{publisher_id:'publisher-1',worker_claimed:false,prior_stage:'NETLIFY_EXECUTION_QUEUED',checkpointed:true}});
  const model=Registry.buildModel(run,now);assert.equal(model.runState.key,'STOPPED');assert.equal(model.stages[0].status,'STOPPED');assert.ok(model.stages.slice(1).every(stage=>stage.status==='NOT REPORTED'));
  const html=Registry.renderCard(run,{now});assert.match(html,/Operator Stop Time/);assert.match(html,/Resume Checkpoint/);
});

test('unknown metrics display NOT REPORTED rather than zero',()=>{const metric=Registry.buildModel(base(),now).metrics.find(item=>item.label==='Search Response Time');assert.equal(metric.value,'NOT REPORTED');assert.notEqual(metric.value,'0')});

test('completion stages require actual evidence instead of progress_value',()=>{const model=Registry.buildModel(base({status:'completed',aadp_state:'COMPLETED',current_stage:'EAG_001_COMPLETED',progress_value:100,completed_at:'2026-08-05T19:59:59Z',execution_evidence:{publisher_id:'publisher-1'}}),now);assert.equal(model.stages[0].status,'COMPLETED');assert.ok(model.stages.slice(1).every(stage=>stage.status==='NOT REPORTED'))});

test('completed EAG-001 fixture renders only evidence-backed completed stages and real publisher name',()=>{
  const run=base({status:'completed',aadp_state:'COMPLETED',current_stage:'EAG_001_COMPLETED',completed_at:'2026-08-05T19:59:59Z',execution_evidence:{publisher_id:'publisher-1',connector_key:'LA_COUNTY_ECAPS',connector_version:'1.2.0',source_url:'https://example.test',connection:'PASS',search_response_ms:473,records_parsed:10,publisher_reported_total:229,sample_size:10,detail_pages_successful:10,attachments_detected:10,contacts_successful:10,requirements_successful:10,failures:0,pagination_status:'PASS',ready_for_acquisition:true,acceptance_status:'ACCEPTED',certification_status:'CERTIFIED'}});
  const model=Registry.buildModel(run,now);assert.equal(model.publisherName,'County of Los Angeles');assert.ok(model.stages.every(stage=>stage.status==='COMPLETED'));
  const html=Registry.renderCard(run,{now});assert.match(html,/County of Los Angeles/);assert.doesNotMatch(html,/PUBLISHER: ALL/);
});

test('completed package fixture renders package-specific evidence',()=>{const run=base({mission_type_key:'CONTRACT_PACKAGE_ACQUISITION',status:'completed',aadp_state:'COMPLETED',current_stage:'CONTRACT_PACKAGE_COMPLETED',completed_at:'2026-08-05T19:59:59Z',warning_count:100,execution_evidence:{publisher_id:'publisher-1',package_stats:{total_records:228,official_files_preserved:947,files_extracted:881,file_failures:55,package_complete:128,match_ready:128,package_review_required:100}},qualification_status:'COMPLETED',validation_status:'WARNING'});const model=Registry.buildModel(run,now);assert.equal(model.runState.key,'COMPLETED_WITH_WARNINGS');assert.equal(model.metrics.find(metric=>metric.label==='Packages MATCH_READY').value,'128');assert.ok(model.stages.some(stage=>stage.label==='Package and Match Readiness Determined'))});

test('failed fixture identifies failed stage without completing unsupported prior stages',()=>{const model=Registry.buildModel(base({mission_type_key:'ACQUISITION_DISCOVERY',status:'failed',aadp_state:'FAILED',current_stage:'DETAIL_EXTRACTION_OR_QUALIFICATION_FAILED',result_summary:'qualification failed',failure_count:1,action_required:true,execution_evidence:{publisher_id:'publisher-1'}}),now);assert.equal(model.runState.key,'FAILED');assert.ok(model.stages.some(stage=>stage.status==='FAILED'));assert.ok(model.stages.some(stage=>stage.status==='NOT REPORTED'))});

test('unsupported mission type receives an explicit unsupported monitor',()=>{const model=Registry.buildModel(base({mission_type_key:'UNKNOWN_MISSION'}),now);assert.equal(model.supported,false);assert.match(Registry.renderCard(base({mission_type_key:'UNKNOWN_MISSION'}),{now}),/Unsupported mission monitor/)});

test('dashboard integration loads separated monitors and removes universal STAGES behavior',async()=>{const dashboard=await readFile(new URL('assets/executive-command-center.js',root),'utf8');assert.doesNotMatch(dashboard,/const\s+STAGES\s*=/);assert.match(dashboard,/APIEMissionMonitors\.renderCard/);for(const file of files)assert.match(dashboard,new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));assert.match(dashboard,/setInterval\(eccLoad,15000\)/)});

test('monitor CSS preserves the required desktop proportion and responsive wrapping',async()=>{const css=await readFile(new URL('assets/task-force-monitors/monitor.css',root),'utf8');assert.match(css,/grid-template-columns:40% minmax\(0,60%\)/);assert.match(css,/overflow-wrap:anywhere/);assert.match(css,/@media\(max-width:620px\)/)});

test('status endpoint enriches runs from existing execution evidence tables without schema creation',async()=>{const endpoint=await readFile(new URL('netlify/functions/command-executive-status.js',root),'utf8');for(const source of ['command_runs','command_missions','command_tasks','command_task_attempts','publisher_assignments','connector_acceptance_registry','publisher_discovery_runs','publisher_discovery_candidates','acquisition_runs','contract_package_documents'])assert.match(endpoint,new RegExp(source));assert.match(endpoint,/monitor_evidence/);assert.match(endpoint,/publisher_name/);assert.doesNotMatch(endpoint,/create\s+table|alter\s+table|drop\s+table/i)});
