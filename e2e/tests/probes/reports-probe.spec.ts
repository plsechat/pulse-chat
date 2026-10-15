import { expect, test } from '@playwright/test';
import { loginUser, storageStateFor } from '../../helpers/api';
import { CORE_OWNER, CORE_USER_B } from '../../helpers/fixtures';
import {
  openMessageContextMenu,
  selectChannel,
  sendChannelMessage,
  toast,
  waitForAppReady
} from '../../helpers/ui';

/**
 * PROBE UTILITY — not a test. Smokes the LAYERED report flow on the
 * review instance:
 *  A) owner reports userB's message (spam) → server mod queue
 *     (Server Settings → Reports) → Delete content → message gone;
 *  B) userB reports the OWNER's message → target-is-mod auto-escalation
 *     → instance Review Queue (Queue tab, escalation badge) → Dismiss;
 *  C) the path-A report shows up on the Review Queue's Receipts tab.
 * Runs only when REPORTS_PROBE is set so it can never fire in CI.
 */

test.skip(!process.env.REPORTS_PROBE, 'probe utility, set REPORTS_PROBE=1');

const BASE = 'http://127.0.0.1:14991';
const SHOTS = 'probe-shots';

async function reportVisibleMessage(
  page: import('@playwright/test').Page,
  text: string
) {
  await openMessageContextMenu(page, text);
  await page.getByRole('menuitem', { name: 'Report Message' }).click();
  await expect(
    page.getByRole('heading', { name: 'Report message' })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(toast(page, /Report sent/)).toBeVisible({ timeout: 15_000 });
}

test('layered flow: mod queue, auto-escalation, receipts', async ({
  browser
}) => {
  test.setTimeout(240_000);

  const ownerTokens = await loginUser(
    BASE,
    CORE_OWNER.email,
    CORE_OWNER.password
  );
  const ownerCtx = await browser.newContext({
    storageState: storageStateFor(BASE, ownerTokens),
    baseURL: BASE
  });
  const owner = await ownerCtx.newPage();
  await owner.goto(BASE);
  await waitForAppReady(owner);
  await selectChannel(owner, 'General Text');

  const bTokens = await loginUser(
    BASE,
    CORE_USER_B.email,
    CORE_USER_B.password
  );
  const bCtx = await browser.newContext({
    storageState: storageStateFor(BASE, bTokens),
    baseURL: BASE
  });
  const b = await bCtx.newPage();
  await b.goto(BASE);
  await waitForAppReady(b);
  await selectChannel(b, 'General Text');

  const stamp = Date.now().toString(36);
  const modQueueText = `modqueue ${stamp}`;
  const escalateText = `escalate ${stamp}`;
  await sendChannelMessage(b, modQueueText);
  await sendChannelMessage(owner, escalateText);

  // A) Owner reports userB's message → routes to the server mod queue.
  await reportVisibleMessage(owner, modQueueText);
  // B) userB reports the owner's message → auto-escalates (target_mod).
  await reportVisibleMessage(b, escalateText);

  // --- Server mod queue: Server Settings → Reports ---
  await owner
    .locator('aside')
    .getByRole('button')
    .filter({ hasText: 'Pulse Server' })
    .first()
    .click();
  await owner.getByRole('menuitem', { name: 'Server Settings' }).click();
  await owner.getByRole('button', { name: 'Reports', exact: true }).click();
  // Report snapshots render as blockquotes — the channel view behind
  // the settings overlay still holds the raw message text, so scope
  // queue assertions to the card structure.
  await expect(
    owner.locator('blockquote', { hasText: modQueueText }).first()
  ).toBeVisible({ timeout: 15_000 });
  // The escalated report must NOT sit in the mod queue.
  await expect(
    owner.locator('blockquote', { hasText: escalateText })
  ).toHaveCount(0);
  await owner.screenshot({ path: `${SHOTS}/reports-1-mod-queue.png` });

  await owner.getByRole('button', { name: 'Delete content' }).first().click();
  await owner.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(toast(owner, /Resolved/)).toBeVisible({ timeout: 15_000 });

  // Takedown propagated to the reporter's own channel view.
  await expect(b.getByText(modQueueText)).toHaveCount(0, { timeout: 15_000 });

  // --- Instance Review Queue: the escalated report ---
  await owner.getByRole('button', { name: 'Review Queue' }).click();
  await expect(
    owner.locator('blockquote', { hasText: escalateText }).first()
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    owner.getByText('Reported a moderator').first()
  ).toBeVisible();
  await owner.screenshot({ path: `${SHOTS}/reports-2-instance-queue.png` });
  await owner.getByRole('button', { name: 'Dismiss' }).first().click();
  await expect(toast(owner, /dismissed/i)).toBeVisible({ timeout: 15_000 });

  // --- Receipts: the mod-handled report, visible with its outcome ---
  await owner.getByRole('button', { name: 'Receipts' }).click();
  await owner.getByRole('button', { name: 'Resolved', exact: true }).click();
  await expect(
    owner.locator('blockquote', { hasText: modQueueText }).first()
  ).toBeVisible({ timeout: 15_000 });
  await owner.screenshot({ path: `${SHOTS}/reports-3-receipts.png` });
});
