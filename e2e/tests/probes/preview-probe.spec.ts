import { expect, test } from '@playwright/test';
import { execSync } from 'child_process';
import { loginUser, registerUser, storageStateFor } from '../../helpers/api';

/**
 * PROBE UTILITY — not a test. Smokes the server-preview flow end to end
 * with a freshly registered non-member: Discover -> Preview -> read-only
 * server view (banner, channels, messages, no members, no composer) ->
 * Join from the banner -> full member view. Runs only when PREVIEW_PROBE
 * is set so it can never fire in CI.
 */

test.skip(!process.env.PREVIEW_PROBE, 'probe utility, set PREVIEW_PROBE=1');

const BASE = 'http://127.0.0.1:14991';

function psql(sql: string): string {
  return execSync(
    `docker exec pulse-e2e-db-core psql -U postgres -qtAX -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' }
  ).trim();
}

test('non-member previews and then joins via the banner', async ({
  browser
}) => {
  test.setTimeout(180_000);

  psql(`UPDATE servers SET discoverable = true WHERE id = 1`);

  const stamp = Date.now().toString(36);
  const fresh = {
    email: `preview-${stamp}@e2e.local`,
    password: 'e2e-password-1234',
    displayName: `previewer-${stamp}`
  };
  await registerUser(BASE, fresh);
  const tokens = await loginUser(BASE, fresh.email, fresh.password);

  const context = await browser.newContext({
    storageState: storageStateFor(BASE, tokens),
    baseURL: BASE
  });
  const page = await context.newPage();
  await page.goto(BASE);

  // Fresh user with zero servers lands on Discover
  await expect(page.getByText('Pulse Server').first()).toBeVisible({
    timeout: 20_000
  });
  await page.getByRole('button', { name: 'Preview', exact: true }).first().click();

  // Read-only preview view
  await expect(page.getByText(/You(')?re previewing/i)).toBeVisible({
    timeout: 20_000
  });
  await expect(
    page.getByRole('button').filter({
      has: page.getByText('General Text', { exact: true })
    })
  ).toHaveCount(1, { timeout: 15_000 });
  // Seeded history renders (any message content from the suite)
  await expect(
    page.locator('.msg-content').first()
  ).toBeVisible({ timeout: 15_000 });
  // No composer — join prompt instead
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(page.getByText(/Join .* to send messages/i)).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/preview-probe-preview.png' });

  // Join from the banner
  await page
    .getByRole('button', { name: /Join Server/i })
    .first()
    .click();

  // Member view: composer appears, banner gone
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({
    timeout: 20_000
  });
  await expect(page.getByText(/You(')?re previewing/i)).toHaveCount(0);
  await page.screenshot({ path: '/tmp/preview-probe-joined.png' });

  // Server-side: membership row exists now
  const userId = psql(
    `SELECT id FROM users WHERE name = '${fresh.displayName}'`
  );
  expect(
    psql(`SELECT count(*) FROM server_members WHERE user_id = ${userId}`)
  ).toBe('1');

  await context.close();
});
