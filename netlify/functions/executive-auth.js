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

function adminAuthConfig() {
  const base = String(env('SUPABASE_URL') || '').trim().replace(/\/$/, '');
  const key = String(env('SUPABASE_SERVICE_KEY') || env('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
  if (!base || !key) throw new Error('Supabase administrative authentication configuration incomplete');
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

async function adminAuthRequest(path, options = {}) {
  const { base, key } = adminAuthConfig();
  const res = await fetch(`${base}/auth/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(30000)
  });

  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function recoveryBridgeUrl(tokenHash) {
  const configured = String(
    env('EXECUTIVE_RECOVERY_REDIRECT') || 'https://apie.aproposgroupllc.com/reset-password'
  ).trim();
  const target = new URL(configured);

  if (target.protocol !== 'https:' || target.hostname !== 'apie.aproposgroupllc.com') {
    throw new Error('Executive recovery destination configuration invalid');
  }

  target.pathname = '/executive-recovery';
  target.search = '';
  target.hash = new URLSearchParams({ token_hash: tokenHash }).toString();
  return target.toString();
}

async function sendRecoveryEmail(email, link) {
  const key = String(env('RESEND_API_KEY') || '').trim();
  if (!key) throw new Error('Executive recovery email configuration incomplete');

  const from = String(
    env('EXECUTIVE_RECOVERY_FROM_EMAIL') ||
    env('RESEND_FROM_EMAIL') ||
    'APROPOS GROUP LLC <no-reply@aproposgroupllc.com>'
  ).trim();

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'Reset Your Executive Command Center Password',
      text: [
        'APROPOS GROUP LLC',
        '',
        'A password reset was requested for your Executive Command Center operator account.',
        'Open the secure link below, then select Continue Password Reset:',
        '',
        link,
        '',
        'This is a one-time recovery link. If you did not request it, no action is required.'
      ].join('\n'),
      html: `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#eef1f4;font-family:Arial,sans-serif;color:#172335">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef1f4;padding:32px 14px">
      <tr><td align="center">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #d7dde5">
          <tr><td style="padding:34px 38px 12px">
            <div style="display:inline-block;background:#d6b273;color:#172335;font-family:Georgia,serif;font-size:25px;padding:11px 16px">A</div>
            <p style="margin:20px 0 8px;color:#916b2d;font-size:11px;font-weight:700;letter-spacing:2px">APROPOS GROUP LLC</p>
            <h1 style="margin:0;color:#172335;font-family:Georgia,serif;font-size:34px;font-weight:500;line-height:1.12">Reset Your Executive Command Center Password</h1>
          </td></tr>
          <tr><td style="padding:12px 38px 36px">
            <p style="font-size:15px;line-height:1.65;color:#4e5b6b">A password reset was requested for the authorized APROPOS operator account.</p>
            <p style="font-size:15px;line-height:1.65;color:#4e5b6b">Use the secure control below. The one-time Supabase token is not consumed until you explicitly continue from the APROPOS recovery page.</p>
            <p style="margin:28px 0">
              <a href="${link}" style="display:inline-block;background:#d6b273;color:#172335;text-decoration:none;font-size:12px;font-weight:800;letter-spacing:1.2px;padding:16px 22px">CONTINUE PASSWORD RESET</a>
            </p>
            <p style="font-size:12px;line-height:1.6;color:#7a8592">If you did not request this reset, no action is required. This link is intended only for the authorized Executive Command Center operator.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`
    }),
    signal: AbortSignal.timeout(30000)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(
      '[executive-auth] recovery email rejected',
      res.status,
      data?.name || 'unknown',
      data?.message || 'no-message'
    );
    throw new Error('Executive recovery email delivery failed');
  }
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
        const { res, data } = await adminAuthRequest('admin/generate_link', {
          method: 'POST',
          body: JSON.stringify({ type: 'recovery', email })
        });

        const tokenHash = String(data?.hashed_token || data?.properties?.hashed_token || '').trim();
        if (!res.ok || !tokenHash) {
          console.error('[executive-auth] recovery link rejected', res.status, data?.error_code || data?.code || 'unknown');
          return json(502, { ok: false, error: 'Supabase rejected the recovery request.' });
        }

        await sendRecoveryEmail(email, recoveryBridgeUrl(tokenHash));
      }

      return json(200, {
        ok: true,
        message: 'If the authorized operator account exists, an APROPOS recovery email has been sent.'
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
    const message = String(error?.message || '');
    const configurationError = /configuration incomplete|destination configuration invalid/i.test(message);
    const deliveryError = message === 'Executive recovery email delivery failed';
    const status = configurationError ? 503 : deliveryError ? 502 : 500;

    return json(status, {
      ok: false,
      error: configurationError || deliveryError ? message : 'Authentication service failed.'
    });
  }
};
