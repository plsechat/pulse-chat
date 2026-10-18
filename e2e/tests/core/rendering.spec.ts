import {
  expect,
  test,
  type BrowserContext,
  type Page
} from '@playwright/test';
import { psql } from '../../helpers/db';
import { authedPage, CORE_OWNER, CORE_USER_B, RUN_TAG } from '../../helpers/fixtures';
import {
  messageRow,
  openDmViaAuthor,
  selectChannel,
  sendChannelMessage,
  visibleComposer
} from '../../helpers/ui';

/**
 * Message rendering (Tier 3): mention chips, reply quoting + jump, the
 * hover-pencil inline edit flow (positive, cancel, and permission
 * negative), and a message link followed from a DM back into the
 * server channel. Two live contexts so every render is also asserted
 * as the OTHER member receives it.
 */

const BASE = 'http://127.0.0.1:14991';

let ctxA: BrowserContext;
let ctxB: BrowserContext;
let pageA: Page;
let pageB: Page;

/** `#msg-<id>` → numeric id. */
async function rowId(page: Page, text: string): Promise<string> {
  const id = await messageRow(page, text).getAttribute('id');
  expect(id).toMatch(/^msg-\d+$/);
  return id!.slice('msg-'.length);
}

test.describe('message rendering', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    ({ context: ctxA, page: pageA } = await authedPage(browser, BASE, CORE_OWNER));
    ({ context: ctxB, page: pageB } = await authedPage(browser, BASE, CORE_USER_B));
    await selectChannel(pageA, 'General Text');
    await selectChannel(pageB, 'General Text');
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('a mention renders as a chip for the author and the mentioned member', async () => {
    const marker = `mention ${RUN_TAG}`;
    // A real mention token needs the tiptap suggestion popup — .fill()
    // bypasses the '@' trigger, so type it out (presence.spec pattern).
    const composer = visibleComposer(pageA);
    await composer.click();
    await composer.pressSequentially(`@${CORE_USER_B.displayName}`);
    await pageA
      .locator('[data-tiptap-suggestion] button')
      .filter({ hasText: CORE_USER_B.displayName })
      .first()
      .click();
    await composer.pressSequentially(` ${marker}`);
    await pageA.keyboard.press('Enter');

    for (const page of [pageA, pageB]) {
      const row = messageRow(page, marker);
      await expect(row).toBeVisible({ timeout: 15_000 });
      const chip = row.locator('span.mention');
      await expect(chip).toHaveCount(1);
      await expect(chip).toHaveText(`@${CORE_USER_B.displayName}`);
      // The stored `<@id>` token never leaks as raw text.
      await expect(row).not.toContainText('<@');
    }
  });

  test('a reply quotes the original and the quote jumps back to it', async () => {
    const original = `original ${RUN_TAG}`;
    const reply = `reply ${RUN_TAG}`;
    await sendChannelMessage(pageA, original);

    // Hover action bar → Reply → the composer shows the quoted preview.
    const row = messageRow(pageA, original);
    await row.hover();
    await row.locator('button[title="Reply"]').click();
    const replyBar = pageA
      .locator('button')
      .filter({ has: pageA.locator('svg.lucide-reply') })
      .filter({ hasText: original });
    await expect(replyBar).toBeVisible();
    await expect(replyBar).toContainText(CORE_OWNER.displayName);

    const composer = visibleComposer(pageA);
    await composer.click();
    await composer.pressSequentially(reply);
    await pageA.keyboard.press('Enter');

    // Both sides: the reply row carries the quoted preview.
    for (const page of [pageA, pageB]) {
      const replyRow = messageRow(page, reply);
      await expect(replyRow).toBeVisible({ timeout: 15_000 });
      const quote = replyRow.getByRole('button').filter({ hasText: original });
      await expect(quote).toHaveCount(1);
      await expect(quote).toContainText(CORE_OWNER.displayName);
    }
    expect(
      psql(
        'core',
        `SELECT (SELECT content FROM messages o WHERE o.id = m.reply_to_id) FROM messages m WHERE m.content = '${reply}'`
      )
    ).toBe(original);

    // Clicking the quote jumps to + flashes the original (auto-clears
    // after 2.5s — assert before the fade).
    await messageRow(pageA, reply)
      .getByRole('button')
      .filter({ hasText: original })
      .click();
    await expect(row).toHaveClass(/animate-msg-highlight/, { timeout: 5_000 });
    await expect(row).toBeInViewport();
  });

  test('hover pencil edits inline (Enter saves, Escape cancels); a non-author gets no pencil', async () => {
    const before = `edit ${RUN_TAG}`;
    const after = `edited ${RUN_TAG}`;
    await sendChannelMessage(pageA, before);
    const id = await rowId(pageA, before);
    const rowA = pageA.locator(`#msg-${id}`);
    const rowB = pageB.locator(`#msg-${id}`);
    await expect(rowB).toBeVisible({ timeout: 15_000 });

    // Pencil → inline editor with its hint text, prefilled.
    await rowA.hover();
    await rowA.locator('button[title="Edit Message"]').click();
    const editor = rowA.locator('[contenteditable="true"]');
    await expect(editor).toBeVisible();
    await expect(rowA.getByText(/to save/)).toBeVisible();
    await expect(editor).toHaveText(before);

    await editor.click();
    await pageA.keyboard.press('ControlOrMeta+a');
    await pageA.keyboard.type(after);
    await pageA.keyboard.press('Enter');

    // Saved: new text + the "(edited)" marker, for both members; the
    // stored content is the token text (no HTML).
    await expect(editor).toHaveCount(0);
    for (const row of [rowA, rowB]) {
      await expect(row).toContainText(after, { timeout: 15_000 });
      await expect(row).not.toContainText(before);
      await expect(row.locator('span.edited-tag')).toHaveText('(edited)');
    }
    expect(psql('core', `SELECT content FROM messages WHERE id = ${id}`)).toBe(
      after
    );
    expect(psql('core', `SELECT edited FROM messages WHERE id = ${id}`)).toBe(
      't'
    );

    // Escape cancels: text unchanged, editor gone.
    await rowA.hover();
    await rowA.locator('button[title="Edit Message"]').click();
    await expect(editor).toBeVisible();
    await editor.click();
    await pageA.keyboard.press('ControlOrMeta+a');
    await pageA.keyboard.type('discarded');
    await pageA.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(rowA).toContainText(after);
    await expect(rowA).not.toContainText('discarded');
    expect(psql('core', `SELECT content FROM messages WHERE id = ${id}`)).toBe(
      after
    );

    // B is not the author: the hover bar renders (Reply is there) but
    // offers no pencil.
    await rowB.hover();
    await expect(rowB.locator('button[title="Reply"]')).toBeVisible();
    await expect(rowB.locator('button[title="Edit Message"]')).toHaveCount(0);
  });

  test('a message link sent in a DM jumps into the server channel', async () => {
    // Target: a message of B's in General Text (also what A clicks to
    // open the DM).
    const target = `dmlink target ${RUN_TAG}`;
    await sendChannelMessage(pageB, target);
    await expect(messageRow(pageA, target)).toBeVisible({ timeout: 15_000 });
    const targetId = await rowId(pageA, target);
    const channelId = psql(
      'core',
      `SELECT id FROM channels WHERE name = 'General Text' AND server_id = 1`
    );

    const marker = `dmlink ${RUN_TAG}`;
    const dm = await openDmViaAuthor(pageA, CORE_USER_B.displayName);
    await dm.click();
    await dm.fill(`${marker} <#msg:${channelId}/${targetId}>`);
    await pageA.keyboard.press('Enter');

    // The token renders as a "Message in <channel>" badge inside the DM.
    const badge = pageA
      .locator('[id^="dm-msg-"]')
      .filter({ hasText: marker })
      .getByRole('button', { name: 'Message in General Text' })
      .first();
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await badge.click();

    // Cross-view jump: server view + channel + highlighted target.
    const row = pageA.locator(`#msg-${targetId}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toHaveClass(/animate-msg-highlight/, { timeout: 5_000 });
    await expect(row).toBeInViewport();
    await expect(visibleComposer(pageA)).toBeVisible();
  });
});
