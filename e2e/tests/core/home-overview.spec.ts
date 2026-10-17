import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page
} from '@playwright/test';
import { psql } from '../../helpers/db';
import { authedPage, CORE_OWNER, CORE_USER_B } from '../../helpers/fixtures';
import {
  dmComposer,
  goHome,
  openDmViaAuthor,
  selectChannel,
  sendChannelMessage,
  toast
} from '../../helpers/ui';

/**
 * The Home overview of the tab layout: a DM from user B lands under
 * Conversations with its unread badge and opens the Messages panel on
 * that conversation; the community row carries the unread count after
 * a channel message; a scheduled event appears under Upcoming events.
 *
 * Desktop only (the `core` project): the overview is the tab layout's
 * Home, which phones never get.
 */

const BASE = 'http://127.0.0.1:14991';
const TAG = Date.now().toString(36);
const EVENT_TITLE = `Home raid ${TAG}`;

let ownerCtx: BrowserContext;
let ownerPage: Page;
let userCtx: BrowserContext;
let userPage: Page;

/** A section of the overview by its heading. */
function section(page: Page, name: string): Locator {
  return page.getByRole('region', { name });
}

test.describe('home overview', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    ({ context: ownerCtx, page: ownerPage } = await authedPage(
      browser,
      BASE,
      CORE_OWNER
    ));
    ({ context: userCtx, page: userPage } = await authedPage(
      browser,
      BASE,
      CORE_USER_B
    ));
  });

  test.afterAll(async () => {
    // The event must not linger in the shared instance's planner.
    psql(
      'core',
      `UPDATE events SET status = 'cancelled' WHERE title = '${EVENT_TITLE}'`
    );
    await ownerCtx?.close();
    await userCtx?.close();
  });

  test('a DM from user B appears under Conversations with its unread badge', async () => {
    // The owner's author popover is B's way into a DM with them.
    await selectChannel(ownerPage, 'General Text');
    await sendChannelMessage(ownerPage, `home hello ${TAG}`);
    await goHome(ownerPage);

    await selectChannel(userPage, 'General Text');
    await expect(
      userPage.getByText(`home hello ${TAG}`, { exact: true })
    ).toBeVisible({ timeout: 15_000 });
    // The popover's inline composer sends and lands in the new DM.
    const popoverComposer = await openDmViaAuthor(userPage, CORE_OWNER.displayName);
    await popoverComposer.fill(`home dm ${TAG}`);
    await userPage.keyboard.press('Enter');
    await expect(
      userPage.locator('[id^="dm-msg-"]').getByText(`home dm ${TAG}`, { exact: true })
    ).toBeVisible({ timeout: 15_000 });

    const conversations = section(ownerPage, 'Conversations');
    const row = conversations
      .getByRole('button')
      .filter({ hasText: CORE_USER_B.displayName })
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText(`home dm ${TAG}`)).toBeVisible();
    await expect(row.getByText(/\d+ unread/)).toBeVisible();
  });

  test('clicking the conversation opens the Messages panel on it', async () => {
    await section(ownerPage, 'Conversations')
      .getByRole('button')
      .filter({ hasText: CORE_USER_B.displayName })
      .first()
      .click();

    const panel = ownerPage.getByRole('complementary', { name: 'Messages' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(`home dm ${TAG}`, { exact: true })).toBeVisible({
      timeout: 15_000
    });
    await expect(dmComposer(ownerPage)).toBeVisible();
    // The overview stays on screen beneath the panel.
    await expect(section(ownerPage, 'Conversations')).toBeVisible();
    await ownerPage.getByRole('button', { name: 'Close panel' }).click();
  });

  test('the community row shows the unread count after a channel message', async () => {
    // A channel the owner is not reading: General Text is their selected one.
    // B may be on Home: the channel list only shows with the community tab active.
    await userPage.getByRole('tab', { name: /^Pulse Server/ }).click();
    await selectChannel(userPage, 'General Text 2');
    await sendChannelMessage(userPage, `home unread ${TAG}`);

    const communities = section(ownerPage, 'Your communities');
    const row = communities
      .getByRole('button')
      .filter({ hasText: 'Pulse Server' })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByText(/\d+ unread/)).toBeVisible({ timeout: 15_000 });
  });

  test('a scheduled event appears under Upcoming events', async () => {
    // Created from the planner (the editor defaults to an hour from now).
    await ownerPage.getByRole('tab', { name: /^Pulse Server/ }).click();
    await ownerPage.getByRole('button', { name: 'Raid Planner' }).click();
    await ownerPage.getByRole('button', { name: 'New event' }).click();
    const sheet = ownerPage
      .getByRole('dialog')
      .or(ownerPage.getByRole('complementary', { name: 'Event' }))
      .first();
    await sheet.getByPlaceholder('Raid night').fill(EVENT_TITLE);
    await sheet.getByRole('button', { name: 'Create event' }).click();
    await expect(toast(ownerPage, 'Event created')).toBeVisible({ timeout: 15_000 });

    await goHome(ownerPage);
    const upcoming = section(ownerPage, 'Upcoming events');
    const row = upcoming.getByRole('button').filter({ hasText: EVENT_TITLE }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText('Pulse Server')).toBeVisible();
    await expect(row.getByText(/^in \d+ (min|h)/)).toBeVisible();

    // Open lands on the community with the event sheet up.
    await row.click();
    await expect(sheet.getByRole('heading', { name: EVENT_TITLE })).toBeVisible({
      timeout: 15_000
    });
  });
});
