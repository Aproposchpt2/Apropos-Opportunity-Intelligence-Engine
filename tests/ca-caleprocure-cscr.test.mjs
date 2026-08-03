import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCalEProcureRows } from '../netlify/functions/_shared/acquisition-connectors/ca-caleprocure-cscr.js';
import { listConnectorKeys, resolveConnector } from '../netlify/functions/_shared/acquisition-connectors/index.js';

test('Cal eProcure parser maps posted CSCR rows and buyer contact', () => {
  const html = `
    <div>1-577 of 577</div>
    <table><tr>
      <td>2660</td><td>Department of Transportation</td><td>07A6329</td>
      <td><a href="/psc/psfpd1/SUPPLIER/ERP/c/AUC_MANAGE_BIDS.AUC_RESP_INQ_DTL.GBL?AUC_ID=07A6329&BUSINESS_UNIT=2660">Upgrade Traffic Monitor Detection Stations</a></td>
      <td>Sell</td><td>RFx</td><td>03/09/2026 2:15PM PDT</td><td>Posted</td>
      <td>Tammy Tran</td><td>tammy.p.tran@dot.ca.gov</td>
    </tr></table>`;
  const rows = parseCalEProcureRows(html, 'https://caleprocure.ca.gov/search');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].solicitation_number, '07A6329');
  assert.equal(rows[0].department_code, '2660');
  assert.equal(rows[0].contact_email, 'tammy.p.tran@dot.ca.gov');
  assert.match(rows[0].source_url, /AUC_RESP_INQ_DTL/);
  assert.equal(rows[0].status, 'OPEN');
});

test('Cal eProcure parser excludes non-posted events', () => {
  const html = `<table><tr><td>7100</td><td>Employment Development Dept</td><td>0000038200</td><td>Courier Services</td><td>Sell</td><td>RFx</td><td>03/12/2026 10:00AM PDT</td><td>Closed</td><td>Andrea Kunze</td><td>andrea@example.gov</td></tr></table>`;
  assert.equal(parseCalEProcureRows(html).length, 0);
});

test('Cal eProcure connector is registered and resolves by key', () => {
  assert.ok(listConnectorKeys().includes('CA_CALEPROCURE_CSCR'));
  const connector = resolveConnector({
    publisher: { publisher_name: 'State of California — California State Contracts Register (CSCR) / Cal eProcure', configuration: { connector_key: 'CA_CALEPROCURE_CSCR' } },
    assignment: {}
  });
  assert.equal(connector.key, 'CA_CALEPROCURE_CSCR');
});
