import { expect, test } from '@playwright/test';
import { loginUser, storageStateFor } from '../../helpers/api';
import { CORE_OWNER, CORE_USER_B } from '../../helpers/fixtures';
import { openDmWith, sendDmMessage, waitForAppReady } from '../../helpers/ui';

/**
 * PROBE — DM messages render through the shared ChatMessageBody:
 * emoji-only sizing applies (previously channel-only) and plain text
 * still renders. Gated on DM_BODY_PROBE.
 */
test.skip(!process.env.DM_BODY_PROBE, 'probe, set DM_BODY_PROBE=1');

const BASE = 'http://127.0.0.1:14991';

test('DM body renders via shared component with emoji-only parity', async ({
  browser
}) => {
  test.setTimeout(90_000);
  const tokens = await loginUser(BASE, CORE_OWNER.email, CORE_OWNER.password);
  const ctx = await browser.newContext({
    storageState: storageStateFor(BASE, tokens),
    baseURL: BASE
  });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await waitForAppReady(page);
  await openDmWith(page, CORE_USER_B.displayName);

  const text = `shared-body ${Date.now().toString(36)}`;
  await sendDmMessage(page, text);
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 15_000 });

  await sendDmMessage(page, '🎉🎉');
  // Emoji-only sizing (the .emoji-only class) now applies in DMs too.
  await expect(page.locator('.msg-content.emoji-only').last()).toBeVisible({
    timeout: 15_000
  });
  await page.screenshot({ path: 'probe-shots/dm-shared-body.png' });
});
