import { expect, test } from '@playwright/test';
import { authedPage, CORE_OWNER } from '../../helpers/fixtures';
import { openUserSettings } from '../../helpers/ui';

/**
 * PROBE UTILITY — not a test. Smokes the Profiles editor: equip an
 * avatar decoration, apply a name style, verify both render (decoration
 * on the member-list avatar, name style scoped to home surfaces only).
 * Runs only when COSMETICS_PROBE is set.
 */

test.skip(!process.env.COSMETICS_PROBE, 'probe utility');

test('profiles editor equips decoration and name style', async ({
  browser
}) => {
  test.setTimeout(120_000);
  const { page } = await authedPage(
    browser,
    'http://127.0.0.1:14991',
    CORE_OWNER
  );

  await openUserSettings(page, 'Profiles');
  await page.screenshot({ path: '/tmp/profiles-editor.png', fullPage: false });

  // Equip the Mists decoration
  const mists = page.locator('button[title="Magic Mists"], button[title="Mists"]').first();
  await mists.scrollIntoViewIfNeeded();
  await mists.click();
  await page.waitForTimeout(700);

  // Decoration asset serves and the editor preview avatar shows the layer
  const decoImg = page
    .locator('img[src*="/decorations/mists.png"]')
    .filter({ visible: true })
    .first();
  await expect(decoImg).toBeVisible({ timeout: 10_000 });

  // Apply a neon name style
  const neonPill = page.getByRole('button', { name: 'Neon', exact: true });
  await neonPill.scrollIntoViewIfNeeded();
  await neonPill.click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: '/tmp/profiles-editor-styled.png' });
  await page.keyboard.press('Escape');

  // Member list (SERVER surface): decoration renders, name style must NOT
  const ownRow = page
    .locator('div.group')
    .filter({ has: page.getByText('E2EOwner', { exact: true }) })
    .first();
  await expect(ownRow.locator('img[src*="/decorations/"]')).toHaveCount(1, {
    timeout: 10_000
  });
  const rowNameShadow = await ownRow
    .getByText('E2EOwner', { exact: true })
    .evaluate((el) => getComputedStyle(el).textShadow);
  expect(rowNameShadow).toBe('none');
  await page.screenshot({ path: '/tmp/cosmetics-member-row.png' });

  // Home surface: popover/profile card shows the styled name
  await page.getByRole('button', { name: 'Home' }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/tmp/cosmetics-home.png' });
});
