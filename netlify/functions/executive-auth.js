import {
  env,
  header,
  issueDashboardToken,
  parseBody,
  response,
  verifyDashboardToken
} from './_shared/native-runtime.js';

const allowedEmail = () =>
  String(env('EXECUTIVE_OPERATOR_EMAIL') || 'jmitchell@aproposgroupllc.com').trim().toLowerCase();

function sameOrigin(event) {
  const origin = String(header(event, 'origin') || '').trim();
  if (!origin) return true;
  try {
    return new URL(origin).host === header(event, 'host');
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
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(30000)
  });

  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function bearer(event) {
  return String(header(event, 'authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
}

export const handler = async event => {
  if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event?.httpMethod !== 'POST') return response(405, { ok: false, error: 'POST only.' });
  if (!sameOrigin(event)) return response(403, { ok: false, error: 'Same-origin request required.' });

  const body = parseBody(event);
  const action = String(body.action || 'session').trim().toLowerCase();

  try {
    if (action === 'session') {
      const session = verifyDashboardToken(bearer(event));
      return session
        ? response(200, { ok: true, authenticated: true, email: session.email, expires_at: session.exp })
        : response(401, { ok: false, error: 'Executive operator session required.' });
    }

    if (action === 'login') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');

      if (email !== allowedEmail()) return response(401, { ok: false, error: 'Operator access denied.' });
      if (!password) return response(400, { ok: false, error: 'Password is required.' });

      const { res, data } = await authRequest('token?grant_type=password', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });

      if (!res.ok || data.user?.email?.toLowerCase() !== allowedEmail()) {
        return response(401, { ok: false, error: 'Invalid operator email or password.' });
      }

      const dashboardToken = issueDashboardToken(data.user);
      return response(200, {
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
          return response(502, {
            ok: false,
            error: data?.msg || data?.message || 'Supabase rejected the recovery request.'
          });
        }
      }

      return response(200, {
        ok: true,
        message: 'If the authorized operator account exists, a recovery email has been sent.'
      });
    }

    if (action === 'update-password') {
      const recoveryToken = bearer(event);
      const password = String(body.password || '');

      if (!recoveryToken) return response(401, { ok: false, error: 'Valid recovery session required.' });
      if (password.length < 12) return response(400, { ok: false, error: 'Use at least 12 characters.' });

      const { res, data } = await authRequest('user', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${recoveryToken}` },
        body: JSON.stringify({ password })
      });

      if (!res.ok) {
        return response(res.status, { ok: false, error: data?.message || 'Password update failed.' });
      }

      return response(200, { ok: true, message: 'Password updated. Sign in with the new password.' });
    }

    return response(400, { ok: false, error: 'Unknown authentication action.' });
  } catch (error) {
    console.error('[executive-auth]', error);
    const configurationError = /configuration incomplete/i.test(String(error?.message || ''));
    return response(configurationError ? 503 : 500, {
      ok: false,
      error: configurationError ? error.message : 'Authentication service failed.'
    });
  }
};
