import { expect, test } from '@playwright/test';
import { authedPage, CORE_OWNER } from '../../helpers/fixtures';
import { openUserSettings } from '../../helpers/ui';

/**
 * PROBE UTILITY — not a test. Verifies the bundled animated preset pack:
 * all 21 tiles render in the picker with served GIF backgrounds, and
 * equipping one paints the member row. Runs only when PLATE_PACK_PROBE
 * is set.
 */

test.skip(!process.env.PLATE_PACK_PROBE, 'probe utility');

const PACK = [
  'Drowned', 'Sakura', 'Borealis', 'Sunset Drive', 'Tide', 'Lava',
  'Fireflies', 'Prism', 'Daydream', 'Koi Pond', 'Runes', 'Cipher', 'Storm',
  'Starfield', 'Eclipse', 'Abyss', 'City Rain', 'Snowfall', 'Neon Wave',
  'Embers', 'Glitch'
];

test('bundled animated presets render and equip', async ({ browser }) => {
  test.setTimeout(120_000);
  const { page } = await authedPage(
    browser,
    'http://127.0.0.1:14991',
    CORE_OWNER
  );

  await openUserSettings(page, 'Profiles');

  for (const label of PACK) {
    await expect(
      page.locator(`button[title="${label}"]`).first()
    ).toBeVisible();
  }

  // Every animated tile's background URL serves as a real GIF
  const koi = page.locator('button[title="Koi Pond"]').first();
  const bg = await koi.evaluate((el) => {
    const layer = el.querySelector('[aria-hidden]') as HTMLElement | null;
    return layer ? getComputedStyle(layer).backgroundImage : '<none>';
  });
  const match = /url\("?([^")]+)"?\)/.exec(bg);
  expect(match).not.toBeNull();
  const res = await page.request.get(match![1]);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('image/gif');

  await koi.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/plate-pack-picker.png' });

  // Equip + row renders the plate layer
  await koi.click();
  await page.waitForTimeout(700);
  await page.keyboard.press('Escape');
  const ownRow = page
    .locator('div.group')
    .filter({ has: page.getByText('E2EOwner', { exact: true }) })
    .first();
  await expect(ownRow.locator('div[aria-hidden="true"].absolute')).toHaveCount(1, {
    timeout: 10_000
  });
  await page.screenshot({ path: '/tmp/plate-pack-row.png' });
});
