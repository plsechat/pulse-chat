import { expect, test } from '@playwright/test';
import { registerUser, storageStateFor } from '../../helpers/api';
import { psql } from '../../helpers/db';
import { runUser } from '../../helpers/fixtures';
import { channelButton, disableAnimations } from '../../helpers/ui';

/**
 * Server preview: a freshly registered non-member goes Discover →
 * Preview → read-only server view (banner, channels, history, no
 * composer, no member roster) → Join from the banner → full member view
 * with a membership row.
 */

const BASE = 'http://127.0.0.1:14991';

test('a non-member previews read-only and then joins from the banner', async ({
  browser
}) => {
  test.setTimeout(180_000);

  // Discover lists discoverable servers only. Idempotent on reruns.
  psql('core', `UPDATE servers SET discoverable = true WHERE id = 1`);

  const fresh = runUser('preview');
  const tokens = await registerUser(BASE, fresh);

  // storageState rather than authedPage: a non-member never reaches the
  // channel list that waitForAppReady anchors on.
  const context = await browser.newContext({
    storageState: storageStateFor(BASE, tokens),
    baseURL: BASE
  });
  const page = await context.newPage();
  try {
    await disableAnimations(page);
    await page.goto(BASE);

    // A fresh user with zero servers lands on Discover.
    await expect(page.getByText('Pulse Server').first()).toBeVisible({
      timeout: 20_000
    });
    await page
      .getByRole('button', { name: 'Preview', exact: true })
      .first()
      .click();

    // Read-only preview view.
    await expect(page.getByText(/You(')?re previewing/i)).toBeVisible({
      timeout: 20_000
    });
    await expect(channelButton(page, 'General Text')).toBeVisible({
      timeout: 15_000
    });
    // History renders (the suite leaves plenty of messages behind).
    await expect(page.locator('.msg-content').first()).toBeVisible({
      timeout: 15_000
    });
    // No composer — join prompt instead; no member roster.
    await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(page.getByText(/Join .* to send messages/i)).toBeVisible();
    await expect(page.locator('aside').filter({ hasText: 'E2EOwner' })).toHaveCount(0);

    // No membership yet.
    const userId = psql(
      'core',
      `SELECT id FROM users WHERE name = '${fresh.displayName}'`
    );
    expect(userId).not.toBe('');
    expect(
      psql(
        'core',
        `SELECT count(*) FROM server_members WHERE user_id = ${userId}`
      )
    ).toBe('0');

    // Join from the banner.
    await page.getByRole('button', { name: /Join Server/i }).first().click();

    // Member view: composer appears, banner gone, roster present.
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({
      timeout: 20_000
    });
    await expect(page.getByText(/You(')?re previewing/i)).toHaveCount(0);
    await expect(
      page.locator('aside').filter({ hasText: fresh.displayName }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Server-side: exactly one membership row now.
    await expect
      .poll(() =>
        psql(
          'core',
          `SELECT count(*) FROM server_members WHERE user_id = ${userId}`
        )
      )
      .toBe('1');
  } finally {
    await context.close();
  }
});
