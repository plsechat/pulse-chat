import { expect, test } from '@playwright/test';
import { authedGoto, channelComposer, selectChannel } from '../../helpers/ui';

/**
 * Voice channels have NO chat (removed 2026-07-14, commit 304b106):
 * no composer anywhere on the voice screen and no voice-chat toggle in
 * the top bar. These assertions pin the removal.
 */

test('voice channel renders no composer and no chat toggle', async ({
  page
}) => {
  await authedGoto(page, 'http://127.0.0.1:14991', 'owner@e2e.local', 'e2e-password-1234');

  // Join the seeded voice channel (fake media flags auto-grant the mic)
  await selectChannel(page, 'General Voice');

  // Own voice tile appears once join signaling completes
  await expect(page.getByText('E2EOwner').first()).toBeVisible({
    timeout: 15_000
  });

  // 1. No message composer anywhere on the voice screen
  await expect(channelComposer(page)).toHaveCount(0);
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);

  // 2. No voice-chat toggle in the top bar (the old MessageSquare icon
  //    button labeled "Open Voice Chat")
  await expect(page.getByText('Open Voice Chat')).toHaveCount(0);
  await expect(
    page.locator('button:has(svg.lucide-message-square)')
  ).toHaveCount(0);
});

test('text channel still has its composer (control)', async ({ page }) => {
  await authedGoto(page, 'http://127.0.0.1:14991', 'owner@e2e.local', 'e2e-password-1234');
  await selectChannel(page, 'General Text');
  await expect(channelComposer(page)).toBeVisible();
});
