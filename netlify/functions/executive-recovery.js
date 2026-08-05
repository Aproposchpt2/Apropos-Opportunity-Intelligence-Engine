import { env } from './_shared/native-runtime.js';

const allowedEmail = () =>
  String(env('EXECUTIVE_OPERATOR_EMAIL') || 'jmitchell@aproposgroupllc.com').trim().toLowerCase();

function authConfig() {
  const base = String(env('SUPABASE_URL') || '').trim().replace(/\/$/, '');
  const key = String(env('SUPABASE_ANON_KEY') || '').trim();
  if (!base || !key) throw new Error('Supabase authentication configuration incomplete');
  return { base, key };
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

function page(message = '') {
  const safeMessage = String(message || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>Executive Password Recovery · APROPOS GROUP LLC</title>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#172335;color:#172335;font-family:Arial,sans-serif}.card{width:min(620px,100%);background:#fff;border:1px solid #435167;box-shadow:0 28px 90px rgba(0,0,0,.35);padding:42px}.mark{display:inline-grid;place-items:center;width:48px;height:48px;background:#d6b273;font:26px Georgia,serif}.kicker{margin:20px 0 8px;color:#916b2d;font-size:11px;font-weight:800;letter-spacing:2px}.title{margin:0;font:500 clamp(32px,6vw,48px)/1.08 Georgia,serif}.copy{margin:18px 0;color:#586576;line-height:1.65}.notice{margin:20px 0;padding:12px 14px;border-left:3px solid #b63d3d;background:#fff2f2;color:#9a2f2f;font-size:14px}.button{width:100%;min-height:52px;border:0;background:#d6b273;color:#172335;cursor:pointer;font-size:12px;font-weight:800;letter-spacing:1.2px}.button:disabled{cursor:not-allowed;opacity:.48}.security{margin-top:22px;padding-top:18px;border-top:1px solid #dce1e7;color:#7c8795;font-size:11px;font-weight:800;letter-spacing:1px}.security:before{content:"";display:inline-block;width:7px;height:7px;margin-right:8px;border-radius:50%;background:#2f7b4a}@media(max-width:560px){.card{padding:30px 24px}}
  </style>
</head>
<body>
  <main class="card">
    <div class="mark">A</div>
    <p class="kicker">APROPOS GROUP LLC</p>
    <h1 class="title">Executive Password Recovery</h1>
    <p class="copy">Continue to the secure password form for the authorized Executive Command Center operator. The one-time recovery credential will be verified only after you select the control below.</p>
    ${safeMessage ? `<p class="notice" role="alert">${safeMessage}</p>` : ''}
    <form method="post" action="/executive-recovery" autocomplete="off">
      <input id="tokenHash" name="token_hash" type="hidden" value="">
      <button id="continueButton" class="button" type="submit" disabled>CONTINUE PASSWORD RESET</button>
    </form>
    <div class="security">Authorized operator access only</div>
  </main>
  <script>
    (() => {
      const values = new URLSearchParams(location.hash.replace(/^#/, ''));
      const token = values.get('token_hash') || '';
      const field = document.getElementById('tokenHash');
      const button = document.getElementById('continueButton');
      field.value = token;
      button.disabled = !token;
      history.replaceState({}, '', location.pathname);
    })();
  </script>
</body>
</html>`;
}

function html(status, message = '') {
  return new Response(page(message), {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    }
  });
}

async function verifyRecovery(tokenHash) {
  const { base, key } = authConfig();
  const res = await fetch(`${base}/auth/v1/verify`, {
    method: 'POST',
    headers: {
      apikey: key,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ token_hash: tokenHash, type: 'recovery' }),
    signal: AbortSignal.timeout(30000)
  });

  const data = await res.json().catch(() => ({}));
  return { res, data };
}

export default async req => {
  if (req.method === 'GET') return html(200);
  if (req.method !== 'POST') return html(405, 'This recovery operation accepts only the secure continuation form.');
  if (!sameOrigin(req)) return html(403, 'The recovery request did not originate from the Executive Command Center.');

  try {
    const form = await req.formData();
    const tokenHash = String(form.get('token_hash') || '').trim();
    if (!tokenHash) return html(400, 'The recovery link is incomplete. Request a new password-reset email.');

    const { res, data } = await verifyRecovery(tokenHash);
    const user = data?.user || data?.session?.user;
    const accessToken = String(data?.access_token || data?.session?.access_token || '').trim();

    if (!res.ok || !accessToken || user?.email?.toLowerCase() !== allowedEmail()) {
      return html(401, 'This recovery link is invalid, expired, or has already been used. Request a new password-reset email.');
    }

    const destination = new URL('/reset-password', req.url);
    destination.hash = new URLSearchParams({ type: 'recovery', access_token: accessToken }).toString();

    return new Response(null, {
      status: 303,
      headers: {
        location: destination.toString(),
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer'
      }
    });
  } catch (error) {
    console.error('[executive-recovery]', error);
    return html(500, 'The recovery service could not complete this request. Request a new password-reset email and try again.');
  }
};

export const config = {
  path: '/executive-recovery'
};
