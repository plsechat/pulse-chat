import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { authedPage, CORE_OWNER, CORE_USER_B, registerAndJoin } from '../../helpers/fixtures';
import { channelButton, channelComposer, selectChannel, toast } from '../../helpers/ui';

/**
 * Announcement channels, polls and scheduled posts in one pass:
 *   - the owner flags a fresh channel as an announcement channel
 *   - a plain member sees the "Only announcers can post here" bar
 *   - the owner creates a poll from the "+" menu and the member votes
 *   - the owner schedules a message, sees it in the Scheduled list and
 *     cancels it (the cron is not driven here — the row's presence and
 *     cancellation are the contract this spec can observe)
 *
 * Runs as the operator; userB joins in a second context.
 */

const BASE = 'http://127.0.0.1:14991';
const RUN = Date.now().toString(36);
const CHANNEL = `news-${RUN}`;
const QUESTION = `Raid night ${RUN}?`;

let ownerCtx: BrowserContext;
let ownerPage: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  ({ context: ownerCtx, page: ownerPage } = await authedPage(browser, BASE, CORE_OWNER));
});

test.afterAll(async () => {
  await ownerCtx.close();
});

test('owner flags a channel as an announcement channel', async () => {
  await ownerPage.locator('button[title="Create channel"]').first().click();
  await expect(ownerPage.getByRole('heading', { name: 'Create New Channel' })).toBeVisible();
  await ownerPage.getByPlaceholder('Channel name').fill(CHANNEL);
  await ownerPage.getByRole('button', { name: 'Create channel' }).click();
  await expect(channelButton(ownerPage, CHANNEL)).toBeVisible({ timeout: 15_000 });

  await selectChannel(ownerPage, CHANNEL);
  await ownerPage
    .getByRole('button', { name: CHANNEL, exact: true })
    .first()
    .click({ button: 'right', force: true });
  await ownerPage.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(ownerPage.getByRole('heading', { name: 'Channel Settings' })).toBeVisible();
  await ownerPage.getByRole('switch', { name: 'Announcement channel' }).click();
  await ownerPage.getByRole('button', { name: 'Save Changes' }).click();
  await expect(toast(ownerPage, 'Channel updated')).toBeVisible({ timeout: 15_000 });
  await ownerPage.keyboard.press('Escape');

  // The row carries the megaphone tile.
  await expect(
    channelButton(ownerPage, CHANNEL).locator('[aria-label="Announcement channel"]')
  ).toBeVisible();
});

test('a member cannot post; the owner creates a poll and the member votes', async ({ browser }) => {
  await registerAndJoin(browser, BASE, CORE_USER_B);
  const { context: bCtx, page: bPage } = await authedPage(browser, BASE, CORE_USER_B);

  try {
    await selectChannel(bPage, CHANNEL);
    await expect(bPage.getByTestId('announcement-locked')).toBeVisible();
    await expect(bPage.getByTestId('announcement-locked')).toContainText('Only announcers can post here');
    await expect(channelComposer(bPage)).toHaveCount(0);

    // Owner: "+" → Create poll.
    await selectChannel(ownerPage, CHANNEL);
    await ownerPage.getByRole('button', { name: 'Add to message' }).click();
    await ownerPage.getByRole('menuitem', { name: 'Create poll' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Create poll' })).toBeVisible();
    await ownerPage.getByLabel('Poll question').fill(QUESTION);
    await ownerPage.getByRole('textbox', { name: 'Option 1', exact: true }).fill('Friday');
    await ownerPage.getByRole('textbox', { name: 'Option 2', exact: true }).fill('Saturday');
    await ownerPage.getByRole('button', { name: 'Create poll' }).click();

    const ownerCard = ownerPage.getByRole('group', { name: `Poll: ${QUESTION}` });
    await expect(ownerCard).toBeVisible({ timeout: 15_000 });
    // Exact: each option also carries an sr-only ", 0 votes" suffix.
    await expect(ownerCard.getByText('0 votes', { exact: true })).toBeVisible();

    // Member votes; the owner's card follows live.
    const memberCard = bPage.getByRole('group', { name: `Poll: ${QUESTION}` });
    await expect(memberCard).toBeVisible({ timeout: 15_000 });
    await memberCard.getByRole('radio', { name: /Friday/ }).click();
    await expect(memberCard.getByRole('radio', { name: /Friday/ })).toHaveAttribute('aria-checked', 'true');
    await expect(memberCard.getByText('1 vote', { exact: true })).toBeVisible();
    await expect(ownerCard.getByText('1 vote', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(ownerCard.getByRole('radio', { name: /Friday/ })).toContainText('100%');

    // Switching the vote moves it, it does not add one.
    await memberCard.getByRole('radio', { name: /Saturday/ }).click();
    await expect(memberCard.getByRole('radio', { name: /Saturday/ })).toHaveAttribute('aria-checked', 'true');
    await expect(memberCard.getByText('1 vote', { exact: true })).toBeVisible();

    // The owner closes it; the member can no longer vote.
    await ownerCard.getByRole('button', { name: 'Close poll' }).click();
    await expect(ownerCard.getByText('Closed')).toBeVisible();
    await expect(memberCard.getByText('Closed')).toBeVisible({ timeout: 15_000 });
    await expect(memberCard.getByRole('radio', { name: /Friday/ })).toBeDisabled();
  } finally {
    await bCtx.close();
  }
});

test('owner schedules a message, sees it in the Scheduled list and cancels it', async () => {
  await selectChannel(ownerPage, CHANNEL);
  const composer = channelComposer(ownerPage);
  await composer.click();
  await composer.fill(`scheduled ${RUN}`);

  await ownerPage.getByRole('button', { name: 'Add to message' }).click();
  // The item is disabled until the draft state has caught up with the
  // fill; clicking it disabled just closes the menu.
  const scheduleItem = ownerPage.getByRole('menuitem', { name: 'Schedule message' });
  await expect(scheduleItem).toBeEnabled();
  await scheduleItem.click();
  await expect(ownerPage.getByRole('heading', { name: 'Schedule message' })).toBeVisible();
  // The picker opens on the next quarter hour (≥ 5 min out): valid as is.
  await ownerPage.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(toast(ownerPage, /Scheduled for/)).toBeVisible({ timeout: 15_000 });

  // The draft is cleared, not sent.
  await expect(ownerPage.getByText(`scheduled ${RUN}`, { exact: true })).toHaveCount(0);

  await ownerPage.getByRole('button', { name: 'Scheduled messages' }).click();
  const list = ownerPage.getByRole('list', { name: 'Scheduled messages' });
  await expect(list).toBeVisible();
  await expect(list.getByText(`scheduled ${RUN}`)).toBeVisible();

  await list.getByRole('button', { name: /Cancel scheduled message/ }).click();
  await ownerPage.getByRole('button', { name: 'Cancel message' }).click();
  await expect(toast(ownerPage, 'Scheduled message cancelled')).toBeVisible({ timeout: 15_000 });
  await expect(list.getByText(`scheduled ${RUN}`)).toHaveCount(0);
  await ownerPage.keyboard.press('Escape');
});
