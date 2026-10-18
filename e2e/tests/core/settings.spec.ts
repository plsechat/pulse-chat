import { expect, test } from '@playwright/test';
import { authedPage, CORE_OWNER } from '../../helpers/fixtures';
import { openUserSettings } from '../../helpers/ui';

/**
 * User settings that apply instantly (no Save button) and must survive
 * closing the screen: the noise-suppression mode and its gate threshold
 * (Voice & Video). Persisted to localStorage DEVICES_SETTINGS by the
 * devices provider; a fresh context starts from the defaults.
 */

const BASE = 'http://127.0.0.1:14991';

test('noise-suppression mode and gate threshold persist across close/reopen', async ({
  browser
}) => {
  const { context, page } = await authedPage(browser, BASE, CORE_OWNER);
  try {
    await openUserSettings(page, 'Voice & Video');

    const modeSelect = page
      .locator('button[role="combobox"]')
      .filter({ hasText: /Automatic|Noise gate|Off/ });
    await expect(modeSelect).toBeVisible();
    await expect(modeSelect).toContainText('Automatic');
    await expect(page.getByText('Input level').first()).toBeVisible();

    // Switch to the manual gate: the threshold slider + dB readout appear.
    await modeSelect.click();
    await page.getByRole('option', { name: 'Noise gate' }).click();
    await expect(page.getByText('Input sensitivity').first()).toBeVisible();
    const thumb = page.locator(
      '[role="slider"][aria-label="Noise gate threshold"]'
    );
    await expect(thumb).toBeVisible();
    await expect(page.getByText('-50 dB')).toBeVisible();

    // Nudge the threshold down 10 dB via the keyboard.
    await thumb.focus();
    for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft');
    await expect(page.getByText('-60 dB')).toBeVisible();

    // Persisted immediately.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = Object.entries(localStorage).find(([k]) =>
            k.toLowerCase().includes('device')
          )?.[1];
          return raw ?? '';
        })
      )
      .toMatch(/"noiseSuppressionMode":"manual"/);

    // Close, reopen: still set.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(0);
    await openUserSettings(page, 'Voice & Video');
    await expect(
      page.locator('button[role="combobox"]').filter({ hasText: /Noise gate/ })
    ).toBeVisible();
    await expect(page.getByText('-60 dB')).toBeVisible();
  } finally {
    await context.close();
  }
});
