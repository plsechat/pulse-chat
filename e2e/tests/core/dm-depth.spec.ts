import {
  expect,
  test,
  type BrowserContext,
  type Page
} from '@playwright/test';
import path from 'node:path';
import { psql } from '../../helpers/db';
import { authedPage, registerAndJoin, runUser } from '../../helpers/fixtures';
import { dmComposer, goHome } from '../../helpers/ui';

/**
 * DM depth: the friend-request loop, group-DM lifecycle, and DM
 * attachments (which completes the long-standing test.fixme in
 * files.spec.ts — its blocker was only a "live second user" fixture,
 * which the friends loop + two authed contexts provide).
 */

const BASE = 'http://127.0.0.1:14991';
const FIXTURE_PNG = path.join(__dirname, '..', '..', 'fixtures', 'pixel.png');

const A = runUser('dm-a');
const B = runUser('dm-b');
const C = runUser('dm-c');

let ctxA: BrowserContext;
let ctxB: BrowserContext;
let ctxC: BrowserContext;
let pageA: Page;
let pageB: Page;
let pageC: Page;

function uid(name: string): string {
  return psql('core', `SELECT id FROM users WHERE name = '${name}'`);
}

async function openFriends(page: Page): Promise<void> {
  await goHome(page);
  await page.getByRole('button', { name: 'Friends' }).click();
}

/** A specific All-tab friend row (scopes the hover Message/Remove buttons). */
function friendRow(page: Page, name: string) {
  return page.locator('div.group').filter({ hasText: name }).first();
}

/** Full friend-request handshake from `from` to `to`, accepted by `to`. */
async function befriend(
  from: Page,
  to: Page,
  toName: string,
  fromName: string
): Promise<void> {
  await openFriends(from);
  await from.getByRole('button', { name: 'Add Friend' }).click();
  await from.getByPlaceholder('Search by username...').fill(toName);
  await from.getByText(toName, { exact: true }).first().waitFor();
  await from.locator('button[title="Send Friend Request"]').first().click();
  await expect(from.getByText('Friend request sent')).toBeVisible({
    timeout: 15_000
  });

  await openFriends(to);
  await to.getByRole('button', { name: 'pending', exact: true }).click();
  await to.getByText(fromName, { exact: true }).first().waitFor({
    timeout: 15_000
  });
  await to.locator('button[title="Accept"]').first().click();
  await expect(to.getByText('Friend request accepted')).toBeVisible({
    timeout: 15_000
  });
}

