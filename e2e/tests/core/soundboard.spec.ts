import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page
} from '@playwright/test';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { authedPage, CORE_OWNER, CORE_USER_B, RUN_TAG } from '../../helpers/fixtures';
import { openServerSettings, selectChannel, toast } from '../../helpers/ui';

/**
 * Soundboard (Tier 3, extends voice-lifecycle): the owner uploads a
 * clip under Server Settings → Sounds, both members join the voice
 * channel, the owner plays the clip from the in-call soundboard, and
 * the fan-out reaches the OTHER member's page: their copy of the
 * owner's voice tile ripples with the clip's name. Media never has to
 * flow — the assertion is on the VOICE_SOUND_PLAY signalling (the same
 * fake-device setup voice-lifecycle.spec relies on).
 *
 * Clean-up: the clip is deleted again so reruns on a lived-in instance
 * stay under the per-community cap (names are per-run anyway).
 */

const BASE = 'http://127.0.0.1:14991';
const VOICE_CHANNEL = 'General Voice';
const FIXTURE_WAV = path.join(__dirname, '..', '..', 'fixtures', 'clip.wav');

/** The voice tile of `name` in the channel view's grid. */
function voiceTile(page: Page, name: string): Locator {
  return page
    .locator('div.relative.bg-card.rounded-lg')
    .filter({ has: page.locator('span', { hasText: name }) })
    .first();
}

function disconnectButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Disconnect', exact: true });
}

let ctxA: BrowserContext;
let ctxB: BrowserContext;
let pageA: Page;
let pageB: Page;

test.describe('soundboard', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    ({ context: ctxA, page: pageA } = await authedPage(browser, BASE, CORE_OWNER));
    ({ context: ctxB, page: pageB } = await authedPage(browser, BASE, CORE_USER_B));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('a clip uploaded in settings plays from the call controls and ripples on the other member\'s page', async () => {
    test.setTimeout(120_000);
    const soundName = `clip${RUN_TAG}`;
    const file = test.info().outputPath(`${soundName}.wav`);
    copyFileSync(FIXTURE_WAV, file);

    try {
      // Upload: Server Settings → Sounds → Upload Sound (file chooser).
      // The name derives from the file name, so it is per-run unique.
      await openServerSettings(pageA, 'Sounds');
      const chooserPromise = pageA.waitForEvent('filechooser');
      await pageA.getByRole('button', { name: 'Upload Sound' }).click();
      await (await chooserPromise).setFiles(file);
      await expect(toast(pageA, 'Sound added')).toBeVisible({ timeout: 15_000 });
      // The new clip is selected in the editor (a card title, not a heading).
      await expect(pageA.getByText('Edit sound', { exact: true })).toBeVisible();
      await pageA.keyboard.press('Escape');

      // Both join the voice channel; the grid lists both tiles on both pages.
      await selectChannel(pageA, VOICE_CHANNEL);
      await selectChannel(pageB, VOICE_CHANNEL);
      await expect(disconnectButton(pageA)).toBeVisible({ timeout: 15_000 });
      await expect(disconnectButton(pageB)).toBeVisible({ timeout: 15_000 });
      await expect(voiceTile(pageB, CORE_OWNER.displayName)).toBeVisible({ timeout: 15_000 });
      await expect(voiceTile(pageA, CORE_USER_B.displayName)).toBeVisible({ timeout: 15_000 });

      // The soundboard button sits in the sidebar's voice control block
      // (mounted twice at phone width; only the visible one counts).
      await pageA.locator('[data-testid="soundboard-button"]:visible').first().click();
      const grid = pageA.locator('[data-testid="soundboard-grid"]');
      await expect(grid).toBeVisible();
      const clip = grid.locator('[data-testid="soundboard-sound"]').filter({ hasText: soundName });
      await expect(clip).toHaveCount(1, { timeout: 10_000 });
      await clip.click();

      // The fan-out reaches B: the owner's tile on B's page ripples and
      // names the clip. The ripple lives ~1.6 s, so assert promptly.
      const rippleOnB = voiceTile(pageB, CORE_OWNER.displayName).locator(
        '[data-testid="soundboard-ripple"]'
      );
      await expect(rippleOnB).toBeVisible({ timeout: 10_000 });
      await expect(rippleOnB).toContainText(soundName);
      // The room-scoped event also reaches the player's own page.
      await expect(
        voiceTile(pageA, CORE_OWNER.displayName).locator('[data-testid="soundboard-ripple"]')
      ).toHaveCount(1);

      // The per-user cooldown holds the grid for a moment after a play.
      await expect(clip).toBeDisabled();
      await expect(clip).toBeEnabled({ timeout: 5_000 });

      await pageA.keyboard.press('Escape');
      await disconnectButton(pageA).click();
      await disconnectButton(pageB).click();
      await expect(disconnectButton(pageA)).toHaveCount(0, { timeout: 10_000 });
      await expect(disconnectButton(pageB)).toHaveCount(0, { timeout: 10_000 });
    } finally {
      // Remove the clip again (the editor's trash button + confirm). A
      // settings screen may still be open from a failed step: close it
      // first, the header dropdown sits underneath it.
      await pageA.keyboard.press('Escape');
      await openServerSettings(pageA, 'Sounds');
      const row = pageA.getByRole('button').filter({ hasText: soundName }).first();
      if (await row.isVisible().catch(() => false)) {
        await row.click();
        await pageA.getByRole('button', { name: 'Delete sound' }).click();
        await pageA.getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(toast(pageA, 'Sound deleted')).toBeVisible({ timeout: 10_000 });
      }
      await pageA.keyboard.press('Escape');
    }
  });
});
