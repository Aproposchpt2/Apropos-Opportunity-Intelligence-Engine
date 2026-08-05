import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const text=path=>readFile(new URL(path,root),'utf8');

const css=await text('assets/task-force-monitors/monitor.css');
const dashboard=await text('assets/executive-command-center.js');
const html=await text('index.html');

test('approved Launch Task Force panel remains outside workspace recoloring',()=>{
  assert.match(html,/class="ecc-sidebar"[^>]*aria-label="Launch Task Force command panel"/);
  assert.doesNotMatch(css,/\.ecc-sidebar\s*\{[^}]*background/s);
});

test('monitoring workspace uses approved warm executive ivory',()=>{
  assert.match(css,/--ecc-executive-ivory:#F4F0E6/);
  assert.match(css,/\.ecc-workspace\{[\s\S]*background:var\(--ecc-executive-ivory\)!important/);
});

test('primary monitor cards use soft white and champagne borders',()=>{
  assert.match(css,/--ecc-card:#FCFBF7/);
  assert.match(css,/--ecc-champagne:#D8CBAE/);
  assert.match(css,/\.ecc-task-force-card\{[\s\S]*background:var\(--ecc-card\)!important/);
});

test('stage cards remain neutral instead of using full operational color fills',()=>{
  assert.match(css,/\.ecc-stage-row\{[\s\S]*background:var\(--ecc-card\)!important/);
  assert.doesNotMatch(css,/\.ecc-stage-row\.ecc-(completed|running|stalled|warning|blocked|fail|failed|stopped)\s*\{[^}]*background:/);
});

test('status colors are restricted to badges borders progress bars icons and callouts',()=>{
  for(const selector of ['status-pill','border-left-color','progress-value','stage-number','stall-alert'])assert.match(css,new RegExp(selector));
  assert.doesNotMatch(css,/\.ecc-task-force-card\.ecc-(pass|completed|running|stalled|warning|blocked|fail|failed|stopped)\s*\{[^}]*background:/);
});

test('desktop shell retains the approved 40/60 relationship',()=>{
  assert.match(css,/@media \(min-width:821px\)\{[\s\S]*grid-template-columns:40% minmax\(0,60%\)!important/);
});

test('standard desktop inventory table does not require horizontal scrolling',()=>{
  assert.match(css,/\.ecc-inventory-table-wrap\{[\s\S]*overflow-x:visible!important/);
  assert.match(css,/\.ecc-inventory-table\{[\s\S]*min-width:0!important[\s\S]*table-layout:fixed!important/);
});

test('connector names URLs and evidence values wrap safely',()=>{
  assert.match(css,/overflow-wrap:anywhere/);
  assert.match(css,/word-break:break-word/);
});

test('tablet and mobile layouts remain usable with Launch Task Force first',()=>{
  assert.match(css,/@media\(max-width:820px\)\{[\s\S]*\.ecc-shell\{display:block!important\}/);
  assert.match(css,/@media\(max-width:620px\)\{[\s\S]*grid-template-columns:1fr/);
  assert.ok(html.indexOf('ecc-sidebar')<html.indexOf('ecc-workspace'));
});

test('mission-specific stage labels and evidence rendering remain delegated to registry',()=>{
  assert.match(dashboard,/APIEMissionMonitors\.renderCard/);
  assert.doesNotMatch(dashboard,/const\s+STAGES\s*=/);
});

test('monitor evidence refresh behavior remains unchanged',()=>{
  assert.match(dashboard,/setInterval\(eccLoad,15000\)/);
});

test('Current System Counts panel remains present and styled',()=>{
  assert.match(html,/ecc-inventory-panel/);
  assert.match(html,/ecc-inventory-table/);
  assert.match(css,/\.ecc-inventory-table thead th/);
});
