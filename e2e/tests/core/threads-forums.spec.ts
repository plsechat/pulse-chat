import {
  expect,
  test,
  type BrowserContext,
  type Page
} from '@playwright/test';
import { psql } from '../../helpers/db';
import { authedPage, CORE_OWNER } from '../../helpers/fixtures';
import {
  channelButton,
  messageRow,
  openMessageContextMenu,
  selectChannel,
  sendChannelMessage,
  toast
} from '../../helpers/ui';

/**
 * Threads and forum channels — ZERO prior coverage anywhere (unit or e2e).
 * Runs as the operator (MANAGE_CHANNELS) so archive/delete surfaces render.
 *
 * Composer ambiguity rule: while a thread panel is open there are TWO
 * tiptap composers whose placeholder starts with "Message #" — the shared
 * channelComposer() helper strict-mode-fails. Always address thread
 * composers by their EXACT placeholder.
 */

const BASE = 'http://127.0.0.1:14991';
const RUN = Date.now().toString(36);

const SOURCE_MSG = `thread source ${RUN}`;
const THREAD_REPLY = `thread reply ${RUN}`;
const FORUM_NAME = `forum-${RUN}`;
const POST_TITLE = `Post ${RUN}`;
const POST_BODY = `forum post body ${RUN}`;
const POST_REPLY = `forum reply ${RUN}`;

let ctx: BrowserContext;
let page: Page;

function threadComposer(p: Page, name: string) {
  return p.locator(
    `[contenteditable="true"]:has(p[data-placeholder="Message #${name}"])`
  );
}

