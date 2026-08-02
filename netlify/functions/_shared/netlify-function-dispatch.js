const txt = value => String(value ?? '').trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeOrigin(value) {
  const raw = txt(value);
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.origin;
  } catch {
    return null;
  }
}

export function netlifyOrigins({ event, env }) {
  const host = txt(event?.headers?.host || event?.headers?.Host);
  const forwardedHost = txt(event?.headers?.['x-forwarded-host'] || event?.headers?.['X-Forwarded-Host']);
  const candidates = [
    env?.('URL'),
    env?.('DEPLOY_PRIME_URL'),
    env?.('DEPLOY_URL'),
    forwardedHost,
    host
  ].map(normalizeOrigin).filter(Boolean);
  return [...new Set(candidates)];
}

export async function dispatchNetlifyFunction({ event, env, functionName, payload, dashboardPassword, attemptsPerOrigin = 2, timeoutMs = 15000 }) {
  const origins = netlifyOrigins({ event, env });
  if (!origins.length) throw new Error('No Netlify origin is available for internal function dispatch.');

  const diagnostics = [];
  for (const origin of origins) {
    const endpoint = `${origin}/.netlify/functions/${functionName}`;
    for (let attempt = 1; attempt <= attemptsPerOrigin; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
        if (dashboardPassword) headers['x-dashboard-password'] = dashboardPassword;
        const result = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        const responseText = await result.text().catch(() => '');
        diagnostics.push({ origin, endpoint, attempt, status: result.status, ok: result.ok, response_text: responseText.slice(0, 500) });
        if (result.ok || result.status === 202) {
          return { status: result.status, origin, endpoint, attempt, diagnostics };
        }
      } catch (error) {
        diagnostics.push({
          origin,
          endpoint,
          attempt,
          status: null,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          error_name: error?.name || null
        });
      } finally {
        clearTimeout(timeout);
      }
      if (attempt < attemptsPerOrigin) await sleep(750 * attempt);
    }
  }

  const detail = diagnostics.map(item => `${item.origin} attempt ${item.attempt}: ${item.status || item.error || 'failed'}`).join(' | ');
  const error = new Error(`Internal function dispatch failed for ${functionName}. ${detail}`);
  error.dispatchDiagnostics = diagnostics;
  throw error;
}
