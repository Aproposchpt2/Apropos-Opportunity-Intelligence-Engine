import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const shared=fs.readFileSync('supabase/functions/_shared/aadp.ts','utf8');
const adapter=fs.readFileSync('supabase/functions/aadp-publisher-adapter/index.ts','utf8');
const migration=fs.readFileSync('supabase/migrations/20260726233000_pdas_aadp_integrated_build_completion_v1.sql','utf8');

const ordered=[
  'ACQUISITION_PAGE_FETCH','PROJECT_DETAIL_RETRIEVAL','ACQUISITION_RECORD_STORE','ACQUISITION_RUN_CLOSE',
  'DOCUMENT_DISCOVERY','DOCUMENT_RETRIEVAL','REQUIREMENT_EXTRACTION','RECORD_NORMALIZATION',
  'RECORD_DEDUPLICATION','RECORD_QUALIFICATION','QUALIFIED_RECORD_UPSERT','REJECTION_RECORD_CREATE',
  'RUN_RECONCILIATION','PROCUREMENT_LANGUAGE_ANALYSIS','AOIE_BATCH_REVIEW','MATCHING_RECOMMENDATION_CREATE',
  'MATCHING_RECOMMENDATION_TEST','EXECUTIVE_REPORT_CREATE'
];

test('integrated graph contains detail, document, qualification, AOIE, and reporting stages in order',()=>{
  let previous=-1;
  for(const stage of ordered){const current=shared.indexOf(`'${stage}'`,previous+1);assert.ok(current>previous,`${stage} must follow the prior stage`);previous=current;}
  assert.match(shared,/invoke\('aadp-publisher-adapter'/);
});

test('OpenGov adapter supports public enumeration and HTML fallback',()=>{
  for(const pattern of [/recordsFromOpenGovHtml/,/recordsFromJson/,/pagination_complete/,/procurement\.opengov\.com/,/OPENGOV_PUBLIC_PORTAL_V1/]) assert.match(adapter,pattern);
});

test('OpenGov adapter retrieves project detail and public document manifests',()=>{
  for(const pattern of [/PROJECT_DETAIL_RETRIEVAL/,/DOCUMENT_RETRIEVAL/,/aadp_document_manifests/,/addenda/,/amendments/,/questions_answers/]) assert.match(adapter,pattern);
});

test('requirements extraction feeds canonical normalization',()=>{
  assert.match(adapter,/REQUIREMENT_EXTRACTION/);
  assert.match(adapter,/__aadp_normalized/);
  assert.match(adapter,/issuing_organization/);
  assert.match(adapter,/response_deadline/);
  assert.match(adapter,/processing_status:'NORMALIZED'/);
});

test('City of Tucson reference assignment is configuration only and public-source restricted',()=>{
  for(const pattern of [/City of Tucson/,/Business Services Department Procurement Division/,/tucson-az/,/OPENGOV_PUBLIC_PORTAL/,/PUBLICLY_ACCESSIBLE_CONTENT_ONLY/,/Procurement@tucsonaz\.gov/]) assert.match(migration,pattern);
  assert.doesNotMatch(migration,/insert into public\.acquisition_runs/i);
  assert.doesNotMatch(migration,/insert into public\.state_contract_opportunities/i);
});

test('document manifests and raw detail evidence are RLS protected',()=>{
  assert.match(migration,/create table if not exists public\.aadp_document_manifests/);
  assert.match(migration,/enable row level security/);
  assert.match(migration,/revoke all on public\.aadp_document_manifests from anon, public/);
  assert.match(migration,/detail_retrieval_status/);
  assert.match(migration,/detail_retrieval_error/);
});

test('adapter source contains no embedded privileged credentials',()=>{
  assert.doesNotMatch(adapter,/SUPABASE_SERVICE_ROLE_KEY\s*=\s*['"]/);
  assert.doesNotMatch(adapter,/Authorization:\s*["']Bearer\s+eyJ/);
  assert.doesNotMatch(adapter,/api[_-]?key\s*[:=]\s*["'][A-Za-z0-9_-]{20,}/i);
});