test.describe('threads and forums', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    ({ context: ctx, page } = await authedPage(browser, BASE, CORE_OWNER));
  });

  test.afterAll(async () => {
    await ctx?.close();
  });

  test('create an inline thread from a message and reply in the panel', async () => {
    await selectChannel(page, 'General Text');
    await sendChannelMessage(page, SOURCE_MSG);

    await openMessageContextMenu(page, SOURCE_MSG);
    await page.getByRole('menuitem', { name: 'Create Thread' }).click();
    await expect(toast(page, 'Thread created')).toBeVisible({
      timeout: 15_000
    });

    // The side panel opens with the (fixed-name) thread composer.
    const composer = threadComposer(page, 'Thread');
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.click();
    await composer.fill(THREAD_REPLY);
    await page.keyboard.press('Enter');
    await expect(
      page.locator('[id^="msg-"]').getByText(THREAD_REPLY, { exact: true })
    ).toBeVisible({ timeout: 15_000 });

    // Server-side: a THREAD channel hangs off the parent, the source
    // message points at it, and the reply landed INSIDE it (the source
    // message itself is not copied in).
    const threadId = psql(
      'core',
      `SELECT thread_id FROM messages WHERE content = '${SOURCE_MSG}'`
    );
    expect(threadId).not.toBe('');
    expect(
      psql('core', `SELECT type FROM channels WHERE id = ${threadId}`)
    ).toBe('THREAD');
    expect(
      psql(
        'core',
        `SELECT count(*) FROM messages WHERE channel_id = ${threadId}`
      )
    ).toBe('1');

    // The source message now shows a thread indicator and loses the
    // Create Thread menu item (no thread-on-thread).
    await expect(
      messageRow(page, SOURCE_MSG).getByRole('button', { name: 'Thread' })
    ).toBeVisible();
    await openMessageContextMenu(page, SOURCE_MSG);
    await expect(
      page.getByRole('menuitem', { name: 'Create Thread' })
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('the Threads popover lists the thread; archive and delete work', async () => {
    // Top-bar Threads trigger is icon-only (List icon, tooltip-only name).
    await page.locator('button:has(svg.lucide-list)').first().click();
    await expect(page.getByText('Threads', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: /^Thread/ })
      .filter({ hasText: 'message' })
      .first()
      .click();

    // Panel reopens on the thread — the reply is there.
    await expect(
      page.locator('[id^="msg-"]').getByText(THREAD_REPLY, { exact: true })
    ).toBeVisible({ timeout: 15_000 });

    // Archive (MANAGE_CHANNELS), then delete with confirm.
    await page.locator('button[title="Archive Thread"]').click();
    await expect(toast(page, 'Thread archived')).toBeVisible({
      timeout: 15_000
    });
    const threadId = psql(
      'core',
      `SELECT thread_id FROM messages WHERE content = '${SOURCE_MSG}'`
    );
    await expect
      .poll(() =>
        psql('core', `SELECT archived FROM channels WHERE id = ${threadId}`)
      )
      .toBe('t');

    // Title differs by path: 'Delete (only while empty)' when the viewer
    // is the creator with no foreign replies, 'Delete Thread' otherwise.
    // Exact titles — a prefix match also hits message hover-bar buttons.
    await page
      .locator(
        'button[title="Delete (only while empty)"], button[title="Delete Thread"]'
      )
      .first()
      .click();
    await expect(
      page.getByText('This will permanently remove the thread', {
        exact: false
      })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(toast(page, 'Thread deleted')).toBeVisible({
      timeout: 15_000
    });
    await expect
      .poll(() =>
        psql('core', `SELECT count(*) FROM channels WHERE id = ${threadId}`)
      )
      .toBe('0');
    // The panel closed with the thread.
    await expect(threadComposer(page, 'Thread')).toHaveCount(0);
  });

  test('create a forum channel, post into it, reply in the two-panel view', async () => {
    // Dismiss any lingering thread panel / popover from earlier tests so
    // the first click reaches the Create-channel button (a stray overlay
    // silently swallows it otherwise). Retry the open until the dialog
    // actually appears.
    await page.keyboard.press('Escape');
    const dialog = page.getByRole('dialog');
    const dialogHeading = dialog.getByRole('heading', {
      name: 'Create New Channel'
    });
    await expect(async () => {
      await page.locator('button[title="Create channel"]').first().click();
      await expect(dialogHeading).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    await dialog.getByText('Forum Channel', { exact: true }).click();
    await dialog.getByPlaceholder('Channel name').fill(FORUM_NAME);
    await dialog.getByRole('button', { name: 'Create channel' }).click();

    await selectChannel(page, FORUM_NAME);
    await expect(page.getByText('No posts yet')).toBeVisible({
      timeout: 15_000
    });

    // New Post (hand-rolled overlay — no role=dialog).
    await page.getByRole('button', { name: 'New Post' }).click();
    await page.getByPlaceholder('Post title').fill(POST_TITLE);
    await page.getByPlaceholder('Write your post...').fill(POST_BODY);
    await page.getByRole('button', { name: 'Create Post' }).click();
    await expect(toast(page, 'Post created')).toBeVisible({ timeout: 15_000 });

    // Two-panel layout: posts list + thread view with the post as its
    // first message.
    await expect(page.getByTestId('forum-posts')).toBeVisible();
    await expect(page.getByTestId('forum-thread')).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 1, name: POST_TITLE })
    ).toBeVisible();
    await expect(
      page.locator('[id^="msg-"]').getByText(POST_BODY, { exact: true })
    ).toBeVisible();

    // Reply inside the post thread.
    const composer = threadComposer(page, POST_TITLE);
    await composer.click();
    await composer.fill(POST_REPLY);
    await page.keyboard.press('Enter');
    await expect(
      page.locator('[id^="msg-"]').getByText(POST_REPLY, { exact: true })
    ).toBeVisible({ timeout: 15_000 });

    // Server-side: THREAD child of the forum, 2 messages (post + reply),
    // creator auto-follows.
    const forumId = psql(
      'core',
      `SELECT id FROM channels WHERE name = '${FORUM_NAME}'`
    );
    expect(
      psql('core', `SELECT type FROM channels WHERE id = ${forumId}`)
    ).toBe('FORUM');
    const postId = psql(
      'core',
      `SELECT id FROM channels WHERE parent_channel_id = ${forumId}`
    );
    await expect
      .poll(() =>
        psql('core', `SELECT count(*) FROM messages WHERE channel_id = ${postId}`)
      )
      .toBe('2');
    expect(
      psql(
        'core',
        `SELECT count(*) FROM thread_followers WHERE thread_id = ${postId}`
      )
    ).toBe('1');
  });

  test('forum post card menu: follow toggle and delete post', async () => {
    // Right-click the post CARD (a button containing the title heading).
    // Its menu has no 'Reply' sentinel — wait for 'Open Post' instead.
    const card = page
      .getByRole('button')
      .filter({ has: page.getByRole('heading', { name: POST_TITLE }) })
      .first();
    await card.click({ button: 'right' });
    await expect(
      page.getByRole('menuitem', { name: 'Open Post' })
    ).toBeVisible();
    // Creator auto-follows on creation → the toggle reads Unfollow.
    await page.getByRole('menuitem', { name: 'Unfollow Post' }).click();
    await expect(toast(page, 'Unfollowed post')).toBeVisible({
      timeout: 15_000
    });

    await card.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Follow Post' }).click();
    await expect(toast(page, 'Following post')).toBeVisible({
      timeout: 15_000
    });

    // Delete the post (creator/MANAGE_CHANNELS) with confirm.
    await card.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete Post' }).click();
    await expect(
      page.getByText('permanently remove the post', { exact: false })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(toast(page, 'Post deleted')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('No posts yet')).toBeVisible({
      timeout: 15_000
    });

    const forumId = psql(
      'core',
      `SELECT id FROM channels WHERE name = '${FORUM_NAME}'`
    );
    expect(
      psql(
        'core',
        `SELECT count(*) FROM channels WHERE parent_channel_id = ${forumId}`
      )
    ).toBe('0');
  });
});
