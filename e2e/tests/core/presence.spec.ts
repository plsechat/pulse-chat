import {
  expect,
  test,
  type BrowserContext,
  type Page
} from '@playwright/test';
import { psql } from '../../helpers/db';
import { authedPage, registerAndJoin, runUser } from '../../helpers/fixtures';
import {
  goHome,
  openDmViaAuthor,
  selectChannel,
  sendChannelMessage
} from '../../helpers/ui';

/**
 * Presence, custom status, and unread/read-state — three of the nine
 * v0.2.3 bug reports lived here. Everything is cross-context (presence is
 * in-memory on the server, never a DB row), so each test drives two live
 * browser contexts and asserts propagation with NO page refresh.
 */

const BASE = 'http://127.0.0.1:14991';

const USER_A = runUser('presence-a');
const USER_B = runUser('presence-b');

let ctxA: BrowserContext;
let ctxB: BrowserContext;
let pageA: Page;
let pageB: Page;

function userId(displayName: string): string {
  return psql('core', `SELECT id FROM users WHERE name = '${displayName}'`);
}

function channelId(name: string): string {
  return psql(
    'core',
    `SELECT id FROM channels WHERE name = '${name}' ORDER BY id LIMIT 1`
  );
}

/** Change own presence via the user-control status dropdown. */
async function setStatus(page: Page, from: string, to: string): Promise<void> {
  await page.getByRole('button', { name: from, exact: true }).first().click();
  await page.getByRole('menuitem', { name: to, exact: true }).click();
}

/**
 * Open the author popover for a user from their message in the open
 * channel. Delegates to openDmViaAuthor, which waits for the popover to
 * bind to the RIGHT user (its inline composer placeholder names them).
 */
async function openAuthorPopover(page: Page, displayName: string): Promise<void> {
  await openDmViaAuthor(page, displayName);
}

