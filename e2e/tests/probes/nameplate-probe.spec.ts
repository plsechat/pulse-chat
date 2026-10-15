import { expect, test } from '@playwright/test';
import { authedPage, CORE_OWNER } from '../../helpers/fixtures';
import { openUserSettings } from '../../helpers/ui';

/**
 * PROBE UTILITY — not a test. Verifies nameplate equip end to end: preset
 * picker in profile settings, live member-row background, admin tab
 * presence. Runs only when NAMEPLATE_PROBE is set so it can never fire
 * in CI.
 */

test.skip(!process.env.NAMEPLATE_PROBE, 'probe utility, set NAMEPLATE_PROBE=1');

test('preset nameplate equips and renders on the member row', async ({
  browser
}) => {
  test.setTimeout(120_000);
  const { page } = await authedPage(
    browser,
    'http://127.0.0.1:14991',
    CORE_OWNER
  );

  // Equip the aurora preset from profile settings
  await openUserSettings(page, 'Profiles');
  await expect(page.getByText('Nameplate', { exact: true }).first()).toBeVisible();
  const auroraTile = page.locator('button[title="Aurora"]').first();
  await auroraTile.scrollIntoViewIfNeeded();
  await auroraTile.click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/tmp/nameplate-picker.png' });
  await page.keyboard.press('Escape');

  // Member list row for the owner shows the background layer (live, no reload)
  const ownRow = page
    .locator('div.group')
    .filter({ has: page.getByText('E2EOwner', { exact: true }) })
    .first();
  await expect(ownRow).toBeVisible({ timeout: 10_000 });
  await expect(ownRow.locator('div[aria-hidden="true"].absolute')).toHaveCount(1, {
    timeout: 10_000
  });
  await page.screenshot({ path: '/tmp/nameplate-row.png' });

  // Admin tab exists in server settings (owner has MANAGE_EMOJIS)
  await page
    .locator('aside')
    .getByRole('button')
    .filter({ hasText: 'Pulse Server' })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await expect(page.getByRole('button', { name: 'Nameplates', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Nameplates', exact: true }).click();
  await page.screenshot({ path: '/tmp/nameplate-admin.png' });
});
