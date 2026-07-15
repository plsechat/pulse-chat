import { expect, test } from '@playwright/test';
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
