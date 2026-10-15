import { expect, test } from '@playwright/test';
import { authedPage, CORE_OWNER } from '../../helpers/fixtures';
import { openUserSettings } from '../../helpers/ui';

/**
 * PROBE UTILITY — not a test. Verifies an animated GIF nameplate skips
 * the crop step (which would flatten it), uploads, serves, and shows in
 * the picker. Runs only when GIF_PLATE_PROBE is set.
 */

test.skip(!process.env.GIF_PLATE_PROBE, 'probe utility');

test('animated gif nameplate uploads uncropped', async ({ browser }) => {
  test.setTimeout(120_000);
  const { page } = await authedPage(
    browser,
    'http://127.0.0.1:14991',
    CORE_OWNER
  );

  await page
    .locator('aside')
    .getByRole('button')
    .filter({ hasText: 'Pulse Server' })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await page.getByRole('button', { name: 'Nameplates', exact: true }).click();

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose Image' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles('fixtures/pulse-nameplate-drowned.gif');

  // GIFs must NOT get the crop dialog — straight to the upload form
  await expect(
    page.getByRole('heading', { name: 'Crop nameplate' })
  ).toHaveCount(0);
  const nameInput = page.getByPlaceholder('Enter nameplate name');
  await expect(nameInput).toBeVisible();
  await nameInput.fill('Drowned');
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByText('Nameplate uploaded')).toBeVisible({
    timeout: 15_000
  });

  // Picker shows it and the served file is a real (animated) gif
  await page.keyboard.press('Escape');
  await openUserSettings(page, 'Profiles');
  const tile = page.locator('button[title="Drowned"]').first();
  await tile.scrollIntoViewIfNeeded();
  await expect(tile).toBeVisible();
  const bg = await tile.evaluate((el) => {
    const layer = el.querySelector('[aria-hidden]') as HTMLElement | null;
    return layer ? getComputedStyle(layer).backgroundImage : '<none>';
  });
  const match = /url\("?([^")]+)"?\)/.exec(bg);
  expect(match).not.toBeNull();
  const res = await page.request.get(match![1]);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('image/gif');
  expect((await res.body()).length).toBeGreaterThan(100_000);

  // Equip it so the member row shows the animated plate
  await tile.click();
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: '/tmp/gif-plate-row.png' });
});
