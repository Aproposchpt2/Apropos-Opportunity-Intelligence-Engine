export const handler = async event => {
  const bid = String(event?.queryStringParameters?.bid || 'RRCC-RFSQ-19-003').slice(0, 120);
  const url = new URL('https://camisvr.co.la.ca.us/LACoBids/BidLookUp/BidDetail');
  url.searchParams.set('BidNumber', bid);
  const response = await fetch(url, { headers: { 'User-Agent': 'APROPOS-APIE-Source-Introspection/1.0', Accept: 'text/html' }, redirect: 'follow' });
  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi)].map(m => new URL(m[1], response.url || url).toString());
  const inline = [...html.matchAll(/<script\b(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1].trim()).filter(Boolean).map(x => x.slice(0, 12000));
  return { statusCode: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ url: response.url || url.toString(), scripts, inline, html_excerpt: html.slice(0, 20000) }) };
};