test.describe('presence, status, and read-state', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    await registerAndJoin(browser, BASE, USER_A);
    await registerAndJoin(browser, BASE, USER_B);
    ({ context: ctxA, page: pageA } = await authedPage(browser, BASE, USER_A));
    ({ context: ctxB, page: pageB } = await authedPage(browser, BASE, USER_B));
    // Both post once so each can open the other's author popover from the
    // channel (the popover is the DM entry point, and the status-propagation
    // assertions read from it).
    await selectChannel(pageA, 'General Text');
    await sendChannelMessage(pageA, `presence hello ${USER_A.displayName}`);
    await selectChannel(pageB, 'General Text');
    await sendChannelMessage(pageB, `presence hello ${USER_B.displayName}`);
    await expect(
      pageA.getByText(`presence hello ${USER_B.displayName}`, { exact: true })
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      pageB.getByText(`presence hello ${USER_A.displayName}`, { exact: true })
    ).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('online status change propagates to the other user with no refresh', async () => {
    // A goes DND; B (already looking at A's message) sees it via A's popover.
    await setStatus(pageA, 'Online', 'Do Not Disturb');
    await openAuthorPopover(pageB, USER_A.displayName);
    // Popover status line renders the raw enum (capitalize is CSS-only).
    await expect(pageB.getByText('dnd', { exact: true })).toBeVisible({
      timeout: 15_000
    });
    await pageB.keyboard.press('Escape');

    // Flip to Idle — the popover re-renders live off the users slice.
    await setStatus(pageA, 'Do Not Disturb', 'Idle');
    await openAuthorPopover(pageB, USER_A.displayName);
    await expect(pageB.getByText('idle', { exact: true })).toBeVisible({
      timeout: 15_000
    });
    await pageB.keyboard.press('Escape');

    await setStatus(pageA, 'Idle', 'Online');
  });

  test('custom status (text + emoji) persists and shows to the other user', async () => {
    const statusText = `testing ${USER_A.displayName}`;
    await pageA.getByRole('button', { name: 'Online', exact: true }).first().click();
    await pageA.getByRole('menuitem', { name: 'Set custom status…' }).click();
    await expect(
      pageA.getByRole('heading', { name: 'Set custom status' })
    ).toBeVisible();

    // Emoji: open the picker and take the first result for a stable pick.
    await pageA.getByTitle('Add an emoji').click();
    const emojiSearch = pageA.getByPlaceholder('Search');
    await emojiSearch.fill('rocket');
    await emojiSearch.press('Enter');

    await pageA.getByPlaceholder("What's happening?").fill(statusText);
    await pageA.getByRole('button', { name: 'Save' }).click();

    // Persisted to the users row (text + emoji columns).
    await expect
      .poll(
        () =>
          psql(
            'core',
            `SELECT custom_status FROM users WHERE id = ${userId(USER_A.displayName)}`
          ),
        { timeout: 15_000 }
      )
      .toBe(statusText);
    expect(
      psql(
        'core',
        `SELECT custom_status_emoji FROM users WHERE id = ${userId(USER_A.displayName)}`
      )
    ).not.toBe('');

    // Visible to B in A's popover (emoji + text render there).
    await openAuthorPopover(pageB, USER_A.displayName);
    await expect(pageB.getByText(statusText)).toBeVisible({ timeout: 15_000 });
    await pageB.keyboard.press('Escape');
  });

  test('channel unread badge increments cross-context and clears on view', async () => {
    // Unread is counted relative to a read-state pointer: a channel the
    // user has NEVER opened has no pointer and therefore no unread badge
    // (server query requires lastReadMessageId IS NOT NULL). So B must
    // visit General Text 2 once to set the baseline, THEN park elsewhere.
    await selectChannel(pageB, 'General Text 2');
    await expect(
      pageB.locator('[contenteditable="true"]').first()
    ).toBeVisible();
    await selectChannel(pageB, 'General Text');

    const msg = `unread probe ${USER_A.displayName} ${Date.now()}`;
    await selectChannel(pageA, 'General Text 2');
    await sendChannelMessage(pageA, msg);

    // B's sidebar row for the unseen channel turns bold and shows a count
    // badge — with NO refresh.
    const row = pageB.getByRole('button', { name: /^General Text 2/ }).first();
    await expect(row).toHaveClass(/font-semibold/, { timeout: 15_000 });
    await expect(
      row.locator('div.bg-primary, div.bg-destructive')
    ).toBeVisible();

    // Viewing the channel writes the server-side read state up to the
    // newest message. force: non-owner rows carry the dnd aria-disabled
    // marker (not a real click gate).
    await row.click({ force: true });
    const chan = channelId('General Text 2');
    const uid = userId(USER_B.displayName);
    const newestId = psql(
      'core',
      `SELECT max(id) FROM messages WHERE channel_id = ${chan}`
    );
    await expect
      .poll(
        () =>
          psql(
            'core',
            `SELECT last_read_message_id FROM channel_read_states WHERE user_id = ${uid} AND channel_id = ${chan}`
          ),
        { timeout: 15_000 }
      )
      .toBe(newestId);
    await expect(row).not.toHaveClass(/font-semibold/);
  });

  test('an @mention paints the unread badge red (destructive), not the normal blue', async () => {
    // B keeps its General Text 2 baseline from the previous test but parks
    // on General Text so the mention lands unseen.
    await selectChannel(pageB, 'General Text');

    // A composes a real mention token via the tiptap suggestion popup —
    // .fill() bypasses the '@' trigger, so type it out.
    await selectChannel(pageA, 'General Text 2');
    const composer = pageA
      .locator('[contenteditable="true"]')
      .filter({ visible: true })
      .first();
    await composer.click();
    await composer.pressSequentially(`@${USER_B.displayName}`);
    await pageA
      .locator('[data-tiptap-suggestion] button')
      .filter({ hasText: USER_B.displayName })
      .first()
      .click();
    await composer.pressSequentially(' ping');
    await pageA.keyboard.press('Enter');

    // B's General Text 2 row shows the DESTRUCTIVE (red) badge — the
    // mention discriminator — rather than the primary (blue) one.
    const row = pageB.getByRole('button', { name: /^General Text 2/ }).first();
    await expect(
      row.locator('div.bg-destructive')
    ).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('div.bg-primary')).toHaveCount(0);

    // Server-side the mention counter incremented for B.
    const chan = channelId('General Text 2');
    const uid = userId(USER_B.displayName);
    await row.click({ force: true });
    await expect
      .poll(
        () =>
          psql(
            'core',
            `SELECT last_read_message_id FROM channel_read_states WHERE user_id = ${uid} AND channel_id = ${chan}`
          ),
        { timeout: 15_000 }
      )
      .toBe(psql('core', `SELECT max(id) FROM messages WHERE channel_id = ${chan}`));
  });

  test('a DM sent while away lights the Home rail badge and clears on open', async () => {
    // Establish the DM from A's side via the author popover, then leave B
    // on a server view so the incoming DM is "unseen".
    await selectChannel(pageA, 'General Text');
    const composer = await openDmViaAuthor(pageA, USER_B.displayName);
    const dmMsg = `dm ping ${USER_A.displayName} ${Date.now()}`;
    await composer.fill(dmMsg);
    await pageA.keyboard.press('Enter');
    await expect(
      pageA.locator('[id^="dm-msg-"]').getByText(dmMsg, { exact: true })
    ).toBeVisible({ timeout: 15_000 });

    // B is on a server channel — not viewing the DM.
    await selectChannel(pageB, 'General Text');
    // The Home rail button grows an unread-DM badge (its title carries the
    // count; the badge text also replaces the accessible name).
    await expect(
      pageB.getByTitle(/unread DM/).first()
    ).toBeVisible({ timeout: 15_000 });

    // Opening the DM writes the read state and clears the badge.
    await goHome(pageB);
    await pageB.getByText(USER_A.displayName).first().click();
    await expect(
      pageB.locator('[id^="dm-msg-"]').getByText(dmMsg, { exact: true })
    ).toBeVisible({ timeout: 15_000 });
    await expect(pageB.getByTitle(/unread DM/)).toHaveCount(0, {
      timeout: 15_000
    });
  });
});
