import { expect, test } from '@playwright/test';
import { psql } from '../../helpers/db';
import {
  authedGoto,
  channelComposer,
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

test('delete own message leaves a "Message deleted" tombstone in its place', async ({ page }) => {
  const text = `to-delete ${Date.now()}`;
  await sendChannelMessage(page, text);
  const rowId = await messageRow(page, text).getAttribute('id');

  await openMessageContextMenu(page, text);
  await page.getByRole('menuitem', { name: 'Delete Message' }).click();
  // Confirmation dialog
  await page.getByRole('button', { name: 'Delete', exact: true }).click();

  // The text is gone; the row stays, with the same anchor, as a tombstone.
  await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  await expect(page.locator(`#${rowId}`)).toContainText('Message deleted');
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

test('an over-length code block is sent as a message.txt attachment', async ({
  page
}) => {
  // 17k chars inside a fence — over the 16k plaintext budget. The
  // composer converts the body into an attachment instead of rejecting
  // the send, and tells the author via a toast.
  const marker = `txt ${Date.now().toString(36)}`;
  const composer = channelComposer(page);
  await composer.click();
  await composer.fill('```\n' + marker + '\n' + 'x'.repeat(17_000) + '\n```');
  await page.keyboard.press('Enter');

  await expect(
    page.getByText('Message was over the length limit — sent as message.txt')
  ).toBeVisible({ timeout: 20_000 });

  // The attachment card (a FileCard <a href>) lands in the channel and
  // the file serves with the fenced body; the message row itself holds
  // no over-length content.
  const card = page.locator('a').filter({ hasText: 'message.txt' }).last();
  await expect(card).toBeVisible({ timeout: 15_000 });
  const href = await card.getAttribute('href');
  expect(href).not.toBeNull();
  const res = await page.request.get(new URL(href!, 'http://127.0.0.1:14991').href);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain(marker);

  const rowId = await page
    .locator('[id^="msg-"]')
    .filter({ has: card })
    .last()
    .getAttribute('id');
  const id = rowId!.slice('msg-'.length);
  expect(
    psql('core', `SELECT count(*) FROM message_files WHERE message_id = ${id}`)
  ).toBe('1');
  expect(
    psql('core', `SELECT length(coalesce(content, '')) < 16000 FROM messages WHERE id = ${id}`)
  ).toBe('t');
});
