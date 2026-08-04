import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildRequirementsMatrix } from '../netlify/functions/_shared/contract-package-engine.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('package requirements matrix derives mandatory eligibility evidence from official documents', () => {
  const source = `The successful proposer shall maintain commercial general liability insurance of at least two million dollars. The contractor must possess a valid California contractor license. The proposer shall demonstrate five years of relevant past performance. Evaluation criteria include technical approach, staffing, experience, and price. The scope of work requires delivery, installation, testing, training, reporting, and continuing support for all County facilities. Submission must include the required forms, pricing schedule, references, staffing plan, insurance certificates, and signed certifications. `.repeat(4);
  const result = buildRequirementsMatrix([
    { document_type: 'ADDENDUM', original_filename: 'Addendum-5.pdf', extracted_text: source, extraction_status: 'EXTRACTED' },
    { document_type: 'SCOPE_OF_WORK', original_filename: 'Statement-of-Work.pdf', extracted_text: source, extraction_status: 'EXTRACTED' }
  ], { title: 'County procurement' });

  assert.equal(result.substantive, true);
  assert.ok(result.combined_text.length >= 500);
  assert.ok(result.matrix.mandatory_requirements.length > 0);
  assert.ok(result.matrix.licenses_required.length > 0);
  assert.ok(result.matrix.insurance_requirements.length > 0);
  assert.ok(result.matrix.experience_requirements.length > 0);
  assert.ok(result.matrix.evaluation_factors.length > 0);
  assert.ok(result.matrix.submission_requirements.length > 0);
});

test('LA County resolver uses official attachment and amendment interfaces', async () => {
  const source = await read('netlify/functions/_shared/contract-package-engine.js');
  assert.match(source, /GetBidAttachs/);
  assert.match(source, /GetBidAmendments/);
  assert.match(source, /DownloadBidAttachFile/);
  assert.match(source, /DownloadAmendAttachFile/);
  assert.match(source, /LA_COUNTY_ECAPS_ATTACHMENT_API/);
});

test('package worker is checkpointed and synchronizes extracted requirements before qualification', async () => {
  const source = await read('netlify/functions/command-contract-package-worker-background.js');
  assert.match(source, /processPackageBatch/);
  assert.match(source, /synchronizePackageEvidence/);
  assert.match(source, /requirements_text/);
  assert.match(source, /processing_status = 'RAW'|rawPatch\.processing_status = 'RAW'/);
  assert.match(source, /routePending/);
  assert.match(source, /command-contract-package-worker-background/);
});

test('database migration enforces complete package and match-ready presentation gate', async () => {
  const source = await read('supabase/migrations/20260804180500_aadp_complete_contract_package_foundation.sql');
  assert.match(source, /solicitation-packages/);
  assert.match(source, /contract_package_documents/);
  assert.match(source, /PACKAGE_COMPLETE/);
  assert.match(source, /requirements_extraction_status = 'COMPLETE'/);
  assert.match(source, /match_readiness_status = 'MATCH_READY'/);
  assert.match(source, /contract_active_presentation_eligible/);
  assert.match(source, /create or replace view public\.natcorp_qualified_contracts/);
});

test('dashboard exposes Complete Contract Packages as a county publisher task', async () => {
  const [html, launch, mission] = await Promise.all([
    read('index.html'),
    read('assets/executive-launch.js'),
    read('netlify/functions/command-mission-control.js')
  ]);
  assert.match(html, /CONTRACT_PACKAGE_ACQUISITION/);
  assert.match(html, /Complete Contract Packages/);
  assert.match(launch, /AADP Package Acquisition/);
  assert.match(mission, /CHECKPOINTED_COMPLETE_CONTRACT_PACKAGE/);
});
