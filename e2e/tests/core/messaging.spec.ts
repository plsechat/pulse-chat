import { expect, test } from '@playwright/test';
import { psql } from '../../helpers/db';
import {
  authedGoto,
  messageRow,
  openMessageContextMenu,
  selectChannel,
  sendChannelMessage
} from '../../helpers/ui';

/**
 * Messaging + the reaction-picker regression.
 *
 * Regression background (2026-07-14): opening the emoji picker from the
 * message context menu ("Add Reaction") used to close instantly — first
 * because the picker Popover was nested inside the context menu's
 * dismiss layer, then because the closing menu's trapped FocusScope
 * stole focus and the non-modal Popover dismissed on focus-outside.
 * These tests pin the fixed behavior: the picker must survive hovering
 * and actually deliver a reaction.
 */

test.beforeEach(async ({ page }) => {
  await authedGoto(page, 'http://127.0.0.1:14991', 'owner@e2e.local', 'e2e-password-1234');
  await selectChannel(page, 'General Text');
});

test('react to a message via the hover action bar', async ({ page }) => {
  const text = `hover-react ${Date.now()}`;
  await sendChannelMessage(page, text);

  const row = messageRow(page, text);
  await row.hover();
  // The smile button lives in THIS row's hover bar (every row has one).
  await row.locator('button:has(svg.lucide-smile)').first().click();

  const search = page.getByPlaceholder('Search');
  await expect(search).toBeVisible();
  await search.fill('thumbs up');
  await search.press('Enter');

  await expect(page.locator('text=👍').first()).toBeVisible();
});

test('context-menu Add Reaction: picker survives hover and lands the reaction', async ({
  page
}) => {
  const text = `ctx-react ${Date.now()}`;
  await sendChannelMessage(page, text);

  await openMessageContextMenu(page, text);
  await page.getByRole('menuitem', { name: 'Add Reaction' }).click();

  const search = page.getByPlaceholder('Search');
  await expect(search).toBeVisible();

  // THE regression assertion: hover around inside the picker, wait,
  // hover again — it must not self-dismiss (focus-war regression).
  const picker = page.locator('em-emoji-picker');
  await picker.hover();
  await page.waitForTimeout(1500);
  await picker.hover({ position: { x: 60, y: 120 } });
  await expect(search).toBeVisible();

  // Search must be typable (emoji-mart owns focus, not the dead menu)
  await search.fill('heart');
  await expect(search).toHaveValue('heart');

  // Pick the first result via keyboard and assert the chip lands.
  await search.press('Enter');
  await expect(page.locator('text=❤').first()).toBeVisible();
});

test('context menu offers the full action set on own message', async ({
  page
}) => {
  const text = `ctx-menu ${Date.now()}`;
  await sendChannelMessage(page, text);

  await openMessageContextMenu(page, text);

  for (const item of [
    'Reply',
    'Edit Message',
    'Add Reaction',
    'Copy Text',
    'Copy Message Link',
    'Delete Message'
  ]) {
    await expect(page.getByRole('menuitem', { name: item })).toBeVisible();
  }
  await page.keyboard.press('Escape');
});

test('delete own message removes it from the pane', async ({ page }) => {
  const text = `to-delete ${Date.now()}`;
  await sendChannelMessage(page, text);

  await openMessageContextMenu(page, text);
  await page.getByRole('menuitem', { name: 'Delete Message' }).click();
  // Confirmation dialog
  await page.getByRole('button', { name: 'Delete', exact: true }).click();

  await expect(page.getByText(text, { exact: true })).toHaveCount(0);
});

test('a 16k code-block message renders without freezing the tab', async ({
  page
}) => {
  // Regression (reported 2026-07-15): a message holding a ~16k code block
  // blocked the main thread for many seconds — hljs.highlightAuto ran
  // every registered grammar over the block, and re-ran on every remount,
  // so the conversation was effectively bricked. Fixed by budgeting the
  // highlight work (auto-detect ≤4k chars, explicit language ≤30k, plain
  // text beyond).
  //
  // The row is injected directly: the freeze lived in the RENDER path,
  // which this exercises fully, and the tiptap composer can't produce a
  // 16k code block in reasonable test time. chr(96) = backtick.
  const marker = `bigcode ${Date.now().toString(36)}`;
  psql(
    'core',
    `INSERT INTO messages (content, user_id, channel_id, created_at)
     SELECT '${marker}' || E'\n' || repeat(chr(96), 3) || E'\n' || repeat('x', 15900) || E'\n' || repeat(chr(96), 3),
            u.id, c.id, (extract(epoch from now()) * 1000)::bigint
     FROM users u, channels c
     WHERE u.name = 'E2EOwner' AND c.name = 'General Text 2'`
  );

  await selectChannel(page, 'General Text 2');
  // The marker renders as a bare text node beside the code block (no own
  // wrapper element), so match the message ROW by substring.
  await expect(
    page.locator('[id^="msg-"]').filter({ hasText: marker }).first()
  ).toBeVisible({ timeout: 15_000 });

  // The tab must stay responsive while (and after) the block renders: a
  // trivial evaluate has to come back promptly. Pre-fix this timed out —
  // the main thread was pinned inside highlightAuto.
  const responsive = await Promise.race([
    page.evaluate(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000))
  ]);
  expect(responsive).toBe(true);
});
