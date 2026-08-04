const ALLOWED_COMMAND_RUN_ID = '5ee86db3-fdac-4a5d-be29-7a5046effb96';
const ALLOWED_DISCOVERY_RUN_ID = 'b29cada5-0db2-4446-98d4-5d61c206eb16';
const FUNCTION_NAME = 'publisher-discovery-checkpoint-worker';
const QUALIFICATION_RULESET = 'NATCORP-CONTRACT-QUALIFICATION-V3';
const TAXONOMY_VERSION = 'APIE-PSR-TAXONOMY-2026.08.03-V3';
const ENTITY_CLASSES = [
  'Federal departments and agencies',
  'Federal courts and government corporations',
  'State agencies, departments, boards, commissions and constitutional offices',
  'Counties, county departments and county constitutional offices',
  'Cities and municipal departments',
  'Towns, villages, boroughs and townships',
  'Special districts',
  'Water, sewer, sanitation and irrigation districts',
  'Public utility districts and municipal utilities',
  'Transportation authorities and transit agencies',
  'Airports and airport authorities',
  'Ports and harbor authorities',
  'Housing authorities',
  'Redevelopment, economic development and industrial development authorities',
  'Convention and visitors authorities',
  'Public safety and emergency-service districts',
  'Fire protection districts',
  'Public health districts',
  'Library districts and library systems',
  'Parks and recreation districts',
  'Courts and judicial agencies',
  'Correctional institutions and juvenile facilities',
  'Public-benefit corporations and government-owned corporations',
  'Public hospitals, hospital districts, veterans homes and public care facilities',
  'Federally qualified health centers',
  'School districts',
  'Charter schools and charter-school networks',
  'Educational service agencies',
  'Community colleges and technical colleges',
  'University systems and individual campuses',
  'Cooperative purchasing organizations and purchasing consortia',
  'Regional councils of governments',
  'Metropolitan planning organizations',
  'Workforce development boards',
  'Tribal governments, tribal enterprises, tribal utilities, colleges and health systems',
  'Quasi-governmental organizations and authorities receiving public funding',
  'Prime contractors seeking subcontractors',
  'Construction managers, program managers, design-build teams and EPC contractors issuing bid packages',
  'Nonprofit institutions administering publicly funded programs',
  'Federal, state and local grant recipients purchasing goods or services with grant funds',
  'Procurement portals, public bid boards and supplemental public-notice publishers'
];

const txt = (value) => String(value ?? '').trim();
const arr = (value) => Array.isArray(value) ? value : [];
const now = () => new Date().toISOString();
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

function env(name) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function dbHeaders(overrides = {}) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...overrides
  };
}

async function db(path, init = {}) {
  const url = env('SUPABASE_URL').replace(/\/$/, '');
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: dbHeaders(init.headers || {})
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const detail = data && typeof data === 'object'
      ? data.message || data.hint || data.details || data.error
      : txt(data);
    throw new Error(detail || `Database request failed (${response.status})`);
  }
  return data;
}

function parseScope(scope) {
  const [kind, fips, ...nameParts] = txt(scope).split('|');
  return {
    geographicScope: txt(kind).toUpperCase(),
    countyFips: txt(fips) || null,
    countyName: nameParts.join('|').trim() || null
  };
}

function outputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  for (const item of arr(data?.output)) {
    for (const part of arr(item?.content)) {
      if (part?.type === 'output_text' && typeof part.text === 'string') return part.text;
    }
  }
  return '';
}

function parseJson(text) {
  const cleaned = txt(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('Publisher research returned invalid JSON.');
  }
}

