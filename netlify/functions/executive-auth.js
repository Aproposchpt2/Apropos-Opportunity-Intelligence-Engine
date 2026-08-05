import {
  env,
  issueDashboardToken,
  verifyDashboardToken
} from './_shared/native-runtime.js';

const allowedEmail = () =>
  String(env('EXECUTIVE_OPERATOR_EMAIL') || 'jmitchell@aproposgroupllc.com').trim().toLowerCase();

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function sameOrigin(req) {
  const origin = String(req.headers.get('origin') || '').trim();
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

function authConfig() {
  const base = String(env('SUPABASE_URL') || '').trim().replace(/\/$/, '');
  const key = String(env('SUPABASE_ANON_KEY') || '').trim();
  if (!base || !key) throw new Error('Supabase authentication configuration incomplete');
  return { base, key };
}

async function authRequest(path, options = {}) {
  const { base, key } = authConfig();
  const res = await fetch(`${base}/auth/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(30000)
  });

  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function bearer(req) {
  return String(req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
}

export default async req => {
  if (req.method === 'OPTIONS') return json(200, { ok: true });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only.' });
  if (!sameOrigin(req)) return json(403, { ok: false, error: 'Same-origin request required.' });

  let body;
  try { body = await req.json(); }
  catch { return json(400, { ok: false, error: 'Invalid JSON.' }); }

  const action = String(body.action || 'session').trim().toLowerCase();

  try {
    if (action === 'session') {
      const session = verifyDashboardToken(bearer(req));
      return session
        ? json(200, { ok: true, authenticated: true, email: session.email, expires_at: session.exp })
        : json(401, { ok: false, error: 'Executive operator session required.' });
    }

    if (action === 'login') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');

      if (email !== allowedEmail()) return json(401, { ok: false, error: 'Operator access denied.' });
      if (!password) return json(400, { ok: false, error: 'Password is required.' });

      const { res, data } = await authRequest('token?grant_type=password', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });

      if (!res.ok || data.user?.email?.toLowerCase() !== allowedEmail()) {
        return json(401, { ok: false, error: 'Invalid operator email or password.' });
      }

      const dashboardToken = issueDashboardToken(data.user);
      return json(200, {
        ok: true,
        authenticated: true,
        dashboard_token: dashboardToken,
        email: data.user.email,
        expires_in: 8 * 60 * 60
      });
    }

    if (action === 'reset') {
      const email = String(body.email || '').trim().toLowerCase();

      if (email === allowedEmail()) {
        const redirectTo = String(
          env('EXECUTIVE_RECOVERY_REDIRECT') || 'https://apie.aproposgroupllc.com/reset-password'
        ).trim();

        const { res, data } = await authRequest(
          `recover?redirect_to=${encodeURIComponent(redirectTo)}`,
          {
            method: 'POST',
            body: JSON.stringify({ email })
          }
        );

        if (!res.ok) {
          console.error('[executive-auth] recovery rejected', res.status, data?.error_code || data?.code || 'unknown');
          return json(502, {
            ok: false,
            error: data?.msg || data?.message || 'Supabase rejected the recovery request.'
          });
        }
      }

      return json(200, {
        ok: true,
        message: 'If the authorized operator account exists, a recovery email has been sent.'
      });
    }

    if (action === 'update-password') {
      const recoveryToken = bearer(req);
      const password = String(body.password || '');

      if (!recoveryToken) return json(401, { ok: false, error: 'Valid recovery session required.' });
      if (password.length < 12) return json(400, { ok: false, error: 'Use at least 12 characters.' });

      const { res, data } = await authRequest('user', {
        method: 'PUT',
        headers: { authorization: `Bearer ${recoveryToken}` },
        body: JSON.stringify({ password })
      });

      if (!res.ok) {
        return json(res.status, { ok: false, error: data?.message || 'Password update failed.' });
      }

      return json(200, { ok: true, message: 'Password updated. Sign in with the new password.' });
    }

    return json(400, { ok: false, error: 'Unknown authentication action.' });
  } catch (error) {
    console.error('[executive-auth]', error);
    const configurationError = /configuration incomplete/i.test(String(error?.message || ''));
    return json(configurationError ? 503 : 500, {
      ok: false,
      error: configurationError ? error.message : 'Authentication service failed.'
    });
  }
};