test.describe('DM depth', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    for (const u of [A, B, C]) await registerAndJoin(browser, BASE, u);
    ({ context: ctxA, page: pageA } = await authedPage(browser, BASE, A));
    ({ context: ctxB, page: pageB } = await authedPage(browser, BASE, B));
    ({ context: ctxC, page: pageC } = await authedPage(browser, BASE, C));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
    await ctxC?.close();
  });

  test('friend request: send, live-receive, accept, both become friends', async () => {
    await befriend(pageA, pageB, B.displayName, A.displayName);

    // Friendship row exists (one row per pair) and both see the other in
    // their All list.
    expect(
      psql(
        'core',
        `SELECT count(*) FROM friendships WHERE (user_id = ${uid(A.displayName)} AND friend_id = ${uid(B.displayName)}) OR (user_id = ${uid(B.displayName)} AND friend_id = ${uid(A.displayName)})`
      )
    ).toBe('1');
    await pageA.getByRole('button', { name: 'all', exact: true }).click();
    await expect(pageA.getByText(B.displayName).first()).toBeVisible();
    // befriend leaves the acceptor on the (now-empty) pending tab — the
    // new friend lives under All.
    await pageB.getByRole('button', { name: 'all', exact: true }).click();
    await expect(pageB.getByText(A.displayName).first()).toBeVisible();
  });

  test('friend removal propagates to both sides', async () => {
    // Befriend A and C, then A removes C.
    await befriend(pageA, pageC, C.displayName, A.displayName);

    await openFriends(pageA);
    await pageA.getByRole('button', { name: 'all', exact: true }).click();
    const row = friendRow(pageA, C.displayName);
    await row.hover();
    await row.locator('button[title="Remove Friend"]').click();
    await pageA.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(pageA.getByText('Friend removed')).toBeVisible({
      timeout: 15_000
    });

    await expect
      .poll(() =>
        psql(
          'core',
          `SELECT count(*) FROM friendships WHERE (user_id = ${uid(A.displayName)} AND friend_id = ${uid(C.displayName)}) OR (user_id = ${uid(C.displayName)} AND friend_id = ${uid(A.displayName)})`
        )
      )
      .toBe('0');
  });

  test('DM attachment: token-gated /public serve (completes the files fixme)', async () => {
    // A friendship with B exists → the Friends row Message button opens a
    // deterministic 1:1 DM (the "live second user" the old fixme lacked).
    await openFriends(pageA);
    await pageA.getByRole('button', { name: 'all', exact: true }).click();
    const bRow = friendRow(pageA, B.displayName);
    await bRow.hover();
    await bRow.locator('button[title="Message"]').click();
    await expect(dmComposer(pageA)).toBeVisible({ timeout: 15_000 });

    // Upload + send an image through the DM composer.
    await pageA.locator('input[type="file"]').first().setInputFiles(FIXTURE_PNG);
    await dmComposer(pageA).click();
    await pageA.keyboard.press('Enter');

    const img = pageA.locator('img[src*="/public/"]').last();
    await expect(img).toBeVisible({ timeout: 15_000 });
    const src = await img.getAttribute('src');
    const url = new URL(src!, BASE);

    // Unguessable UUID name, original preserved only for download.
    expect(path.basename(url.pathname)).toMatch(/^[0-9a-f-]{36}\.png$/i);

    // WITH the HMAC token: 200 + original filename in the disposition.
    const ok = await pageA.request.get(url.href);
    expect(ok.status()).toBe(200);
    expect(ok.headers()['content-disposition']).toContain('pixel.png');

    // WITHOUT the token: DM attachments are 403 (the whole point of the
    // token gate — a leaked UUID URL can't be fetched by an outsider).
    url.searchParams.delete('accessToken');
    const denied = await pageA.request.get(url.href);
    expect(denied.status()).toBe(403);
  });

  test('group DM: create from friends, promote to group, leave', async () => {
    // A already has friends B and (re-added below) — need two friends for
    // a group. Re-befriend C, then create a group with B and C.
    await befriend(pageA, pageC, C.displayName, A.displayName);

    await goHome(pageA);
    await pageA.locator('button[title="Create Group DM"]').click();
    await expect(
      pageA.getByRole('heading', { name: 'Create Group DM' })
    ).toBeVisible();
    // Hand-rolled overlay (no role=dialog); the card is the .bg-popover
    // div. Don't take the innermost heading ancestor — that's the header
    // row, which excludes the friend list.
    const dialog = pageA
      .locator('div.bg-popover')
      .filter({ has: pageA.getByRole('heading', { name: 'Create Group DM' }) });
    await dialog.getByRole('button', { name: B.displayName }).click();
    await dialog.getByRole('button', { name: C.displayName }).click();
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(pageA.getByText('Group DM created')).toBeVisible({
      timeout: 15_000
    });

    // Server-side: a group DM channel with 3 members owned by A.
    const groupId = psql(
      'core',
      `SELECT dc.id FROM dm_channels dc
       WHERE dc.is_group = true AND dc.owner_id = ${uid(A.displayName)}
       ORDER BY dc.id DESC LIMIT 1`
    );
    expect(groupId).not.toBe('');
    await expect
      .poll(() =>
        psql(
          'core',
          `SELECT count(*) FROM dm_channel_members WHERE dm_channel_id = ${groupId}`
        )
      )
      .toBe('3');

    // B sees the group in their sidebar with the member-count subtitle.
    await goHome(pageB);
    await expect(pageB.getByText('3 members').first()).toBeVisible({
      timeout: 15_000
    });

    // C leaves → member count drops but is_group stays true (Phase-B
    // gotcha: a shrunk group must not silently demote to 1:1, or old
    // group-encrypted history stops decrypting).
    await goHome(pageC);
    await pageC.getByText('3 members').first().click({ button: 'right' });
    await pageC.getByRole('menuitem', { name: 'Leave Group' }).click();
    await pageC.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect(pageC.getByText('You left the conversation')).toBeVisible({
      timeout: 15_000
    });

    await expect
      .poll(() =>
        psql(
          'core',
          `SELECT count(*) FROM dm_channel_members WHERE dm_channel_id = ${groupId}`
        )
      )
      .toBe('2');
    expect(
      psql('core', `SELECT is_group FROM dm_channels WHERE id = ${groupId}`)
    ).toBe('t');
    // The removed member's channel list drops the group.
    await expect(pageC.getByText('2 members')).toHaveCount(0);
  });
});
