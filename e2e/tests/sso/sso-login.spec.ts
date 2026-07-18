import { expect, test } from '@playwright/test';
import { fetchInfo } from '../../helpers/api';

/**
 * SSO-only mode (derived, no dedicated env var): password registration
 * off + at least one advertised provider ⇒ passwordLoginEnabled=false.
 * The instance runs with REGISTRATION_PASSWORD_ENABLED=false and
 * GOOGLE_OAUTH_ENABLED=true (see docker/compose.yml).
 *
 * The valid-invite 200 path is covered by unit tests (it needs a seeded
 * invite); here we prove the gate itself and the UI rendering, which
 * unit tests cannot see.
 */

const BASE = 'http://127.0.0.1:14993';

test('/info derives passwordLoginEnabled=false with a provider advertised', async () => {
  const info = await fetchInfo(BASE);
  expect(info.passwordLoginEnabled).toBe(false);
  expect(info.passwordRegistrationEnabled).toBe(false);
  expect(info.enabledAuthProviders).toEqual([
    { name: 'google', label: 'Google' }
  ]);
});

test('login screen shows ONLY the provider button — no password form, no tabs', async ({
  page
}) => {
  await page.goto('/');

  await expect(page.getByText('Sign in to continue')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Google' })).toBeVisible();

  // Zero form fields of any kind
  await expect(page.locator('input')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByText('Remember me')).toHaveCount(0);
});

test('invite link is the break-glass: password form reappears', async ({
  page
}) => {
  await page.goto('/?invite=E2E-BREAKGLASS');

  await expect(page.getByPlaceholder('you@example.com')).toBeVisible();
  await expect(page.getByPlaceholder('Enter your password')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Sign In' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Create Account' })).toBeVisible();
  // Provider button still offered alongside
  await expect(page.getByRole('button', { name: 'Google' })).toBeVisible();
});

test('/login rejects password attempts server-side (not just hidden UI)', async ({
  request
}) => {
  const noInvite = await request.post(`${BASE}/login`, {
    data: { email: 'anyone@e2e.local', password: 'whatever-1234' }
  });
  expect(noInvite.status()).toBe(400);
  const body = (await noInvite.json()) as { errors: Record<string, string> };
  expect(body.errors.email).toContain('disabled');

  // Bogus invite does NOT bypass the gate — but it IS consulted (the
  // error switches from "disabled" to invite validation)
  const badInvite = await request.post(`${BASE}/login`, {
    data: {
      email: 'anyone@e2e.local',
      password: 'whatever-1234',
      invite: 'NO-SUCH-INVITE'
    }
  });
  expect(badInvite.status()).toBe(400);
  const badBody = (await badInvite.json()) as {
    errors: Record<string, string>;
  };
  expect(badBody.errors.email).toContain('Invite');
});

test('/register is gated the same way', async ({ request }) => {
  const res = await request.post(`${BASE}/register`, {
    data: {
      email: 'blocked@e2e.local',
      password: 'whatever-1234',
      displayName: 'Blocked'
    }
  });
  expect(res.status()).toBe(400);
});
