import { expect, test } from '@playwright/test';
import { authedPage, CORE_OWNER, CORE_USER_B } from '../../helpers/fixtures';
import {
  messageRow,
  openMessageContextMenu,
  selectChannel,
  sendChannelMessage
} from '../../helpers/ui';

/**
 * A deleted message leaves a tombstone. The owner deletes a message
 * while a second member is looking at the channel: the member's row
 * turns into "Message deleted" without a reload (the text is gone, the
 * row and its anchor stay), the owner — who holds MANAGE_MESSAGES —
 * additionally sees who deleted it and when, and the tombstone's
 * context menu offers nothing but "Copy Message Link".
 *
 * UNRUN at authoring time (the agent could not touch 14991); written
 * against pulse-e2e-conventions.md. Run with:
 *   cd e2e && npx playwright test --project=core tests/core/message-tombstone.spec.ts
 */

const BASE = 'http://127.0.0.1:14991';

test('a deleted message becomes "Message deleted" for a second member without reload', async ({
  browser
}) => {
  test.setTimeout(120_000);

  const text = `tombstone ${Date.now()}`;

  const owner = await authedPage(browser, BASE, CORE_OWNER);
  const member = await authedPage(browser, BASE, CORE_USER_B);
  try {
    await selectChannel(owner.page, 'General Text');
    await selectChannel(member.page, 'General Text');

    await sendChannelMessage(owner.page, text);
    // The member sees it live before anything is deleted.
    await expect(member.page.getByText(text, { exact: true })).toBeVisible({
      timeout: 15_000
    });
    const memberRow = messageRow(member.page, text);
    const rowId = await memberRow.getAttribute('id');
    expect(rowId).toMatch(/^msg-\d+$/);

    await openMessageContextMenu(owner.page, text);
    await owner.page.getByRole('menuitem', { name: 'Delete Message' }).click();
    await owner.page.getByRole('button', { name: 'Delete', exact: true }).click();

    // Member: the text is gone, the row (same anchor id) stays and reads
    // "Message deleted" — and nothing about who did it.
    const memberTombstone = member.page.locator(`#${rowId}`);
    await expect(memberTombstone).toBeVisible({ timeout: 15_000 });
    await expect(memberTombstone).toContainText('Message deleted');
    await expect(member.page.getByText(text, { exact: true })).toHaveCount(0);
    await expect(memberTombstone).not.toContainText('deleted by');

    // Owner (MANAGE_MESSAGES): the same row carries the audit line.
    const ownerTombstone = owner.page.locator(`#${rowId}`);
    await expect(ownerTombstone).toContainText('Message deleted');
    await expect(ownerTombstone).toContainText('deleted by');
    await expect(owner.page.getByText(text, { exact: true })).toHaveCount(0);

    // The tombstone's menu: only the message link.
    await ownerTombstone.click({ button: 'right' });
    const items = owner.page.getByRole('menuitem');
    await expect(items.first()).toBeVisible();
    await expect(items).toHaveCount(1);
    await expect(items.first()).toHaveText(/Copy Message Link/);
    await owner.page.keyboard.press('Escape');

    // Reload: the tombstone is what the server serves too.
    await member.page.reload();
    await selectChannel(member.page, 'General Text');
    await expect(member.page.locator(`#${rowId}`)).toContainText('Message deleted', {
      timeout: 20_000
    });
  } finally {
    await owner.context.close();
    await member.context.close();
  }
});