function canonical(value) {
  return txt(value).toLowerCase().replace(/^the\s+/, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
}

function bool(value) {
  return value === true ? true : value === false ? false : null;
}

function boundedScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function normalizeCandidate(candidate, context) {
  const method = txt(candidate.acquisition_method).toUpperCase() || 'UNASSESSED';
  const api = candidate.api_available === true;
  const rss = candidate.rss_available === true;
  const csv = candidate.csv_available === true;
  const jsonAvailable = candidate.json_available === true;
  const xml = candidate.xml_available === true;
  const openData = candidate.open_data_available === true;
  const login = candidate.login_required === true || candidate.authentication_required === true;
  const stateful = candidate.stateful_session_required === true;
  const javascript = candidate.javascript_required === true;
  const browser = candidate.browser_automation_required === true;
  let accessClass = txt(candidate.access_class).toUpperCase();
  if (!['CLASS_A', 'CLASS_B', 'CLASS_C', 'CLASS_D'].includes(accessClass)) {
    if (login) accessClass = 'CLASS_C';
    else if (api || rss || csv || jsonAvailable || xml || openData || method === 'API' || method === 'DOCUMENT_FEED') accessClass = 'CLASS_A';
    else if (stateful || javascript || browser || method === 'PUBLIC_PORTAL') accessClass = 'CLASS_B';
    else if (method === 'PUBLIC_SEARCH') accessClass = 'CLASS_A';
    else accessClass = 'CLASS_D';
  }
  const machine = typeof candidate.machine_to_machine_supported === 'boolean'
    ? candidate.machine_to_machine_supported
    : accessClass === 'CLASS_A';
  const connectorStrategy = txt(candidate.recommended_connector_strategy || candidate.connector_strategy).toUpperCase()
    || ({ CLASS_A: 'DIRECT_NETLIFY_CONNECTOR', CLASS_B: 'STATEFUL_SESSION_OR_HEADLESS_BROWSER', CLASS_C: 'AUTHORIZED_ACCOUNT_INTEGRATION', CLASS_D: 'PUBLISHER_OR_PLATFORM_AGREEMENT' }[accessClass]);
  const complexity = txt(candidate.engineering_complexity).toUpperCase()
    || ({ CLASS_A: 'LOW', CLASS_B: 'HIGH', CLASS_C: 'HIGH', CLASS_D: 'VERY_HIGH' }[accessClass]);
  const sources = [...new Set(arr(candidate.official_sources).map(txt).filter(Boolean))];
  const endpoint = txt(candidate.search_endpoint || candidate.procurement_website || candidate.official_website) || null;
  return {
    ...candidate,
    publisher_name: txt(candidate.publisher_name || candidate.organization_name),
    organization_type: txt(candidate.organization_type) || null,
    official_website: txt(candidate.official_website) || null,
    procurement_website: txt(candidate.procurement_website) || null,
    acquisition_method: method,
    search_endpoint: endpoint,
    vendor_registration_url: txt(candidate.vendor_registration_url) || null,
    procurement_platform: txt(candidate.procurement_platform) || null,
    technology_vendor: txt(candidate.technology_vendor || candidate.platform_vendor) || null,
    registration_required: bool(candidate.registration_required),
    authentication_required: login,
    official_sources: sources,
    official_source_verified: candidate.official_source_verified === true && sources.length > 0,
    county_name: context.countyName,
    county_fips: context.countyFips,
    access_class: accessClass,
    machine_to_machine_supported: machine,
    api_available: api,
    rss_available: rss,
    csv_available: csv,
    json_available: jsonAvailable,
    xml_available: xml,
    open_data_available: openData,
    login_required: login,
    stateful_session_required: stateful,
    javascript_required: javascript,
    browser_automation_required: browser,
    pagination_method: txt(candidate.pagination_method) || null,
    detail_resolution_method: txt(candidate.detail_resolution_method) || null,
    attachment_retrieval_method: txt(candidate.attachment_retrieval_method) || null,
    anti_automation_indicators: arr(candidate.anti_automation_indicators).map(txt).filter(Boolean),
    connector_strategy: connectorStrategy,
    engineering_complexity: complexity,
    reuse_score: boundedScore(candidate.reuse_score),
    connector_roi_score: boundedScore(candidate.connector_roi_score),
    publisher_role: txt(candidate.publisher_role).toUpperCase() || 'DIRECT_PUBLIC_BUYER',
    opportunity_channel: txt(candidate.opportunity_channel).toUpperCase() || 'PUBLIC_CONTRACT',
    jurisdiction_level: txt(candidate.jurisdiction_level).toUpperCase() || null,
    public_funding_basis: txt(candidate.public_funding_basis) || null,
    geographic_coverage: arr(candidate.geographic_coverage).map(txt).filter(Boolean)
  };
}

function promptFor(context, entityClass, unitKey) {
  return `Research official procurement opportunity publishers with a direct operational, purchasing, service-area, facility, project, or program nexus to ${context.countyName}, ${context.stateCode} (county FIPS ${context.countyFips}).\n\nAssigned publisher class: ${entityClass}\nCheckpoint: ${unitKey}\n\nA qualifying publisher actually issues, administers, or distributes active solicitations, bid packages, cooperative contracts, subcontracting opportunities, or publicly funded purchases. Do not return an organization merely because it exists. Do not broaden this assignment into unrestricted statewide discovery. Statewide or federal entities qualify only when they buy for, operate in, serve, fund, or maintain a clear procurement nexus to ${context.countyName}.\n\nUse official organization, procurement, open-data, vendor, platform, or authorized portal sources. Identify the most direct current opportunity-search endpoint. Classify the procurement platform and machine-access method. Never claim API or machine access without official or technical evidence. Mark uncertain facts as unknown. Return each publisher once.\n\nReturn ONLY JSON in this schema:\n\"{\\\"candidates\\\":[{\\\"publisher_name\\\":\\\"\\\",\\\"organization_type\\\":\\\"\\\",\\\"publisher_role\\\":\\\"DIRECT_PUBLIC_BUYER|DELEGATED_PUBLIC_BUYER|COOPERATIVE_PURCHASING_PUBLISHER|PUBLICLY_FUNDED_PURCHASER|PRIME_SUBCONTRACTING_PUBLISHER|PROGRAM_MANAGER_BID_PUBLISHER|SUPPLEMENTAL_PROCUREMENT_PUBLISHER\\\",\\\"opportunity_channel\\\":\\\"PUBLIC_CONTRACT|PUBLIC_PURCHASE_ORDER|COOPERATIVE_CONTRACT|SUBCONTRACTING_OPPORTUNITY|CONSTRUCTION_BID_PACKAGE|GRANT_FUNDED_PURCHASE|PUBLICLY_FUNDED_PROGRAM_PURCHE\\\",\\\"jurisdiction_level\\\":\\\"FEDERAL|STATE|COUNTY|MUNICIPAL|REGIONAL|DISTRICT|TRIBAL|INSTITUTIONAL|PRIVATE_PUBLICLY_FUNDED\\\",\\\"public_funding_basis\\\":\\\"\\\",\\\"official_website\\\":\\\"\\\",\\\"procurement_website\\\":\\\"\\\",\\\"acquisition_method\\\":\\\"API|PUBLIC_SEARCH|PUBLIC_PORTAL|DOCUMENT_FEED|UNASSESSED\\\",\\\"search_endpoint\\\":\\\"\\\",\\\"vendor_registration_url\\\":\\\"\\\",\\\"procurement_platform\\\":\\\"\\\",\\\"platform_vendor\\\":\\\"\\\",\\\"registration_required\\\":false,\\\"authentication_required\\\":false,\\\"api_available\\\":false,\\\"rss_available\\\":false,\\\"csv_available\\\":false,\\\"json_available\\\":false,\\\"xml_available\\\":false,\\\"open_data_available\\\":false,\\\"machine_to_machine_supported\\\":false,\\\"stateful_session_required\\\":false,\\\"javascript_required\\\":false,\\\"browser_automation_required\\\":false,\\\"pagination_method\\\":\\\"\\\",\\\"detail_resolution_method\\\":\\\"\\\",\\\"attachment_retrieval_method\\\":\\\"\\\",\\\"anti_automation_indicators\\\":[\\\"\\\"],\\\"access_class\\\":\\\"CLASS_A|CLASS_B|CLASS_C|CLASS_D\\\",\\\"recommended_connector_strategy\\\":\\\"\\\",\\\"engineering_complexity\\\":\\\"LOW|MEDIUM}!%!qqpˆ±qqp‰É•ÕÍ•}Í½É•qqpˆèÀ±qqp‰½¹¹•Ñ½É}É½¥}Í½É•qqpˆèÀ±qqp‰•½É…Á¡¥}½Ù•É…•qqpˆémqqpˆ‘í½¹Ñ•áÐ¹½Õ¹Ñå9…µ•õqqp‰t±qqp‰½™™¥¥…±}Í½ÕÉ•Íqqpˆémqqp‰qqp‰t±qqp‰½™™¥¥…±}Í½ÕÉ•}Ù•É¥™¥•‘qqpˆéÑÉÕ•õuõpˆí€ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸Á…Ñ¡IÕ¸¡¥°Ù…±Õ•Ì¤ì(€…Ý…¥Ð‘ˆ¡½µµ…¹‘}ÉÕ¹Ìý¥õ•Ä¸‘í¥‘õ€°ì(€€€µ•Ñ¡½è€AQ œ°(€€€‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡ì€¸¸¹Ù…±Õ•Ì°±…ÍÑ}…Ñ¥Ù¥Ñå}…Ðè¹½Ü ¤°ÕÁ‘…Ñ•‘}…Ðè¹½Ü ¤ô¤(€ô¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸•ÑA…É•¹Ð¡½µµ…¹‘IÕ¹%¤ì(€É•ÑÕÉ¸€¡…Ý…¥Ð‘ˆ¡½µµ…¹‘}ÉÕ¹Ìý¥õ•Ä¸‘í½µµ…¹‘IÕ¹%‘ô™Í•±•Ðô¨™±¥µ¥ÐôÅ€¤¤ü¹lÁtñð¹Õ±°ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸•Ñ¡¥±¡Á…É•¹ÑIÕ¹%°Õ¹¥Ñ-•ä¤ì(€½¹ÍÐ­•ä€ô•¹½‘•UI%½µÁ½¹•¹Ð¡ÁÕ‰±¥Í¡•Èµ±…ÍÌè‘íÁ…É•¹ÑIÕ¹%‘ôè‘íÕ¹¥Ñ-•åõ€¤ì(€É•ÑÕÉ¸€¡…Ý…¥Ð‘ˆ¡½µµ…¹‘}ÉÕ¹Ìý¥‘•µÁ½Ñ•¹å}­•äõ•Ä¸‘í­•åô™Í•±•Ðô¨™±¥µ¥ÐôÅ€¤¹…Ñ   ¤€ôømt¤¤ü¹lÁtñð¹Õ±°ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸±…¥µ¡¥±¡½¹Ñ•áÐ°Õ¹¥Ñ%¹‘•à¤ì(€½¹ÍÐÕ¹¥Ñ-•ä€ô9Q%Qe}1MM|‘íMÑÉ¥¹œ¡Õ¹¥Ñ%¹‘•à€¬€Ä¤¹Á…‘MÑ…ÉÐ È°€œÀœ¥õ€ì(€½¹ÍÐ•¹Ñ¥Ñå±…ÍÌ€ô9Q%Qe}1MMMmÕ¹¥Ñ%¹‘•átì(€½¹ÍÐ•á¥ÍÑ¥¹œ€ô…Ý…¥Ð•Ñ¡¥±¡½¹Ñ•áÐ¹½µµ…¹‘IÕ¹%°Õ¹¥Ñ-•ä¤ì(€¥˜€¡•á¥ÍÑ¥¹œ€˜˜ÑáÐ¡•á¥ÍÑ¥¹œ¹ÍÑ…ÑÕÌ¤¹Ñ½1½Ý•É…Í” ¤€ôôô€½µÁ±•Ñ•œ¤É•ÑÕÉ¸ìÉ½Üè•á¥ÍÑ¥¹œ°Ñ•Éµ¥¹…°èÑÉÕ”°Õ¹¥Ñ-•ä°•¹Ñ¥Ñå±…ÍÌôì(€¥˜€¡•á¥ÍÑ¥¹œ¤ì(€€€½¹ÍÐ±…ÍÑÑ¥Ù¥Ñä€ô…Ñ”¹Á…ÉÍ”¡•á¥ÍÑ¥¹œ¹±…ÍÑ}…Ñ¥Ù¥Ñå}…Ðñð•á¥ÍÑ¥¹œ¹ÍÑ…ÉÑ•‘}…Ðñð€œœ¤ì(€€€½¹ÍÐ¥ÍÉ•Í¡IÕ¹¹¥¹œ€ôÑáÐ¡•á¥ÍÑ¥¹œ¹ÍÑ…ÑÕÌ¤¹Ñ½1½Ý•É…Í” ¤€ôôô€ÉÕ¹¹¥¹œœ€˜˜9Õµ‰•È¹¥Í¥¹¥Ñ”¡±…ÍÑÑ¥Ù¥Ñä¤€˜˜…Ñ”¹¹½Ü ¤€´±…ÍÑÑ¥Ù¥Ñä€ð€Ô€¨€ØÀ€¨€ÄÀÀÀì(€€€¥˜€¡¥ÍÉ•Í¡IÕ¹¹¥¹œ¤É•ÑÕÉ¸ìÉ½Üè•á¥ÍÑ¥¹œ°Ñ•Éµ¥¹…°è™…±Í”°‰ÕÍäèÑÉÕ”°Õ¹¥Ñ-•ä°•¹Ñ¥Ñå±…ÍÌôì(€€€…Ý…¥ÐÁ…Ñ¡IÕ¸¡•á¥ÍÑ¥¹œ¹¥°ì(€€€€€ÍÑ…ÑÕÌè€ÉÕ¹¹¥¹œœ°……‘Á}ÍÑ…Ñ”è€IU99%9œ°ÕÉÉ•¹Ñ}ÍÑ…”è€9Q%Qe}1MM}IMI œ°ÁÉ½É•ÍÍ}Ù…±Õ”è€Ô°(€€€€€½µÁ±•Ñ•‘}…Ðè¹Õ±°°…Ñ¥½¹}É•ÅÕ¥É•è™…±Í”°™…¥±ÕÉ•}½Õ¹Ðè€À°(€€€€€É•ÍÕ±Ñ}ÍÕµµ…Éäè¡•­Á½¥¹ÐÉ•Á…¥È¥ÌÁÉ½•ÍÍ¥¹œ€‘í•¹Ñ¥Ñå±…ÍÍô¹€°(€€€€€•á•ÕÑ¥½¹}•Ù¥‘•¹”èì€¸¸¸¡•á¥ÍÑ¥¹œ¹•á•ÕÑ¥½¹}•Ù¥‘•¹”ñðíô¤°ÍÑÉ…Ñ•å-•äèÕ¹¥Ñ-•ä°Í•ÅÕ•¹”èÕ¹¥Ñ%¹‘•à€¬€Ä°•¹Ñ¥Ñå±…ÍÌ°¡•­Á½¥¹Ñ}µ½‘•°è€MUA	M}=9}U9%Q}AI}%9Y=Q%=8œô(€€€ô¤ì(€€€É•ÑÕÉ¸ìÉ½Üè•á¥ÍÑ¥¹œ°Ñ•Éµ¥¹…°è™…±Í”°Õ¹¥Ñ-•ä°•¹Ñ¥Ñå±…ÍÌôì(€ô(€½¹ÍÐÉ•…Ñ•€ô…Ý…¥Ð‘ˆ ½µµ…¹‘}ÉÕ¹Ìœ°ì(€€€µ•Ñ¡½è€A=MPœ°(€€€‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡ì(€€€€€¥‘•µÁ½Ñ•¹å}­•äèÁÕ‰±¥Í¡•Èµ±…ÍÌè‘í½¹Ñ•áÐ¹½µµ…¹‘IÕ¹%‘ôè‘íÕ¹¥Ñ-•åõ€°(€€€€€ÍÑ…ÑÕÌè€ÉÕ¹¹¥¹œœ°……‘Á}ÍÑ…Ñ”è€IU99%9œ°µ¥ÍÍ¥½¹}ÑåÁ•}­•äè€AU	1%M!I}%M=YIe}1MLœ°(€€€€€µ¥ÍÍ¥½¹}¹…µ”è€‘í½¹Ñ•áÐ¹ÍÑ…Ñ•½‘•ôƒŠP€‘í•¹Ñ¥Ñå±…ÍÍõ€°ÍÑ…Ñ•}½‘”è½¹Ñ•áÐ¹ÍÑ…Ñ•½‘”°(€€€€€…ÍÍ¥¹•‘}…•¹Ðè€AÕ‰±¥Í¡•ÈáÁ…¹Í¥½¸œ°Á…É•¹Ñ}ÉÕ¹}¥è½¹Ñ•áÐ¹½µµ…¹‘IÕ¹%°(€€€€€ÕÉÉ•¹Ñ}ÍÑ…”è€9Q%Qe}1MM}IMI œ°ÍÑ…ÉÑ•‘}…Ðè¹½Ü ¤°±…ÍÑ}…Ñ¥Ù¥Ñå}…Ðè¹½Ü ¤°(€€€€€ÁÉ½É•ÍÍ}µ½‘”è€MQœ°ÁÉ½É•ÍÍ}Ù…±Õ”è€Ô°(€€€€€É•ÍÕ±Ñ}ÍÕµµ…ÉäèM•…É¡¥¹œ€‘í•¹Ñ¥Ñå±…ÍÍô¥¸€‘í½¹Ñ•áÐ¹½Õ¹Ñå9…µ•ô¹€°(€€€€€•á•ÕÑ¥½¹}•Ù¥‘•¹”èìÍÑÉ…Ñ•å-•äèÕ¹¥Ñ-•ä°Í•ÅÕ•¹”èÕ¹¥Ñ%¹‘•à€¬€Ä°•¹Ñ¥Ñå±…ÍÌ°‘¥Í½Ù•Éå}Í½Á”è½¹Ñ•áÐ¹‘¥Í½Ù•ÉåM½Á”°¡•­Á½¥¹Ñ}µ½‘•°è€MUA	M}=9}U9%Q}AI}%9Y=Q%=8œô(€€€ô¤(€ô¤ì(€É•ÑÕÉ¸ìÉ½ÜèÉ•…Ñ•ü¹lÁtñð¹Õ±°°Ñ•Éµ¥¹…°è™…±Í”°Õ¹¥Ñ-•ä°•¹Ñ¥Ñå±…ÍÌôì)ô()…Íå¹Œ™Õ¹Ñ¥½¸É•Í•…É ¡½¹Ñ•áÐ°•¹Ñ¥Ñå±…ÍÌ°Õ¹¥Ñ-•ä¤ì(€½¹ÍÐ­•ä€ô•¹Ø =A9%}A%}-dœ¤ì(€½¹ÍÐµ½‘•°€ô•¹¼¹•¹Ø¹•Ð =A9%}%M=YIe}5=0œ¤ñð€ÁÐ´Ô¸ØµÑ•ÉÉ„œì(€±•Ð±…ÍÑÉÉ½Èì(€™½È€¡±•Ð…ÑÑ•µÁÐ€ô€Äì…ÑÑ•µÁÐ€ðô€Èì…ÑÑ•µÀ¬¬¤ì(€€€ÑÉäì(€€€€€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð™•Ñ  ¡ÑÑÁÌè¼½…Á¤¹½Á•¹…¤¹½´½ØÄ½É•ÍÁ½¹Í•Ìœ°ì(€€€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€€€¡•…‘•ÉÌèìÕÑ¡½É¥é…Ñ¥½¸è	•…É•È€‘í­•åõ€°€½¹Ñ•¹ÐµQåÁ”œè€…ÁÁ±¥…Ñ¥½¸½©Í½¸œô°(€€€€€€€‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡ì(€€€€€€€€€µ½‘•°°(€€€€€€€€€É•…Í½¹¥¹œèì•™™½ÉÐè€±½Üœô°(€€€€€€€€€Ñ½½±ÌèmìÑåÁ”è€Ý•‰}Í•…É œ°Í•…É¡}½¹Ñ•áÑ}Í¥é”è€¡¥ œõt°(€€€€€€€€€¥¹ÁÕÐèÁÉ½µÁÑ½È¡½¹Ñ•áÐ°•¹Ñ¥Ñå±…ÍÌ°Õ¹¥Ñ-•ä¤(€€€€€€€ô¤°(€€€€€€€Í¥¹…°è‰½ÉÑM¥¹…°¹Ñ¥µ•½ÕÐ ÄÄÀÀÀÀ¤(€€€€€ô¤ì(€€€€€½¹ÍÐ‘…Ñ„€ô…Ý…¥ÐÉ•ÍÁ½¹Í”¹©Í½¸ ¤¹…Ñ   ¤€ôø€¡íô¤¤ì(€€€€€¥˜€ …É•ÍÁ½¹Í”¹½¬¤ì(€€€€€€€½¹ÍÐµ•ÍÍ…”€ôÑáÐ¡‘…Ñ„ü¹•ÉÉ½Èü¹µ•ÍÍ…”¤ñð€Õ¹­¹½Ý¸ÁÉ½Ù¥‘•È•ÉÉ½Èœì(€€€€€€€½¹ÍÐ•ÉÉ½È€ô¹•ÜÉÉ½È¡€‘íÕ¹¥Ñ-•åô™…¥±•€ ‘íÉ•ÍÁ½¹Í”¹ÍÑ…ÑÕÍô¤è€‘íµ•ÍÍ…•õ€¤ì(€€€€€€€•ÉÉ½È¹™…Ñ…°€ôÉ•ÍÁ½¹Í”¹ÍÑ…ÑÕÌ€ôôô€ÐÀÄñðÉ•ÍÁ½¹Í”¹ÍÑ…ÑÕÌ€ôôô€ÐÀÌñð€¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÌ€ôôô€ÐÈä€˜˜€½É•‘¥ÑñÅÕ½Ñ…ñ‰¥±±¥¹œ½¤¹Ñ•ÍÐ¡µ•ÍÍ…”¤¤ì(€€€€€€€•ÉÉ½È¹…ÑÑ•µÁÑÌ€ô…ÑÑ•µÁÐì(€€€€€€€Ñ¡É½Ü•ÉÉ½Èì(€€€€€ô(€€€€€½¹ÍÐÁ…ÉÍ•€ôÁ…ÉÍ•)Í½¸¡½ÕÑÁÕÑQ•áÐ¡‘…Ñ„¤¤ì(€€€€€½¹ÍÐÍ••¸€ô¹•ÜM•Ð ¤ì(€€€€€½¹ÍÐ…¹‘¥‘…Ñ•Ì€ômtì(€€€€€™½È€¡½¹ÍÐÉ…Ü½˜…ÉÈ¡Á…ÉÍ•ü¹…¹‘¥‘…Ñ•Ì¤¤ì(€€€€€€€½¹ÍÐ…¹‘¥‘…Ñ”€ô¹½Éµ…±¥é•…¹‘¥‘…Ñ”¡É…Ü°½¹Ñ•áÐ¤ì(€€€€€€€½¹ÍÐ­•å9…µ”€ô…¹½¹¥…°¡…¹‘¥‘…Ñ”¹ÁÕ‰±¥Í¡•É}¹…µ”¤ì(€€€€€€€¥˜€ …­•å9…µ”ñðÍ••¸¹¡…Ì¡­•å9…µ”¤¤½¹Ñ¥¹Õ”ì(€€€€€€€Í••¸¹…‘¡­•å9…µ”¤ì(€€€€€€€…¹‘¥‘…Ñ•Ì¹ÁÕÍ ¡…¹‘¥‘…Ñ”¤ì(€€€€€ô(€€€€€É•ÑÕÉ¸ì…¹‘¥‘…Ñ•Ì°…ÑÑ•µÁÑÌ°µ½‘•°ôì(€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€±…ÍÑÉÉ½È€ô•ÉÉ½Èì(€€€€€¥˜€¡•ÉÉ½Èü¹™…Ñ…°€ôôôÑÉÕ”ñð…ÑÑ•µÁÐ€ôôô€È¤Ñ¡É½Ü•ÉÉ½Èì(€€€€€…Ý…¥Ð¹•ÜAÉ½µ¥Í” ¡É•Í½±Ù”¤€ôøÍ•ÑQ¥µ•½ÕÐ¡É•Í½±Ù”°€ÄÔÀÀ¤¤ì(€€€ô(€ô(€Ñ¡É½Ü±…ÍÑÉÉ½Èñð¹•ÜÉÉ½È AÕ‰±¥Í¡•ÈÉ•Í•…É ™…¥±•¸œ¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸ÍÑ…•…¹‘¥‘…Ñ”¡½¹Ñ•áÐ°…¹‘¥‘…Ñ”°Õ¹¥Ñ-•ä°•¹Ñ¥Ñå±…ÍÌ¤ì(€½¹ÍÐ•á¥ÍÑ¥¹AÕ‰±¥Í¡•È€ô€¡…Ý…¥Ð‘ˆ¡ÁÕ‰±¥Í¡•É}É•¥ÍÑÉäýÁÕ‰±¥Í¡•É}¹…µ”õ•Ä¸‘í•¹½‘•UI%½µÁ½¹•¹Ð¡…¹‘¥‘…Ñ”¹ÁÕ‰±¥Í¡•É}¹…µ”¥ô™ÍÑ…Ñ•}½‘”õ•Ä¸‘í½¹Ñ•áÐ¹ÍÑ…Ñ•½‘•ô™Í•±•Ðô¨™±¥µ¥ÐôÅ€¤¹…Ñ   ¤€ôømt¤¤ü¹lÁtñð¹Õ±°ì(€½¹ÍÐ•±¥¥‰±”€ô…¹‘¥‘…Ñ”¹½™™¥¥…±}Í½ÕÉ•}Ù•É¥™¥•€˜˜lA$œ°€AU	1%}MI œ°€AU	1%}A=IQ0œ°€=U59Q}t¹¥¹±Õ‘•Ì¡…¹‘¥‘…Ñ”¹…ÅÕ¥Í¥Ñ¥½¹}µ•Ñ¡½¤€˜˜	½½±•…¸¡…¹‘¥‘…Ñ”¹Í•…É¡}•¹‘Á½¥¹Ð¤ì(€½¹ÍÐÙ…±Õ•Ì€ôì(€€€‘¥Í½Ù•Éå}ÉÕ¹}¥è½¹Ñ•áÐ¹‘¥Í½Ù•ÉåIÕ¹%°(€€€ÁÕ‰±¥Í¡•É}¹…µ”è…¹‘¥‘…Ñ”¹ÁÕ‰±¥Í¡•É}¹…µ”°(€€€ÍÑ…Ñ•}½‘”è½¹Ñ•áÐ¹ÍÑ…Ñ•½‘”°(€€€½Õ¹Ñå}¹…µ”è½¹Ñ•áÐ¹½Õ¹Ñå9…µ”°(€€€½Õ¹Ñå}™¥ÁÌè½¹Ñ•áÐ¹½Õ¹Ñå¥ÁÌ°(€€€½É…¹¥é…Ñ¥½¹}ÑåÁ”è…¹‘¥‘…Ñ”¹½É…¹¥é…Ñ¥½¹}ÑåÁ”ñð•¹Ñ¥Ñå±…ÍÌ°(€€€½™™¥¥…±}Ý•‰Í¥Ñ”è…¹‘¥‘…Ñ”¹½™™¥¥…±}Ý•‰Í¥Ñ”°(€€€ÁÉ½ÕÉ•µ•¹Ñ}Ý•‰Í¥Ñ”è…¹‘¥‘…Ñ”¹ÁÉ½ÕÉ•µ•¹Ñ}Ý•‰Í¥Ñ”°(€€€…ÅÕ¥Í¥Ñ¥½¹}µ•Ñ¡½è…¹‘¥‘…Ñ”¹…ÅÕ¥Í¥Ñ¥½¹}µ•Ñ¡½°(€€€Í•…É¡}•¹‘Á½¥¹Ðè…¹‘¥‘…Ñ”¹Í•…É¡}•¹‘Á½¥¹Ð°(€€€Ù•¹‘½É}É•¥ÍÑÉ…Ñ¥½¹}ÕÉ°è…¹‘¥‘…Ñ”¹Ù•¹‘½É}É•¥ÍÑÉ…Ñ¥½¹}ÕÉ°°(€€€ÁÉ½ÕÉ•µ•¹Ñ}Á±…Ñ™½É´è…¹‘¥‘…Ñ”¹ÁÉ½ÕÉ•µ•¹Ñ}Á±…Ñ™½É´°(€€€Ñ•¡¹½±½å}Ù•¹‘½Èè…¹‘¥‘…Ñ”¹Ñ•¡¹½±½å}Ù•¹‘½È°(€€€É•¥ÍÑÉ…Ñ¥½¹}É•ÅÕ¥É•è…¹‘¥‘…Ñ”¹É•¥ÍÑÉ…Ñ¥½¹}É•ÅÕ¥É•°(€€€…•ÍÍ}±…ÍÌè…¹‘¥‘…Ñ”¹…•ÍÍ}±…ÍÌ°(€€€µ…¡¥¹•}Ñ½}µ…¡¥¹•}ÍÕÁÁ½ÉÑ•è…¹‘¥‘…Ñ”¹µ…¡¥¹•}Ñ½}µ…¡¥¹•}ÍÕÁÁ½ÉÑ•°(€€€½¹¹•Ñ½É}ÍÑÉ…Ñ•äè…¹‘¥‘…Ñ”¹½¹¹•Ñ½É}ÍÑÉ…Ñ•ä°(€€€•¹¥¹••É¥¹}½µÁ±•á¥Ñäè…¹‘¥‘…Ñ”¹•¹¥¹••É¥¹}½µÁ±•á¥Ñä°(€€€É•ÕÍ•}Í½É”è…¹‘¥‘…Ñ”¹É•ÕÍ•}Í½É”°(€€€½¹¹•Ñ½É}É½¥}Í½É”è…¹‘¥‘…Ñ”¹½¹¹•Ñ½É}É½¥}Í½É”°(€€€½™™¥¥…±}Í½ÕÉ•Ìè…¹‘¥‘…Ñ”¹½™™¥¥…±}Í½ÕÉ•Ì°(€€€½™™¥¥…±}Í½ÕÉ•}Ù•É¥™¥•è…¹‘¥‘…Ñ”¹½™™¥¥…±}Í½ÕÉ•}Ù•É¥™¥•°(€€€‘ÕÁ±¥…Ñ•}ÁÕ‰±¥Í¡•É}¥è•á¥ÍÑ¥¹AÕ‰±¥Í¡•Èü¹¥ñð¹Õ±°°(€€€‘ÕÁ±¥…Ñ•}ÍÑ…ÑÕÌè•á¥ÍÑ¥¹AÕ‰±¥Í¡•È€ü€a%MQ%9}I%MQIe}5Q œ€è€9=}5Q œ°(€€€É•Ù¥•Ý}ÍÑ…ÑÕÌè•±¥¥‰±”€ü€UQ=}AAI=Yœ€è€aAQ%=9}IY%\œ°(€€€É•Ù¥•Ý}¹½Ñ•Ìè•±¥¥‰±”€üY…±¥‘…Ñ•‰ä€‘íÕ¹¥Ñ-•åôè€‘í•¹Ñ¥Ñå±…ÍÍô¹€€è€‘íÕ¹¥Ñ-•åôÉ•ÅÕ¥É•Ì•á•ÁÑ¥½¸É•Ù¥•Ü¹€°(€€€É•Ù¥•Ý•‘}…Ðè¹½Ü ¤°(€€€ÕÁ‘…Ñ•‘}…Ðè¹½Ü ¤(€ôì(€±•ÐÍÑ…•ì(€ÑÉäì(€€€ÍÑ…•€ô€¡…Ý…¥Ð‘ˆ ÁÕ‰±¥Í¡•É}‘¥Í½Ù•Éå}…¹‘¥‘…Ñ•Ìœ°ìµ•Ñ¡½è€A=MPœ°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡Ù…±Õ•Ì¤ô¤¤ü¹lÁtñð¹Õ±°ì(€ô…Ñ €¡•ÉÉ½È¤ì(€€€½¹ÍÐÉ½ÝÌ€ô…Ý…¥Ð‘ˆ¡ÁÕ‰±¥Í¡•É}‘¥Í½Ù•Éå}…¹‘¥‘…Ñ•Ìý‘¥Í½Ù•Éå}ÉÕ¹}¥õ•Ä¸‘í½¹Ñ•áÐ¹‘¥Í½Ù•ÉåIÕ¹%‘ô™ÁÕ‰±¥Í¡•É}¹…µ”õ•Ä¸‘í•¹½‘•UI%½µÁ½¹•¹Ð¡…¹‘¥‘…Ñ”¹ÁÕ‰±¥Í¡•É}¹…µ”¥ô™Í•±•Ðô¨™±¥µ¥ÐôÅ€¤¹…Ñ   ¤€ôømt¤ì(€€€ÍÑ…•€ôÉ½ÝÌü¹lÁtñð¹Õ±°ì(€€€¥˜€¡ÍÑ…•ü¹¥¤ì(€€€€€…Ý…¥Ð‘ˆ¡ÁÕ‰±¥Í¡•É}‘¥Í½Ù•Éå}…¹‘¥‘…Ñ•Ìý¥õ•Ä¸‘íÍÑ…•¹¥‘õ€°ìµ•Ñ¡½è€AQ œ°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡Ù…±Õ•Ì¤ô¤ì(€€€€€ÍÑ…•€ôì€¸¸¹ÍÑ…•°€¸¸¹Ù…±Õ•Ìôì(€€€ô•±Í”Ñ¡É½Ü•ÉÉ½Èì(€ô(€¥˜€ …•±¥¥‰±”¤É•ÑÕÉ¸ìÍÑ…•è€Ä°É•…‘äè€À°•á•ÁÑ¥½¸è€Äôì((€½¹ÍÐ½¹™¥ÕÉ…Ñ¥½¸€ôì(€€€½¹™¥ÕÉ…Ñ¥½¹}Ù•ÉÍ¥½¸è€AU	1%M!Hµ=99Q%=8µXÌœ°(€€€…•ÍÍ}µ•Ñ¡½è…¹‘¥‘…Ñ”¹…ÅÕ¥Í¥Ñ¥½¹}µ•Ñ¡½°(€€€ÁÉ¥µ…Éå}•¹‘Á½¥¹Ðè…¹‘¥‘…Ñ”¹Í•…É¡}•¹‘Á½¥¹Ð°(€€€ÁÉ½ÕÉ•µ•¹Ñ}Á±…Ñ™½É´è…¹‘¥‘…Ñ”¹ÁÉ½ÕÉ•µ•¹Ñ}Á±…Ñ™½É´°(€€€Ñ•¡¹½±½å}Ù•¹‘½Èè…¹‘¥‘…Ñ”¹Ñ•¡¹½±½å}Ù•¹‘½È°(€€€Ù•¹‘½É}É•¥ÍÑÉ…Ñ¥½¹}ÕÉ°è…¹‘¥‘…Ñ”¹Ù•¹‘½É}É•¥ÍÑÉ…Ñ¥½¹}ÕÉ°°(€€€É•¥ÍÑÉ…Ñ¥½¹}É•ÅÕ¥É•è…¹‘¥‘…Ñ”¹É•¥ÍÑÉ…Ñ¥½¹}É•ÅÕ¥É•°(€€€…ÕÑ¡•¹Ñ¥…Ñ¥½¹}É•ÅÕ¥É•è…¹‘¥‘…Ñ”¹…ÕÑ¡•¹Ñ¥…Ñ¥½¹}É•ÅÕ¥É•°(€€€ÁÕ‰±¥}…•ÍÍ}Ù•É¥™¥•è…¹‘¥‘…Ñ”¹½™™¥¥…±}Í½ÕÉ•}Ù•É¥™¥•°(€€€½™™¥¥…±}Í½ÕÉ•Ìè…¹‘¥‘…Ñ”¹½™™¥¥…±}Í½ÕÉ•Ì°(€€€Ñ…á½¹½µå}Ù•ÉÍ¥½¸èQa=9=5e}YIM%=8°(€€€ÁÕ‰±¥Í¡•É}É½±”è…¹‘¥‘…Ñ”¹ÁÕ‰±¥Í¡•É}É½±”°(€€€½ÁÁ½ÉÑÕ¹¥Ñå}¡…¹¹•°è…¹‘¥‘…Ñ”¹½ÁÁ½ÉÑÕ¹¥Ñå}¡…¹¹•°°(€€€©ÕÉ¥Í‘¥Ñ¥½¹}±•Ù•°è…¹‘¥‘…Ñ”¹©ÕÉ¥Í‘¥Ñ¥½¹}±•Ù•°°(€€€ÁÕ‰±¥}™Õ¹‘¥¹}‰…Í¥Ìè…¹‘¥‘…Ñ”¹ÁÕ‰±¥}™Õ¹‘¥¹}‰…Í¥Ì°(€€€•½É…Á¡¥}½Ù•É…”è…¹‘¥‘…Ñ”¹•½É…Á¡¥}½Ù•É…”°(€€€½Õ¹Ñå}¹…µ”è½¹Ñ•áÐ¹½Õ¹Ñå9…µ”°(€€€½Õ¹Ñå}™¥ÁÌè½¹Ñ•áÐ¹½Õ¹Ñå¥ÁÌ°(€€€…•ÍÍ}±…ÍÌè…¹‘¥‘…Ñ”¹…•ÍÍ}±…ÍÌ°(€€€µ…¡¥¹•}Ñ½}µ…¡¥¹•}ÍÕÁÁ½ÉÑ•è…¹‘¥‘…Ñ”¹µ…¡¥¹•}Ñ½}µ…¡¥¹•}ÍÕÁÁ½ÉÑ•°(€€€…Á¥}…Ù…¥±…‰±”è…¹‘¥‘…Ñ”¹…Á¥}…Ù…¥±…‰±”°(€€€ÉÍÍ}…Ù…¥±…‰±”è…¹‘¥‘…Ñ”¹ÉÍÍ}…Ù…¥±…‰±”°(€€€ÍÙ}…Ù…¥±…‰±”è…¹‘¥‘…Ñ”¹ÍÙ}…Ù…¥±…‰±”°(€€€©Í½¹}…Ù…¥±…‰±”è…¹‘¥‘…Ñ”¹©Í½¹}…Ù…¥±…‰±”°(€€€áµ±}…Ù…¥±…‰±”è…¹‘¥‘…Ñ”¹áµ±}…Ù…¥±…‰±”°(€€€½Á•¹}‘…Ñ…}…Ù…¥±…‰±”è…¹‘¥‘…Ñ”¹½Á•¹}‘…Ñ…}…Ù…¥±…‰±”°(€€€±½¥¹}É•ÅÕ¥É•è…¹‘¥‘…Ñ”¹±½¥¹}É•ÅÕ¥É•°(€€€ÍÑ…Ñ•™Õ±}Í•ÍÍ¥½¹}É•ÅÕ¥É•è…¹‘¥‘…Ñ”¹ÍÑ…Ñ•™Õ±}Í•ÍÍ¥½¹}É•ÅÕ¥É•°(€€€©…Ù…ÍÉ¥ÁÑ}É•ÅÕ¥É•è…¹‘¥‘…Ñ”¹©…Ù…ÍÉ¥ÁÑ}É•ÅÕ¥É•°(€€€‰É½ÝÍ•É}…ÕÑ½µ…Ñ¥½¹}É•ÅÕ¥É•è…¹‘¥‘…Ñ”¹‰É½ÝÍ•É}…ÕÑ½µ…Ñ¥½¹}É•ÅÕ¥É•°(€€€Á…¥¹…Ñ¥½¹}µ•Ñ¡½è…¹‘¥‘…Ñ”¹Á…¥¹…Ñ¥½¹}µ•Ñ¡½°(€€€‘•Ñ…¥±}É•Í½±ÕÑ¥½¹}µ•Ñ¡½è…¹‘¥‘…Ñ”¹‘•Ñ…¥±}É•Í½±ÕÑ¥½¹}µ•Ñ¡½°(€€€…ÑÑ…¡µ•¹Ñ}É•ÑÉ¥•Ù…±}µ•Ñ¡½è…¹‘¥‘…Ñ”¹…ÑÑ…¡µ•¹Ñ}É•ÑÉ¥•Ù…±}µ•Ñ¡½°(€€€…¹Ñ¥}…ÕÑ½µ…Ñ¥½¹}¥¹‘¥…Ñ½ÉÌè…¹‘¥‘…Ñ”¹…¹Ñ¥}…ÕÑ½µ…Ñ¥½¹}¥¹‘¥…Ñ½ÉÌ°(€€€½¹¹•Ñ½É}ÍÑÉ…Ñ•äè…¹‘¥‘…Ñ”¹½¹¹•Ñ½É}ÍÑÉ…Ñ•ä°(€€€•¹¥¹••É¥¹}½µÁ±•á¥Ñäè…¹‘¥‘…Ñ”¹•¹¥¹••É¥¹}½µÁ±•á¥Ñä°(€€€É•ÕÍ•}Í½É”è…¹‘¥‘…Ñ”¹É•ÕÍ•}Í½É”°(€€€½¹¹•Ñ½É}É½¥}Í½É”è…¹‘¥‘…Ñ”¹½¹¹•Ñ½É}É½¥}Í½É”°(€€€•ÉÑ¥™¥…Ñ¥½¹}ÍÑ…ÑÕÌè•á¥ÍÑ¥¹AÕ‰±¥Í¡•Èü¹½¹™¥ÕÉ…Ñ¥½¸ü¹•ÉÑ¥™¥…Ñ¥½¹}ÍÑ…ÑÕÌñð€Y1=A59Pœ°(€€€ÅÕ…±¥™¥…Ñ¥½¹}ÉÕ±•Í•ÐèEU1%%Q%=9}IU1MP°(€€€…‘µ¥ÍÍ¥½¹}µ½‘”è€UQ=5Q}=	)Q%Y}Y1%Q%=8œ(€ôì(€½¹ÍÐÁÕ‰±¥Í¡•ÉY…±Õ•Ì€ôì(€€€ÁÕ‰±¥Í¡•É}¹…µ”è…¹‘¥‘…Ñ”¹ÁÕ‰±¥Í¡•É}¹…µ”°(€€€ÍÑ…Ñ•}½‘”è½¹Ñ•áÐ¹ÍÑ…Ñ•½‘”°(€€€½Õ¹Ñå}¹…µ”è½¹Ñ•áÐ¹½Õ¹Ñå9…µ”°(€€€½Õ¹Ñå}™¥ÁÌè½¹Ñ•áÐ¹½Õ¹Ñå¥ÁÌ°(€€€½É…¹¥é…Ñ¥½¹}ÑåÁ”è…¹‘¥‘…Ñ”¹½É…¹¥é…Ñ¥½¹}ÑåÁ”ñð•¹Ñ¥Ñå±…ÍÌ°(€€€½™™¥¥…±}Ý•‰Í¥Ñ”è…¹‘¥‘…Ñ”¹½™™¥¥…±}Ý•‰Í¥Ñ”°(€€€ÁÉ½ÕÉ•µ•¹Ñ}Ý•‰Í¥Ñ”è…¹‘¥‘…Ñ”¹ÁÉ½ÕÉ•µ•¹Ñ}Ý•‰Í¥Ñ”°(€€€…ÅÕ¥Í¥Ñ¥½¹}µ•Ñ¡½è…¹‘¥‘…Ñ”¹…ÅÕ¥Í¥Ñ¥½¹}µ•Ñ¡½°(€€€Í•…É¡}•¹‘Á½¥¹Ðè…¹‘¥‘…Ñ”¹Í•…É¡}•¹‘Á½¥¹Ð°(€€€Ù•¹‘½É}É•¥ÍÑÉ…Ñ¥½¹}ÕÉ°è…¹‘¥‘…Ñ”¹Ù•¹‘½É}É•¥ÍÑÉ…Ñ¥½¹}ÕÉ°°(€€€Ù•É¥™¥•èÑÉÕ”°(€€€…•ÍÍ}ÍÑ…ÑÕÌè€Idœ°(€€€±…ÍÑ}Ù•É¥™¥•‘}…Ðè¹½Ü ¤°(€€€ÕÁ‘…Ñ•‘}…Ðè¹½Ü ¤°(€€€…•ÍÍ}±…ÍÌè…¹‘¥‘…Ñ”¹…•ÍÍ}±…ÍÌ°(€€€µ…¡¥¹•}Ñ½}µ…¡¥¹•}ÍÕÁÁ½ÉÑ•è…¹‘¥‘…Ñ”¹µ…¡¥¹•}Ñ½}µ…¡¥¹•}ÍÕÁÁ½ÉÑ•°(€€€½¹¹•Ñ½É}ÍÑÉ…Ñ•äè…¹‘¥‘…Ñ”¹½¹¹•Ñ½É}ÍÑÉ…Ñ•ä°(€€€•¹¥¹••É¥¹}½µÁ±•á¥Ñäè…¹‘¥‘…Ñ”¹•¹¥¹••É¥¹}½µÁ±•á¥Ñä°(€€€É•ÕÍ•}Í½É”è…¹‘¥‘…Ñ”¹É•ÕÍ•}Í½É”°(€€€½¹¹•Ñ½É}É½¥}Í½É”è…¹‘¥‘…Ñ”¹½¹¹•Ñ½É}É½¥}Í½É”°(€€€½¹™¥ÕÉ…Ñ¥½¸(€ôì(€±•ÐÁÕ‰±¥Í¡•Èì(€¥˜€¡•á¥ÍÑ¥¹AÕ‰±¥Í¡•Èü¹¥¤ì(€€€…Ý…¥Ð‘ˆ¡ÁÕ‰±¥Í¡•É}É•¥ÍÑÉäý¥õ•Ä¸‘í•á¥ÍÑ¥¹AÕ‰±¥Í¡•È¹¥‘õ€°ìµ•Ñ¡½è€AQ œ°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡ÁÕ‰±¥Í¡•ÉY…±Õ•Ì¤ô¤ì(€€€ÁÕ‰±¥Í¡•È€ôì€¸¸¹•á¥ÍÑ¥¹AÕ‰±¥Í¡•È°€¸¸¹ÁÕ‰±¥Í¡•ÉY…±Õ•Ìôì(€ô•±Í”ì(€€€ÁÕ‰±¥Í¡•È€ô€¡…Ý…¥Ð‘ˆ ÁÕ‰±¥Í¡•É}É•¥ÍÑÉäœ°ìµ•Ñ¡½è€A=MPœ°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡ÁÕ‰±¥Í¡•ÉY…±Õ•Ì¤ô¤¤ü¹lÁtñð¹Õ±°ì(€ô(€¥˜€ …ÁÕ‰±¥Í¡•Èü¹¥¤É•ÑÕÉ¸ìÍÑ…•è€Ä°É•…‘äè€À°•á•ÁÑ¥½¸è€Äôì((€½¹ÍÐ…ÍÍ¥¹µ•¹ÑI½ÝÌ€ô…Ý…¥Ð‘ˆ¡ÁÕ‰±¥Í¡•É}…ÍÍ¥¹µ•¹ÑÌýÁÕ‰±¥Í¡•É}¥õ•Ä¸‘íÁÕ‰±¥Í¡•È¹¥‘ô™Í•±•Ðô¨™½É‘•ÈõÕÁ‘…Ñ•‘}…Ð¹‘•ÍŒ™±¥µ¥ÐôÅ€¤¹…Ñ   ¤€ôømt¤ì(€½¹ÍÐ…ÍÍ¥¹µ•¹ÑY…±Õ•Ì€ôì(€€€ÁÕ‰±¥Í¡•É}¥èÁÕ‰±¥Í¡•È¹¥°(€€€ÁÕ‰±¥Í¡•É}¹…µ”èÁÕ‰±¥Í¡•È¹ÁÕ‰±¥Í¡•É}¹…µ”°(€€€…ÅÕ¥Í¥Ñ¥½¹}µ•Ñ¡½è…¹‘¥‘…Ñ”¹…ÅÕ¥Í¥Ñ¥½¹}µ•Ñ¡½°(€€€Í•…É¡}•¹‘Á½¥¹Ðè…¹‘¥‘…Ñ”¹Í•…É¡}•¹‘Á½¥¹Ð°(€€€Í•…É¡}Á…É…µ•Ñ•ÉÌèì(€€€€€ÍÑ…Ñ•}½‘”è½¹Ñ•áÐ¹ÍÑ…Ñ•½‘”°(€€€€€½Õ¹Ñå}¹…µ”è½¹Ñ•áÐ¹½Õ¹Ñå9…µ”°(€€€€€½Õ¹Ñå}™¥ÁÌè½¹Ñ•áÐ¹½Õ¹Ñå¥ÁÌ°(€€€€€Í½ÕÉ”è€AU	1%M!I}%M=YIe}!-A=%9Q}IA%Hœ°(€€€€€½¹¹•Ñ¥½¹}½¹™¥œè½¹™¥ÕÉ…Ñ¥½¸°(€€€€€…•ÍÍ}±…ÍÌè…¹‘¥‘…Ñ”¹…•ÍÍ}±…ÍÌ°(€€€€€½¹¹•Ñ½É}ÍÑÉ…Ñ•äè…¹‘¥‘…Ñ”¹½¹¹•Ñ½É}ÍÑÉ…Ñ•ä(€€€ô°(€€€…ÕÑ¡½É¥é•‘}ÍÑ…ÑÕÍ}É…¹”èl=A8œ°€A=MQœ°€Q%Yt°(€€€Á…¥¹…Ñ¥½¹}¥¹ÍÑÉÕÑ¥½¹Ìèì™½±±½Ý}¹•áÑ}Á…”èÑÉÕ”°ÍÑ½Á}Ý¡•¹}¹½}¹•Ý}½ÁÁ½ÉÑÕ¹¥Ñ¥•ÌèÑÉÕ”ô°(€€€…ÑÑ…¡µ•¹Ñ}¥¹ÍÑÉÕÑ¥½¹Ìèì™½±±½Ý}Í½±¥¥Ñ…Ñ¥½¹}‘½Õµ•¹ÑÌèÑÉÕ”°•áÑÉ…Ñ}É•ÅÕ¥É•µ•¹ÑÍ}™É½µ}‘½Õµ•¹ÑÌèÑÉÕ”°ÁÉ•Í•ÉÙ•}‘½Õµ•¹Ñ}ÕÉ±ÌèÑÉÕ”ô°(€€€…µ•¹‘µ•¹Ñ}¥¹ÍÑÉÕÑ¥½¹Ìèì…ÁÑÕÉ•}…‘‘•¹‘„èÑÉÕ”°±¥¹­}Ñ½}Á…É•¹Ñ}Í½±¥¥Ñ…Ñ¥½¸èÑÉÕ”ô°(€€€•áÁ•Ñ•‘}Í½ÕÉ•}¥‘•¹Ñ¥™¥•ÉÌèlÍ½±¥¥Ñ…Ñ¥½¹}¹Õµ‰•Èœ°€¹½Ñ¥•}¥œ°€ÁÉ½©•Ñ}¥œ°€‰¥‘}¹Õµ‰•Èt°(€€€É…Ý}‘•ÍÑ¥¹…Ñ¥½¸è€…ÅÕ¥Í¥Ñ¥½¹}É…Ý}É•½É‘Ìœ°(€€€ÅÕ…±¥™¥…Ñ¥½¹}ÉÕ±•Í•Ñ}Ù•ÉÍ¥½¸è€@µEU1%%Q%=8µXÈœ°(€€€…½¥•}É•Ù¥•Ý}É•ÅÕ¥É•èÑÉÕ”°(€€€É•ÑÉå}Á½±¥äèìµ…á}…ÑÑ•µÁÑÌè€Ìô°(€€€ÉÕ¹Ñ¥µ•}±¥µ¥Ñ}Í•½¹‘Ìè€ÌØÀÀ°(€€€É•Á½ÉÑ¥¹}É•ÅÕ¥É•µ•¹ÑÌèìÁÉ•Í•ÉÙ•}ÁÉ½Ù•¹…¹”èÑÉÕ”°É•Á½ÉÑ}É•©•Ñ¥½¹ÌèÑÉÕ”°É•Á½ÉÑ}½¹¹•Ñ¥½¹}µ•Ñ¡½‘}ÕÍ•èÑÉÕ”ô°(€€€ÍÑ…ÑÕÌè€Idœ°(€€€ÕÁ‘…Ñ•‘}…Ðè¹½Ü ¤(€ôì(€¥˜€¡…ÍÍ¥¹µ•¹ÑI½ÝÌü¹lÁtü¹¥¤…Ý…¥Ð‘ˆ¡ÁÕ‰±¥Í¡•É}…ÍÍ¥¹µ•¹ÑÌý¥õ•Ä¸‘í…ÍÍ¥¹µ•¹ÑI½ÝÍlÁt¹¥‘õ€°ìµ•Ñ¡½è€AQ œ°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡…ÍÍ¥¹µ•¹ÑY…±Õ•Ì¤ô¤ì(€•±Í”…Ý…¥Ð‘ˆ ÁÕ‰±¥Í¡•É}…ÍÍ¥¹µ•¹ÑÌœ°ìµ•Ñ¡½è€A=MPœ°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡…ÍÍ¥¹µ•¹ÑY…±Õ•Ì¤ô¤ì(€¥˜€¡ÍÑ…•ü¹¥¤…Ý…¥Ð‘ˆ¡ÁÕ‰±¥Í¡•É}‘¥Í½Ù•Éå}…¹‘¥‘…Ñ•Ìý¥õ•Ä¸‘íÍÑ…•¹¥‘õ€°ìµ•Ñ¡½è€AQ œ°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡ì…‘µ¥ÑÑ•‘}ÁÕ‰±¥Í¡•É}¥èÁÕ‰±¥Í¡•È¹¥°ÕÁ‘…Ñ•‘}…Ðè¹½Ü ¤ô¤ô¤ì(€É•ÑÕÉ¸ìÍÑ…•è€Ä°É•…‘äè€Ä°•á•ÁÑ¥½¸è€Àôì)ô()…Íå¹Œ™Õ¹Ñ¥½¸½Õ¹ÑÌ¡½¹Ñ•áÐ¤ì(€½¹ÍÐÉ½ÝÌ€ô…Ý…¥Ð‘ˆ¡ÁÕ‰±¥Í¡•É}‘¥Í½Ù•Éå}…¹‘¥‘…Ñ•Ìý‘¥Í½Ù•Éå}ÉÕ¹}¥õ•Ä¸‘í½¹Ñ•áÐ¹‘¥Í½Ù•ÉåIÕ¹%‘ô™Í•±•Ðõ¥±É•Ù¥•Ý}ÍÑ…ÑÕÌ±…‘µ¥ÑÑ•‘}ÁÕ‰±¥Í¡•É}¥±½™™¥¥…±}Í½ÕÉ•}Ù•É¥™¥•‘€¤¹…Ñ   ¤€ôømt¤ì(€É•ÑÕÉ¸ì(€€€ÍÑ…•èÉ½ÝÌ¹±•¹Ñ °(€€€É•…‘äèÉ½ÝÌ¹™¥±Ñ•È ¡É½Ü¤€ôøÉ½Ü¹…‘µ¥ÑÑ•‘}ÁÕ‰±¥Í¡•É}¥¤¹±•¹Ñ °(€€€•á•ÁÑ¥½¹ÌèÉ½ÝÌ¹™¥±Ñ•È ¡É½Ü¤€ôøÉ½Ü¹É•Ù¥•Ý}ÍÑ…ÑÕÌ€ôôô€aAQ%=9}IY%\œ¤¹±•¹Ñ °(€€€½™™¥¥…°èÉ½ÝÌ¹™¥±Ñ•È ¡É½Ü¤€ôøÉ½Ü¹½™™¥¥…±}Í½ÕÉ•}Ù•É¥™¥•€ôôôÑÉÕ”¤¹±•¹Ñ (€ôì)ô()…Íå¹Œ™Õ¹Ñ¥½¸Í•±™¥ÍÁ…Ñ ¡½¹Ñ•áÐ°¹•áÑ%¹‘•à¤ì(€½¹ÍÐÕÉ°€ô•¹Ø MUA	M}UI0œ¤¹É•Á±…” ½p¼¼°€œœ¤ì(€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð™•Ñ ¡€‘íÕÉ±ô½™Õ¹Ñ¥½¹Ì½ØÄ¼‘íU9Q%=9}95õ€°ì(€€€µ•Ñ¡½è€A=MPœ°(€€€¡•…‘•ÉÌèì€½¹Ñ•¹ÐµQåÁ”œè€…ÁÁ±¥…Ñ¥½¸½©Í½¸œô°(€€€‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡ì(€€€€€½µµ…¹‘}ÉÕ¹}¥è½¹Ñ•áÐ¹½µµ…¹‘IÕ¹%°(€€€€€‘¥Í½Ù•Éå}ÉÕ¹}¥è½¹Ñ•áÐ¹‘¥Í½Ù•ÉåIÕ¹%°(€€€€€ÍÑ…Ñ•}½‘”è½¹Ñ•áÐ¹ÍÑ…Ñ•½‘”°(€€€€€‘¥Í½Ù•Éå}Í½Á”è½¹Ñ•áÐ¹‘¥Í½Ù•ÉåM½Á”°(€€€€€Õ¹¥Ñ}¥¹‘•àè¹•áÑ%¹‘•à(€€€ô¤(€ô¤ì(€¥˜€ …É•ÍÁ½¹Í”¹½¬€˜˜É•ÍÁ½¹Í”¹ÍÑ…ÑÕÌ€„ôô€ÈÀÈ¤Ñ¡É½Ü¹•ÜÉÉ½È¡¡•­Á½¥¹Ð€‘í¹•áÑ%¹‘•à€¬€Åô‘¥ÍÁ…Ñ ™…¥±•€ ‘íÉ•ÍÁ½¹Í”¹ÍÑ…ÑÕÍô¤è€‘í…Ý…¥ÐÉ•ÍÁ½¹Í”¹Ñ•áÐ ¥õ€¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸™¥¹…±¥é”¡½¹Ñ•áÐ¤ì(€½¹ÍÐÍÕµµ…Éä€ô…Ý…¥Ð½Õ¹ÑÌ¡½¹Ñ•áÐ¤ì(€½¹ÍÐ¡¥±‘I½ÝÌ€ô…Ý…¥Ð‘ˆ¡½µµ…¹‘}ÉÕ¹ÌýÁ…É•¹Ñ}ÉÕ¹}¥õ•Ä¸‘í½¹Ñ•áÐ¹½µµ…¹‘IÕ¹%‘ô™µ¥ÍÍ¥½¹}ÑåÁ•}­•äõ•Ä¹AU	1%M!I}%M=YIe}1ML™Í•±•ÐõÍÑ…ÑÕÌ±ÕÉÉ•¹Ñ}ÍÑ…”±Ý…É¹¥¹}½Õ¹Ð±™…¥±ÕÉ•}½Õ¹Ð±•á•ÕÑ¥½¹}•Ù¥‘•¹•€¤¹…Ñ   ¤€ôømt¤ì(€½¹ÍÐ™…¥±•€ô¡¥±‘I½ÝÌ¹™¥±Ñ•È ¡É½Ü¤€ôøÑáÐ¡É½Ü¹ÍÑ…ÑÕÌ¤¹Ñ½1½Ý•É…Í” ¤€ôôô€™…¥±•œ¤¹±•¹Ñ ì(€½¹ÍÐÝ…É¹¥¹œ€ô¡¥±‘I½ÝÌ¹™¥±Ñ•È ¡É½Ü¤€ôø9Õµ‰•È¡É½Ü¹Ý…É¹¥¹}½Õ¹Ðñð€À¤€ø€À¤¹±•¹Ñ ì(€½¹ÍÐ•Ù¥‘•¹”€ôì(€€€ÉÕ¹Ñ¥µ”è€MUA	M}œ°(€€€•¹¥¹”è€!-A=%9Q}9Q%Qe}1MM}=I!MQIQ=Hœ°(€€€Ñ…á½¹½µå}Ù•ÉÍ¥½¸èQa=9=5e}YIM%=8°(€€€…¹‘¥‘…Ñ•Í}ÍÑ…•èÍÕµµ…Éä¹ÍÑ…•°(€€€…ÍÍ¥¹µ•¹ÑÍ}É•…‘äèÍÕµµ…Éä¹É•…‘ä°(€€€•á•ÁÑ¥½¹Í}¥Í½±…Ñ•èÍÕµµ…Éä¹•á•ÁÑ¥½¹Ì°(€€€Õ¹¥Ñ}É•ÍÕ±ÑÌè¡¥±‘I½ÝÌ¹µ…À ¡É½Ü¤€ôøÉ½Ü¹•á•ÕÑ¥½¹}•Ù¥‘•¹”ñðíô¤°(€€€Í•Á…É…Ñ•}…ÅÕ¥Í¥Ñ¥½¹}Ñ…Í¬èÑÉÕ”(€ôì(€…Ý…¥Ð‘ˆ¡ÁÕ‰±¥Í¡•É}‘¥Í½Ù•Éå}ÉÕ¹Ìý¥õ•Ä¸‘í½¹Ñ•áÐ¹‘¥Í½Ù•ÉåIÕ¹%‘õ€°ì(€€€µ•Ñ¡½è€AQ œ°(€€€‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡ì(€€€€€ÍÑ…ÑÕÌè€=5A1Qœ°ÕÉÉ•¹Ñ}ÍÑ…”è€11}9Q%Qe}1MM}QM-M}QI5%90œ°(€€€€€½™™¥¥…±}Í½ÕÉ•Í}¥‘•¹Ñ¥™¥•èÍÕµµ…Éä¹½™™¥¥…°°ÁÕ‰±¥Í¡•ÉÍ}ÁÉ•Í•¹Ñ•èÍÕµµ…Éä¹ÍÑ…•°(€€€€€ÁÕ‰±¥Í¡•ÉÍ}…ÁÁÉ½Ù•èÍÕµµ…Éä¹É•…‘ä°½µÁ±•Ñ•‘}…Ðè¹½Ü ¤°ÕÁ‘…Ñ•‘}…Ðè¹½Ü ¤°•Ù¥‘•¹”(€€€ô¤(€ô¤ì(€…Ý…¥ÐÁ…Ñ¡IÕ¸¡½¹Ñ•áÐ¹½µµ…¹‘IÕ¹%°ì(€€€ÍÑ…ÑÕÌè€½µÁ±•Ñ•œ°……‘Á}ÍÑ…Ñ”è™…¥±•ñðÝ…É¹¥¹œ€ü€AIQ%11e}=5A1Qœ€è€=5A1Qœ°(€€€ÕÉÉ•¹Ñ}ÍÑ…”è€11}9Q%Qe}1MM}QM-M}QI5%90œ°ÁÉ½É•ÍÍ}Ù…±Õ”è€ÄÀÀ°(€€€É•½É‘Í}‘¥Í½Ù•É•èÍÕµµ…Éä¹ÍÑ…•°É•½É‘Í}…ÅÕ¥É•èÍÕµµ…Éä¹ÍÑ…•°(€€€É•½É‘Í}…•ÁÑ•èÍÕµµ…Éä¹É•…‘ä°É•½É‘Í}É•©•Ñ•èÍÕµµ…Éä¹•á•ÁÑ¥½¹Ì°(€€€Ý…É¹¥¹}½Õ¹Ðè™…¥±•€¬Ý…É¹¥¹œ°™…¥±ÕÉ•}½Õ¹Ðè€À°(€€€…Ñ¥½¹}É•ÅÕ¥É•è™…¥±•€ø€ÀñðÝ…É¹¥¹œ€ø€À°½µÁ±•Ñ•‘}…Ðè¹½Ü ¤°(€€€É•ÍÕ±Ñ}ÍÕµµ…Éäè€ÐÄ•¹Ñ¥Ñäµ±…ÍÌ¡•­Á½¥¹ÑÌÉ•…¡•Ñ•Éµ¥¹…°ÍÑ…ÑÕÌè€‘íÍÕµµ…Éä¹É•…‘åôId…ÍÍ¥¹µ•¹ÑÌ…¹€‘íÍÕµµ…Éä¹•á•ÁÑ¥½¹Íô•á•ÁÑ¥½¹Ì¹€°(€€€•á•ÕÑ¥½¹}•Ù¥‘•¹”è•Ù¥‘•¹”(€ô¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸•á•ÕÑ”¡Á…å±½…¤ì(€½¹ÍÐ½µµ…¹‘IÕ¹%€ôÑáÐ¡Á…å±½…¹½µµ…¹‘}ÉÕ¹}¥¤ì(€½¹ÍÐ‘¥Í½Ù•ÉåIÕ¹%€ôÑáÐ¡Á…å±½…¹‘¥Í½Ù•Éå}ÉÕ¹}¥¤ì(€½¹ÍÐÍÑ…Ñ•½‘”€ôÑáÐ¡Á…å±½…¹ÍÑ…Ñ•}½‘”¤¹Ñ½UÁÁ•É…Í” ¤ì(€½¹ÍÐ‘¥Í½Ù•ÉåM½Á”€ôÑáÐ¡Á…å±½…¹‘¥Í½Ù•Éå}Í½Á”¤ì(€½¹ÍÐÕ¹¥Ñ%¹‘•à€ô9Õµ‰•È¡Á…å±½…¹Õ¹¥Ñ}¥¹‘•à¤ì(€¥˜€ …½µµ…¹‘IÕ¹%ñð€…‘¥Í½Ù•ÉåIÕ¹%ñð€„½ymµiu÷³'ÒBòçFW7B‡7FFT6öFR’ÇÂçVÖ&W"æ—4–çFVvW"‡Væ—D–æFW‚’ÇÂVæ—D–æFW‚Â’°¢F‡&÷ræWrW'&÷"‚v6öÖÖæE÷'Våö–BÂF—66÷fW'•÷'Våö–BÂ7FFUö6öFRÂF—66÷fW'•÷66÷RÂæBæöææVvF—fRVæ—Eö–æFW‚&R&WV—&VBâr“°¢Ð¢6öç7B66÷RÒ'6U66÷R†F—66÷fW'•66÷R“°¢–b‡66÷RævVöw&†–566÷RÓÒt4õTåE’rÇÂ66÷Ræ6÷VçG”æÖRÇÂ66÷Ræ6÷VçG”f—2’F‡&÷ræWrW'&÷"‚t6ö×ÆWFR4õTåE’F—66÷fW'’66÷R—2&WV—&VBâr“°¢6öç7B6öçFW‡BÒ²6öÖÖæE'Vä–BÂF—66÷fW'•'Vä–BÂ7FFT6öFRÂF—66÷fW'•66÷RÂ6÷VçG”æÖS¢66÷Ræ6÷VçG”æÖRÂ6÷VçG”f—3¢66÷Ræ6÷VçG”f—2Ó°¢–b†6öÖÖæE'Vä–BÓÒÄÄõtTEô4ôÔÔäEõ%Tåô”BÇÂF—66÷fW'•'Vä–BÓÒÄÄõtTEôD•44õdU%•õ%Tåô”B’F‡&÷ræWrW'&÷"‚uF†—2&W—"v÷&¶W"—2&W7G&–7FVBFòF†RWF†÷&—¦VB6æöæ–6ÂF—66÷fW'’'Vââr“°¢6öç7B&VçBÒv—BvWE&VçB†6öÖÖæE'Vä–B“°¢–b‚&VçB’F‡&÷ræWrW'&÷"‚u&VçB6öÖÖæB'Vâæ÷Bf÷VæBâr“°¢–b…²v6ö×ÆWFVBrÂv6æ6VÆÆVBrÂw7F÷VBuÒæ–æ6ÇVFW2‡G‡B‡&VçBç7FGW2’çFôÆ÷vW$66R‚’’’&WGW&ã°¢–b‡Væ—D–æFW‚ãÒTåD•E•ô4Ä54U2æÆVæwF‚’&WGW&âv—Bf–æÆ—¦R†6öçFW‡B“° ¢6öç7B6Æ–ÒÒv—B6Æ–Ô6†–ÆB†6öçFW‡BÂVæ—D–æFW‚“°¢–b†6Æ–ÒçFW&Ö–æÂ’&WGW&âv—B6VÆdF—7F6‚†6öçFW‡BÂVæ—D–æFW‚²“°¢–b†6Æ–Òæ'W7’’&WGW&ã°¢–b‚6Æ–Òç&÷sòæ–B’F‡&÷ræWrW'&÷"†Væ&ÆRFò6Æ–ÒG¶6Æ–ÒçVæ—D¶W—Òæ“°¢6öç7B&öw&W72ÒÖF‚æÖ‚ƒ"ÂÖF‚ç&÷VæB‚‡Væ—D–æFW‚òTåD•E•ô4Ä54U2æÆVæwF‚’¢“B’“°¢v—BF6…'Vâ†6öÖÖæE'Vä–BÂ°¢7FGW3¢w'Vææ–ærrÂG÷7FFS¢u%Tää”ärrÂ7W'&VçE÷7FvS¢G¶6Æ–ÒçVæ—D¶W—Õõ%Tää”ävÂ&öw&W75÷fÇVS¢&öw&W72À¢&W7VÇE÷7VÖÖ'“¢6†V6·ö–çBG·Væ—D–æFW‚²ÒöbC¢G¶6Æ–ÒæVçF—G”6Æ77Òæ ¢Ò“°¢v—BF"†V&Æ—6†W%öF—66÷fW'•÷'Vç3ö–CÖWâG¶F—66÷fW'•'Vä–GÖÂ°¢ÖWF†öC¢uD4‚rÀ¢&öG“¢¥4ôâç7G&–æv–g’‡²7FGW3¢u%Tää”ärrÂ7W'&VçE÷7FvS¢6Æ–ÒçVæ—D¶W’Â6ö×ÆWFVEöC¢çVÆÂÂWFFVEöC¢æ÷r‚’Ò¢Ò“° ¢G'’°¢6öç7B&W6V&6…&W7VÇBÒv—B&W6V&6‚†6öçFW‡BÂ6Æ–ÒæVçF—G”6Æ72Â6Æ–ÒçVæ—D¶W’“°¢ÆWB7FvVBÒÂ&VG’ÒÂW†6WF–öç2Ò°¢f÷"†6öç7B6æF–FFRöb&W6V&6…&W7VÇBæ6æF–FFW2’°¢6öç7B&W7VÇBÒv—B7FvT6æF–FFR†6öçFW‡BÂ6æF–FFRÂ6Æ–ÒçVæ—D¶W’Â6Æ–ÒæVçF—G”6Æ72“°¢7FvVB³Ò&W7VÇBç7FvVC°¢&VG’³Ò&W7VÇBç&VG“°¢W†6WF–öç2³Ò&W7VÇBæW†6WF–öã°¢Ð¢6öç7BVæ—E7FGW2Ò&W6V&6…&W7VÇBæ6æF–FFW2æÆVæwF‚ÓÓÒòt4ôÕÄUDTEôäõõ$U5TÅE2r¢W†6WF–öç2âòt4ôÕÄUDTEõt•D…õt$ä”äu2r¢t4ôÕÄUDTBs°¢6öç7BWf–FVæ6RÒ°¢7G&FVw”¶W“¢6Æ–ÒçVæ—D¶W’Â6WVVæ6S¢Væ—D–æFW‚²ÂVçF—G”6Æ73¢6Æ–ÒæVçF—G”6Æ72À¢7FGW3¢Væ—E7FGW2Â6æF–FFW4f÷VæC¢&W6V&6…&W7VÇBæ6æF–FFW2æÆVæwF‚À¢6æF–FFW5fW&–f–VC¢7FvVBÒW†6WF–öç2Â76–væÖVçG5&VG“¢&VG’À¢GFV×G3¢&W6V&6…&W7VÇBæGFV×G2Â6†–ÆE'Vä–C¢6Æ–Òç&÷ræ–BÂ'VçF–ÖS¢u5U$4UôTDtRp¢Ó°¢v—BF6…'Vâ†6Æ–Òç&÷ræ–BÂ°¢7FGW3¢v6ö×ÆWFVBrÂG÷7FFS¢W†6WF–öç2òu%D”ÄÅ•ô4ôÕÄUDRr¢t4ôÕÄUDTBrÂ7W'&VçE÷7FvS¢Væ—E7FGW2À¢&öw&W75÷fÇVS¢Â6ö×ÆWFVEöC¢æ÷r‚’Â&V6÷&G5öF—66÷fW&VC¢&W6V&6…&W7VÇBæ6æF–FFW2æÆVæwF‚À¢&V6÷&G5ö7V—&VC¢7FvVBÂ&V6÷&G5ö66WFVC¢&VG’Â&V6÷&G5÷&V¦V7FVC¢W†6WF–öç2À¢v&æ–æuö6÷VçC¢W†6WF–öç2Âf–ÇW&Uö6÷VçC¢Â7F–öå÷&WV—&VC¢W†6WF–öç2âÀ¢&W7VÇE÷7VÖÖ'“¢G¶6Æ–ÒæVçF—G”6Æ77Ó¢G·&W6V&6…&W7VÇBæ6æF–FFW2æÆVæwF‡Ò6æF–FFW2ÂG·&VG—Ò$TE’76–væÖVçG2ÂG¶W†6WF–öç7ÒW†6WF–öç2æÀ¢W†V7WF–öåöWf–FVæ6S¢Wf–FVæ6P¢Ò“°¢6öç7B7VÖÖ'’Òv—B6÷VçG2†6öçFW‡B“°¢v—BF6…'Vâ†6öÖÖæE'Vä–BÂ°¢&V6÷&G5öF—66÷fW&VC¢7VÖÖ'’ç7FvVBÂ&V6÷&G5ö7V—&VC¢7VÖÖ'’ç7FvVBÀ¢&V6÷&G5ö66WFVC¢7VÖÖ'’ç&VG’Â&V6÷&G5÷&V¦V7FVC¢7VÖÖ'’æW†6WF–öç2À¢&öw&W75÷fÇVS¢ÖF‚æÖ‚‡&öw&W72ÂÖF‚ç&÷VæB‚‚‡Væ—D–æFW‚²’òTåD•E•ô4Ä54U2æÆVæwF‚’¢“B’’À¢&W7VÇE÷7VÖÖ'“¢G¶6Æ–ÒæVçF—G”6Æ77Ò6ö×ÆWFRâG·7VÖÖ'’ç&VG—Ò$TE’76–væÖVçG2&W6W'fVC²F—7F6†–ær6†V6·ö–çBG·Væ—D–æFW‚²'ÒöbCæ ¢Ò“°¢v—B6VÆdF—7F6‚†6öçFW‡BÂVæ—D–æFW‚²“°¢Ò6F6‚†W'&÷"’°¢6öç7BÖW76vRÒW'&÷"–ç7Fæ6VöbW'&÷"òW'&÷"æÖW76vR¢7G&–ær†W'&÷"“°¢6öç7BfFÂÒW'&÷#òæfFÂÓÓÒG'VS°¢6öç7BWf–FVæ6RÒ²7G&FVw”¶W“¢6Æ–ÒçVæ—D¶W’Â6WVVæ6S¢Væ—D–æFW‚²ÂVçF—G”6Æ73¢6Æ–ÒæVçF—G”6Æ72Â7FGW3¢fFÂòu$õd”DU%ô$Äô4´TBr¢u$õd”DU%ôd”ÄTBrÂW'&÷#¢ÖW76vRÂ6†–ÆE'Vä–C¢6Æ–Òç&÷ræ–BÂ'VçF–ÖS¢u5U$4UôTDtRrÓ°¢v—BF6…'Vâ†6Æ–Òç&÷ræ–BÂ°¢7FGW3¢vf–ÆVBrÂG÷7FFS¢td”ÄTBrÂ7W'&VçE÷7FvS¢Wf–FVæ6Rç7FGW2À¢&öw&W75÷fÇVS¢Â6ö×ÆWFVEöC¢æ÷r‚’Âf–ÇW&Uö6÷VçC¢Â7F–öå÷&WV—&VC¢G'VRÀ¢&W7VÇE÷7VÖÖ'“¢fFÂòG¶6Æ–ÒæVçF—G”6Æ77Ò7F÷VB&V6W6R&÷f–FW"WF†VçF–6F–öâÂV÷FÂ÷"&–ÆÆ–ær—2Væf–Æ&ÆRæ¢G¶6Æ–ÒæVçF—G”6Æ77Òf–ÆVBgFW"6öçG&öÆÆVB&WG&–W2â6öçF–çV–ærFòF†RæW‡B6†V6·ö–çBæÀ¢W†V7WF–öåöWf–FVæ6S¢Wf–FVæ6P¢Ò“°¢–b†fFÂ’°¢v—BF"†V&Æ—6†W%öF—66÷fW'•÷'Vç3ö–CÖWâG¶F—66÷fW'•'Vä–GÖÂ²ÖWF†öC¢uD4‚rÂ&öG“¢¥4ôâç7G&–æv–g’‡²7FGW3¢uU4TBrÂ7W'&VçE÷7FvS¢u$õd”DU%ô$Äô4´TBrÂWFFVEöC¢æ÷r‚’ÂWf–FVæ6S¢²W'&÷#¢ÖW76vRÂfFÅ÷&÷f–FW#¢G'VRÂ'VçF–ÖS¢u5U$4UôTDtRrÒÒ’Ò“°¢v—BF6…'Vâ†6öÖÖæE'Vä–BÂ²7FGW3¢vf–ÆVBrÂG÷7FFS¢td”ÄTBrÂ7W'&VçE÷7FvS¢u$õd”DU%ô$Äô4´TBrÂ7F–öå÷&WV—&VC¢G'VRÂf–ÇW&Uö6÷VçC¢Â6ö×ÆWFVEöC¢æ÷r‚’Â&W7VÇE÷7VÖÖ'“¢ÖW76vRÒ“°¢&WGW&ã°¢Ð¢v—B6VÆdF—7F6‚†6öçFW‡BÂVæ—D–æFW‚²“°¢Ð§Ð ¤FVæòç6W'fR†7–æ2‡&WVW7B’Óâ°¢–b‡&WVW7BæÖWF†öBÓÓÒtõD”ôå2r’&WGW&âæWr&W7öç6R‚vö²r“°¢–b‡&WVW7BæÖWF†öBÓÒuõ5Br’&WGW&â§6öâ‡²W'&÷#¢tÖWF†öBæ÷BÆÆ÷vVBrÒÂCR“°¢6öç7B–ÆöBÒv—B&WVW7Bæ§6öâ‚’æ6F6‚‚‚’Óâ‡·Ò’“°¢VFvU'VçF–ÖRçv—EVçF–Â†W†V7WFR‡–ÆöB’“°¢&WGW&â§6öâ‡²66WFVC¢G'VRÂ6öÖÖæE÷'Våö–C¢–ÆöBæ6öÖÖæE÷'Våö–BÇÂçVÆÂÂVæ—Eö–æFWƒ¢–ÆöBçVæ—Eö–æFW‚óòçVÆÂÒÂ#"“°§Ò“°