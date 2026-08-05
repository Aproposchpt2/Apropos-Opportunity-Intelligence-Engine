import { response, requireDashboardAuth, db } from './_shared/native-runtime.js';

const lower = value => String(value || '').toLowerCase();

async function readAll(path, pageSize = 1000, maxPages = 100) {
  const rows = [];
  for (let page = 0; page < maxPages; page += 1) {
    const start = page * pageSize;
    const end = start + pageSize - 1;
    const batch = await db(path, {
      headers: {
        Range: `${start}-${end}`,
        'Range-Unit': 'items'
      }
    });
    if (!Array.isArray(batch)) throw new Error('Inventory query did not return a record array.');
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
  throw new Error('Inventory query exceeded the governed pagination ceiling.');
}

export const handler = async event => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });

  try {
    const [contracts, publishers] = await Promise.all([
      readAll('state_contract_opportunities?select=id,status,response_deadline'),
      readAll('publisher_registry?select=id,verified')
    ]);

    const observedAt = new Date();
    const currentContracts = contracts.filter(contract => {
      if (lower(contract.status) !== 'open') return false;
      if (!contract.response_deadline) return true;
      const deadline = new Date(contract.response_deadline);
      return Number.isFinite(deadline.getTime()) && deadline > observedAt;
    }).length;

    return response(200, {
      generated_at: observedAt.toISOString(),
      current_contracts: currentContracts,
      total_contract_records: contracts.length,
      publishers: publishers.length,
      verified_publishers: publishers.filter(publisher => publisher.verified === true).length,
      definitions: {
        current_contracts: 'status=open and response deadline is either absent or still in the future',
        publishers: 'all records currently stored in publisher_registry'
      },
      sources: {
        current_contracts: 'state_contract_opportunities',
        publishers: 'publisher_registry'
      }
    });
  } catch (error) {
    console.error('command-dashboard-inventory failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
