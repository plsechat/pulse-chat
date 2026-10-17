import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page
} from '@playwright/test';
import { authedPage, CORE_OWNER, CORE_USER_B } from '../../helpers/fixtures';
import { selectChannel, toast } from '../../helpers/ui';

/**
 * Raid Planner, end to end: the owner creates an event from a roster
 * template with an announcement, the RSVP card lands in the channel,
 * user B signs up as DPS from the card, the owner's event sheet shows
 * them under DPS, B withdraws, the owner cancels.
 *
 * Desktop only (the `core` project): the sheet is a side panel in the
 * tab layout (the default) and a dialog in the traditional one; the
 * spec accepts either.
 */

/** The open event sheet, whichever layout hosts it. */
function eventSheet(page: Page): Locator {
  return page
    .getByRole('dialog')
    .or(page.getByRole('complementary', { name: 'Event' }))
    .first();
}

const BASE = 'http://127.0.0.1:14991';
const TITLE = `Raid ${Date.now().toString(36)}`;

let ownerCtx: BrowserContext;
let ownerPage: Page;
let userCtx: BrowserContext;
let userPage: Page;

/** The RSVP card in the channel that announces TITLE. */
function rsvpCard(page: Page): Locator {
  return page
    .locator('.surface-soft')
    .filter({ has: page.getByRole('button', { name: TITLE, exact: true }) })
    .first();
}

test.describe('raid planner', () => {
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
    await ownerCtx?.close();
    await userCtx?.close();
  });

  test('owner creates an event from a template, announced in General Text', async () => {
    await ownerPage.getByRole('button', { name: 'Raid Planner' }).click();
    await expect(
      ownerPage.getByRole('heading', { name: 'Raid Planner' })
    ).toBeVisible();

    await ownerPage.getByRole('button', { name: 'New event' }).click();
    const dialog = eventSheet(ownerPage);
    await expect(dialog.getByText('New event')).toBeVisible();

    await dialog.getByPlaceholder('Raid night').fill(TITLE);

    // The seeded "Classic raid" template (Tank 2 / Healer 4 / DPS 14).
    await dialog.getByRole('combobox', { name: 'Roster template' }).click();
    await ownerPage.getByRole('option', { name: /^Classic raid/ }).click();
    await expect(dialog.getByText('DPS', { exact: true })).toBeVisible();

    await dialog.getByRole('combobox', { name: 'Announce channel' }).click();
    await ownerPage.getByRole('option', { name: '#General Text', exact: true }).click();

    await dialog.getByRole('button', { name: 'Create event' }).click();
    await expect(toast(ownerPage, 'Event created')).toBeVisible({
      timeout: 15_000
    });

    // The agenda lists it whatever the month boundary.
    await ownerPage.getByRole('button', { name: 'Agenda' }).click();
    await expect(
      ownerPage.getByRole('button', { name: TITLE, exact: true })
    ).toBeVisible();
  });

  test('the RSVP card appears in the announce channel', async () => {
    await selectChannel(ownerPage, 'General Text');
    const card = rsvpCard(ownerPage);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText('Scheduled')).toBeVisible();
    await expect(card.getByRole('button', { name: /^DPS\s*0\/14/ })).toBeVisible();
  });

  test('user B signs up as DPS from the card', async () => {
    await selectChannel(userPage, 'General Text');
    const card = rsvpCard(userPage);
    await expect(card).toBeVisible({ timeout: 15_000 });

    await card.getByRole('button', { name: /^DPS\s*0\/14/ }).click();
    await expect(card.getByRole('button', { name: /^DPS\s*1\/14\s*·\s*you/ })).toBeVisible({
      timeout: 15_000
    });
    await expect(card.getByRole('button', { name: 'Withdraw' })).toBeVisible();
  });

  test("the owner's sheet shows B under DPS", async () => {
    const card = rsvpCard(ownerPage);
    await card.getByRole('button', { name: 'Details' }).click();

    const sheet = eventSheet(ownerPage);
    await expect(sheet.getByRole('heading', { name: TITLE })).toBeVisible();
    const dpsColumn = sheet.locator('[aria-label^="DPS, "]');
    await expect(dpsColumn.getByText(CORE_USER_B.displayName)).toBeVisible({
      timeout: 15_000
    });
    // The host can bench them from here.
    await expect(
      dpsColumn.getByRole('button', { name: `Bench ${CORE_USER_B.displayName}` })
    ).toBeVisible();
  });

  test('B withdraws and the sheet updates live', async () => {
    const card = rsvpCard(userPage);
    await card.getByRole('button', { name: 'Withdraw' }).click();
    await expect(card.getByRole('button', { name: /^DPS\s*0\/14/ })).toBeVisible({
      timeout: 15_000
    });

    const sheet = eventSheet(ownerPage);
    await expect(
      sheet.locator('[aria-label^="DPS, "]').getByText(CORE_USER_B.displayName)
    ).toHaveCount(0, { timeout: 15_000 });
  });

  test('the owner cancels the event', async () => {
    const sheet = eventSheet(ownerPage);
    await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
    await ownerPage.getByRole('button', { name: 'Cancel event' }).click();
    await expect(toast(ownerPage, 'Event cancelled')).toBeVisible({
      timeout: 15_000
    });
    await expect(sheet.getByText('Cancelled', { exact: true })).toBeVisible({
      timeout: 15_000
    });

    // B's card follows: no more sign-up pills to press.
    const card = rsvpCard(userPage);
    await expect(card.getByText('Cancelled', { exact: true })).toBeVisible({
      timeout: 15_000
    });
    // A closed event's pills are plain labels, not buttons.
    await expect(card.getByRole('button', { name: /^DPS/ })).toHaveCount(0);
    await expect(card.getByText(/^DPS/)).toBeVisible();
  });
});
