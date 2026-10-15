import { expect, test } from '@playwright/test';
import { authedPage, CORE_OWNER } from '../../helpers/fixtures';
import { openUserSettings } from '../../helpers/ui';

/**
 * PROBE UTILITY — not a test. Reproduces the "server nameplates render
 * blank in the picker" report: uploads a colorful pack image via the
 * admin tab, then inspects the picker tile's computed style and whether
 * the file URL actually serves. Runs only when NAMEPLATE_UPLOAD_PROBE
 * is set.
 */

test.skip(!process.env.NAMEPLATE_UPLOAD_PROBE, 'probe utility');

test('uploaded pack renders in the picker', async ({ browser }) => {
  test.setTimeout(120_000);
  const { page } = await authedPage(
    browser,
    'http://127.0.0.1:14991',
    CORE_OWNER
  );

  const packName = `plate-${Date.now().toString(36)}`;

  // Upload via Server Settings -> Nameplates
  await page
    .locator('aside')
    .getByRole('button')
    .filter({ hasText: 'Pulse Server' })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await page.getByRole('button', { name: 'Nameplates', exact: true }).click();
  await page.screenshot({ path: '/tmp/plate-admin-before.png' });

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose Image' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles('fixtures/plate-test.png');

  // Crop step runs between pick and the upload form
  await expect(
    page.getByRole('heading', { name: 'Crop nameplate' })
  ).toBeVisible();
  await page.screenshot({ path: '/tmp/plate-crop.png' });
  await page.getByRole('button', { name: 'Crop', exact: true }).click();

  const nameInput = page.getByPlaceholder('Enter nameplate name');
  await nameInput.fill(packName);
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByText(packName).first()).toBeVisible({
    timeout: 15_000
  });
  await page.screenshot({ path: '/tmp/plate-admin-after.png' });
  await page.keyboard.press('Escape');

  // Open the picker and inspect the pack tile
  await openUserSettings(page, 'Profiles');
  await expect(page.getByText('Server nameplates')).toBeVisible({
    timeout: 10_000
  });
  const tile = page.locator(`button[title="${packName}"]`).first();
  await tile.scrollIntoViewIfNeeded();
  await expect(tile).toBeVisible();

  const layerInfo = await tile.evaluate((el) => {
    const layer = el.querySelector('[aria-hidden]') as HTMLElement | null;
    if (!layer) return { hasLayer: false as const };
    const style = getComputedStyle(layer);
    return {
      hasLayer: true as const,
      inlineStyle: layer.getAttribute('style'),
      backgroundImage: style.backgroundImage,
      maskImage: style.maskImage || (style as unknown as Record<string, string>)['webkitMaskImage']
    };
  });
  console.log('TILE LAYER:', JSON.stringify(layerInfo, null, 2));

  // Does the referenced URL actually serve?
  const match = /url\("?([^")]+)"?\)/.exec(layerInfo.hasLayer ? (layerInfo.backgroundImage ?? '') : '');
  if (match) {
    const res = await page.request.get(match[1]);
    console.log('IMAGE URL:', match[1], 'status:', res.status(), 'content-type:', res.headers()['content-type'], 'bytes:', (await res.body()).length);
  } else {
    console.log('NO URL IN backgroundImage');
  }

  await page.screenshot({ path: '/tmp/plate-picker.png' });
});
