import { response, parseBody, requireDashboardAuth, db } from './_shared/native-runtime.js';

const txt = value => String(value ?? '').trim();

export const handler = async event => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!requireDashboardAuth(event)) return response(401, { error: 'Unauthorized' });
  try {
    const body = parseBody(event);
    const stateCode = txt(body.state_code).toUpperCase();
    if (!/^[A-Z]{2}$/.test(stateCode)) return response(400, { error: 'Valid state_code is required.' });

    const [profiles, publishers] = await Promise.all([
      db(`county_expansion_profiles?state_code=eq.${encodeURIComponent(stateCode)}&select=id,state_code,county_name,county_fips,priority_tier,expansion_score,discovery_status,publishers_discovered,platforms_identified,class_a_platforms&order=county_name.asc`).catch(() => []),
      db(`publisher_registry?state_code=eq.${encodeURIComponent(stateCode)}&county_name=not.is.null&select=county_name,county_fips`).catch(() => [])
    ]);

    const counties = new Map();
    for (const row of profiles || []) {
      const name = txt(row.county_name);
      if (!name) continue;
      counties.set(name.toLowerCase(), {
        county_profile_id: row.id,
        state_code: stateCode,
        county_name: name,
        county_fips: txt(row.county_fips) || null,
        priority_tier: row.priority_tier || null,
        expansion_score: row.expansion_score == null ? null : Number(row.expansion_score),
        discovery_status: row.discovery_status || 'NOT_STARTED',
        publishers_discovered: Number(row.publishers_discovered || 0),
        platforms_identified: Number(row.platforms_identified || 0),
        class_a_platforms: Number(row.class_a_platforms || 0)
      });
    }
    for (const row of publishers || []) {
      const name = txt(row.county_name);
      if (!name) continue;
      const key = name.toLowerCase();
      if (!counties.has(key)) counties.set(key, {
        county_profile_id: null,
        state_code: stateCode,
        county_name: name,
        county_fips: txt(row.county_fips) || null,
        priority_tier: null,
        expansion_score: null,
        discovery_status: 'PUBLISHER_PROFILE_PRESENT',
        publishers_discovered: 0,
        platforms_identified: 0,
        class_a_platforms: 0
      });
    }

    return response(200, {
      state_code: stateCode,
      county_scope_required: true,
      counties: [...counties.values()].sort((a, b) => a.county_name.localeCompare(b.county_name))
    });
  } catch (error) {
    console.error('command-county-options failed', error);
    return response(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
