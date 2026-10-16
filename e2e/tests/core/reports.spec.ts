import { expect, test, type Page } from '@playwright/test';
import { psql } from '../../helpers/db';
import { authedPage, CORE_OWNER, CORE_USER_B, RUN_TAG } from '../../helpers/fixtures';
import {
  openMessageContextMenu,
  openServerSettings,
  selectChannel,
  sendChannelMessage,
  toast
} from '../../helpers/ui';

/**
 * The layered report flow — three UI surfaces with no other coverage:
 *  A) owner reports userB's message → server mod queue (Server Settings →
 *     Reports) → Delete content → the message is taken down live;
 *  B) userB reports the OWNER's message → target-is-mod auto-escalation →
 *     instance Review Queue (escalation badge) → Dismiss;
 *  C) the path-A report shows up on the Review Queue's Receipts tab with
 *     its outcome.
 */

const BASE = 'http://127.0.0.1:14991';

async function reportVisibleMessage(page: Page, text: string): Promise<void> {
  await openMessageContextMenu(page, text);
  await page.getByRole('menuitem', { name: 'Report Message' }).click();
  await expect(
    page.getByRole('heading', { name: 'Report message' })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(toast(page, /Report sent/)).toBeVisible({ timeout: 15_000 });
}

/**
 * The report card holding the given snapshot: the nearest ancestor div of
 * the snapshot blockquote that also holds the card's action row.
 */
function reportCard(page: Page, snapshot: string) {
  return page
    .locator('blockquote', { hasText: snapshot })
    .first()
    .locator('xpath=ancestor::div[.//button][1]');
}

test('mod queue takedown, moderator-target auto-escalation, receipts', async ({
  browser
}) => {
  test.setTimeout(240_000);
  const { context: ownerCtx, page: owner } = await authedPage(
    browser,
    BASE,
    CORE_OWNER
  );
  const { context: bCtx, page: b } = await authedPage(
    browser,
    BASE,
    CORE_USER_B
  );
  try {
    await selectChannel(owner, 'General Text');
    await selectChannel(b, 'General Text');

    const modQueueText = `modqueue ${RUN_TAG}`;
    const escalateText = `escalate ${RUN_TAG}`;
    await sendChannelMessage(b, modQueueText);
    await sendChannelMessage(owner, escalateText);

    // A) Owner reports userB's message → routes to the server mod queue.
    await reportVisibleMessage(owner, modQueueText);
    // B) userB reports the owner's message → auto-escalates (target_mod).
    await reportVisibleMessage(b, escalateText);

    // Both rows exist server-side with the expected routing.
    await expect
      .poll(() =>
        psql(
          'core',
          `SELECT count(*) FROM reports WHERE content_snapshot = '${modQueueText}'`
        )
      )
      .toBe('1');
    await expect
      .poll(() =>
        psql(
          'core',
          `SELECT count(*) FROM reports WHERE content_snapshot = '${escalateText}'`
        )
      )
      .toBe('1');

    // --- Server mod queue: Server Settings → Reports ---
    await openServerSettings(owner, 'Reports');
    // Report snapshots render as blockquotes — the channel view behind
    // the settings overlay still holds the raw message text, so queue
    // assertions are scoped to the card structure.
    await expect(
      owner.locator('blockquote', { hasText: modQueueText }).first()
    ).toBeVisible({ timeout: 15_000 });
    // The escalated report must NOT sit in the mod queue.
    await expect(
      owner.locator('blockquote', { hasText: escalateText })
    ).toHaveCount(0);

    await reportCard(owner, modQueueText)
      .getByRole('button', { name: 'Delete content' })
      .click();
    await owner.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(toast(owner, /Resolved/)).toBeVisible({ timeout: 15_000 });

    // Takedown propagated to the reporter's own channel view and the DB.
    await expect(b.getByText(modQueueText)).toHaveCount(0, {
      timeout: 15_000
    });
    await expect
      .poll(() =>
        psql(
          'core',
          `SELECT count(*) FROM messages WHERE content = '${modQueueText}'`
        )
      )
      .toBe('0');

    // --- Instance Review Queue: the escalated report ---
    await owner.getByRole('button', { name: 'Review Queue' }).click();
    await expect(
      owner.locator('blockquote', { hasText: escalateText }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      owner.getByText('Reported a moderator').first()
    ).toBeVisible();
    await reportCard(owner, escalateText)
      .getByRole('button', { name: 'Dismiss' })
      .click();
    await expect(toast(owner, /dismissed/i)).toBeVisible({ timeout: 15_000 });
    await expect(
      owner.locator('blockquote', { hasText: escalateText })
    ).toHaveCount(0, { timeout: 15_000 });
    // The owner's message survives a dismissal.
    expect(
      psql(
        'core',
        `SELECT count(*) FROM messages WHERE content = '${escalateText}'`
      )
    ).toBe('1');

    // --- Receipts: the mod-handled report, visible with its outcome ---
    await owner.getByRole('button', { name: 'Receipts' }).click();
    await owner.getByRole('button', { name: 'Resolved', exact: true }).click();
    await expect(
      owner.locator('blockquote', { hasText: modQueueText }).first()
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await ownerCtx.close();
    await bCtx.close();
  }
});
