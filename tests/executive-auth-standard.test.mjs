import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.EXECUTIVE_AUTH_HASH = '9'.repeat(64);
process.env.EXECUTIVE_OPERATOR_EMAIL = 'jmitchell@aproposgroupllc.com';

const runtime = await import('../netlify/functions/_shared/native-runtime.js');

const operator = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'jmitchell@aproposgroupllc.com'
};

test('Executive operator session is signed, restricted, and accepted by shared guards', () => {
  const token = runtime.issueDashboardToken(operator, 900);
  const verified = runtime.verifyDashboardToken(token);

  assert.equal(verified.email, operator.email);
  assert.equal(verified.sub, operator.id);
  assert.ok(verified.exp > verified.iat);

  const event = { headers: { authorization: `Bearer ${token}` } };
  assert.equal(runtime.requireDashboardAuth(event), true);

  const pieces = token.split('.');
  const tampered = `${pieces[0]}.${pieces[1]}x.${pieces[2]}`;
  assert.equal(runtime.verifyDashboardToken(tampered), null);
  assert.equal(runtime.requireDashboardAuth({ headers: { authorization: `Bearer ${tampered}` } }), false);
});

test('Executive session cannot be issued to another email address', () => {
  assert.throws(
    () => runtime.issueDashboardToken({ id: operator.id, email: 'other@example.com' }),
    /not authorized/i
  );
});

test('Executive login client exposes email, password, recovery, reset, persistence, and sign out', async () => {
  const source = await readFile(new URL('../assets/executive-core.js', import.meta.url), 'utf8');

  for (const required of [
    'gateEmail',
    'gatePassword',
    'Forgot password?',
    'gateForgotForm',
    'gateResetForm',
    'gateNewPassword',
    'gateConfirmPassword',
    'apieExecutiveSession',
    'Authorization:`Bearer ${dashboardSessionToken}`',
    'eccSignOut',
    "location.pathname==='/reset-password'"
  ]) {
    assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Executive authentication endpoint delegates credential and recovery operations to Supabase Auth', async () => {
  const source = await readFile(new URL('../netlify/functions/executive-auth.js', import.meta.url), 'utf8');

  assert.match(source, /token\?grant_type=password/);
  assert.match(source, /reset/);
  assert.match(source, /recover\?redirect_to=/);
  assert.match(source, /update-password/);
  assert.match(source, /auth\/v1\/\$\{path\}/);
  assert.match(source, /EXECUTIVE_OPERATOR_EMAIL/);
  assert.match(source, /EXECUTIVE_RECOVERY_REDIRECT/);
});

test('Executive authentication styling preserves the approved command-center standard', async () => {
  const source = await readFile(new URL('../assets/executive-auth.css', import.meta.url), 'utf8');

  assert.match(source, /ecc-auth-shell/);
  assert.match(source, /var\(--gold\)/);
  assert.match(source, /var\(--navy\)/);
  assert.match(source, /ecc-sign-out/);
});
