import { expect, test } from '@playwright/test';
import { authedPage, CORE_OWNER } from '../../helpers/fixtures';
import { openUserSettings } from '../../helpers/ui';

/**
 * PROBE UTILITY — not a test. Verifies the noise-suppression settings UI
 * (mode select, live input meter, gate threshold slider) against the local
 * review stack. Runs only when MIC_PROBE is set so it can never fire in CI.
 */

test.skip(!process.env.MIC_PROBE, 'probe utility, set MIC_PROBE=1');

test('noise suppression settings UI probe', async ({ browser }) => {
  test.setTimeout(120_000);
  const { page } = await authedPage(
    browser,
    'http://127.0.0.1:14991',
    CORE_OWNER
  );

  await openUserSettings(page, 'Voice & Video');

  // Mode select present, defaults to Automatic
  const modeSelect = page
    .locator('button[role="combobox"]')
    .filter({ hasText: /Automatic|Noise gate|Off/ });
  await expect(modeSelect).toBeVisible();
  await expect(modeSelect).toContainText('Automatic');

  // Live meter present and moving (fake mic emits a tone)
  await expect(page.getByText('Input level').first()).toBeVisible();
  const fill = page.locator('div.relative.h-2\\.5 > div.absolute');
  await expect(fill).toBeVisible();
  await expect
    .poll(
      async () => {
        const width = await fill.evaluate(
          (el) => (el as HTMLElement).getBoundingClientRect().width
        );
        return width;
      },
      { timeout: 15_000 }
    )
    .toBeGreaterThan(2);
  await page.screenshot({ path: '/tmp/mic-probe-auto.png' });

  // Switch to manual gate: slider thumb + dB readout appear
  await modeSelect.click();
  await page.getByRole('option', { name: 'Noise gate' }).click();
  await expect(page.getByText('Input sensitivity').first()).toBeVisible();
  const thumb = page.locator('[role="slider"][aria-label="Noise gate threshold"]');
  await expect(thumb).toBeVisible();
  await expect(page.getByText('-50 dB')).toBeVisible();

  // Drag the threshold left — with the fake tone above threshold the
  // gate should open (fill turns emerald)
  await thumb.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft');
  await expect(page.getByText('-60 dB')).toBeVisible();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/tmp/mic-probe-manual.png' });

  // Settings apply instantly (no Save button): close, reopen, still set
  await page.keyboard.press('Escape');
  await openUserSettings(page, 'Voice & Video');
  await expect(
    page
      .locator('button[role="combobox"]')
      .filter({ hasText: /Noise gate/ })
  ).toBeVisible();
  await expect(page.getByText('-60 dB')).toBeVisible();
});
