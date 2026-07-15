import { expect, test } from '@playwright/test';
import { fetchInfo, loginUser, storageStateFor } from '../../helpers/api';
import { authedGoto, waitForAppReady, waitForAuthedShell } from '../../helpers/ui';

/**
 * Auth surface on a password-enabled instance: registration, login,
 * logout, error paths, and the /info flags the client keys on.
 */

const BASE = 'http://127.0.0.1:14991';

test('/info advertises password auth enabled', async () => {
  const info = await fetchInfo(BASE);
  expect(info.passwordLoginEnabled).toBe(true);
  expect(info.passwordRegistrationEnabled).toBe(true);
});

test('register a new account through the UI and land in the app', async ({
  page
}) => {
  // Unique per run: registration is permanent on the instance and
  // display names are unique — reruns against a live env must not clash.
  const stamp = Date.now();

  await page.goto('/');
  await page.getByRole('tab', { name: 'Create Account' }).click();
  await page
    .getByPlaceholder('How others will see you')
    .fill(`UiReg${stamp}`);
  await page.getByPlaceholder('you@example.com').fill(`uireg-${stamp}@e2e.local`);
  await page.getByPlaceholder('At least 4 characters').fill('e2e-password-1234');
  await page.getByRole('button', { name: 'Create Account' }).click();

  // A freshly registered non-operator lands in the authenticated shell
  // (Discover view) — not auto-joined to any server.
  await waitForAuthedShell(page);
});

test('login with wrong password shows an error, correct password succeeds', async ({
  page
}) => {
  await page.goto('/');

  await page.getByPlaceholder('you@example.com').fill('owner@e2e.local');
  await page.getByPlaceholder('Enter your password').fill('WRONG-password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByText('Invalid email or password')).toBeVisible();

  await page.getByPlaceholder('Enter your password').fill('e2e-password-1234');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await waitForAppReady(page);
});

test('fresh API session boots straight into the app (no login form)', async ({
  browser
}) => {
  const tokens = await loginUser(BASE, 'owner@e2e.local', 'e2e-password-1234');
  const context = await browser.newContext({
    storageState: storageStateFor(BASE, tokens),
    baseURL: BASE
  });
  const page = await context.newPage();
  await page.goto('/');
  await waitForAppReady(page);
  await expect(page.getByPlaceholder('you@example.com')).toHaveCount(0);
  await context.close();
});

test('authedGoto helper authenticates per-test (rotation-proof)', async ({
  page
}) => {
  await authedGoto(page, BASE, 'owner@e2e.local', 'e2e-password-1234');
  await expect(page.getByPlaceholder('you@example.com')).toHaveCount(0);
});
