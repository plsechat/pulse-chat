import { expect, test, type Locator, type Page } from '@playwright/test';
import { CORE_OWNER, RUN_TAG } from '../../helpers/fixtures';
import {
  authedGoto,
  channelComposer,
  expectNoClippedControls,
  messageRow,
  selectChannel
} from '../../helpers/ui';

/**
 * Phone (Pixel 7, coarse pointer, no hover): the per-message action
 * toolbar. Finding #22: it used to render on EVERY row (the hover reveal
 * fell back to "always" without hover) and floated over the text of the
 * row above. Now a tap on a row opens its toolbar alone, in flow below
 * the message; a tap on another row moves it; a tap on the same row
 * closes it (components/channel-view/text/active-message-store).
 *
 * The toolbar carries `data-testid="message-actions"`; on touch an
 * inactive row's toolbar is display:none, so a visibility filter counts
 * open toolbars.
 */

const BASE = 'http://127.0.0.1:14991';

function hamburger(page: Page): Locator {
  return page.locator('button[title="Open channels"]').filter({ visible: true }).first();
}

function sendButton(page: Page): Locator {
  return page.locator('button:has(svg.lucide-send)').filter({ visible: true });
}

function openToolbars(page: Page): Locator {
  return page.getByTestId('message-actions').filter({ visible: true });
}

/** Post through the on-screen Send (Enter inserts a newline on a coarse pointer). */
async function post(page: Page, text: string): Promise<Locator> {
  const composer = channelComposer(page);
  await composer.click();
  await composer.fill(text);
  await sendButton(page).click();
  const row = messageRow(page, text);
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

test.beforeEach(async ({ page }) => {
  await authedGoto(page, BASE, CORE_OWNER.email, CORE_OWNER.password);
  await hamburger(page).click();
  await selectChannel(page, 'General Text');
  await expect(channelComposer(page)).toBeVisible();
});

test('a tap opens exactly one toolbar, below the text; another tap moves it; the same tap closes it', async ({
  page
}) => {
  const first = `tap one ${RUN_TAG}`;
  const second = `tap two ${RUN_TAG}`;
  const rowA = await post(page, first);
  const rowB = await post(page, second);

  // Nothing is open until a tap.
  await expect(openToolbars(page)).toHaveCount(0);

  const textA = rowA.getByText(first, { exact: true });
  await textA.tap();
  await expect(openToolbars(page)).toHaveCount(1);
  const barA = rowA.getByTestId('message-actions');
  await expect(barA).toBeVisible();
  // The smile button lives in the row's own toolbar (messaging.spec relies on it).
  await expect(barA.locator('button:has(svg.lucide-smile)')).toBeVisible();

  // In flow under the message: the toolbar box never covers the text.
  const barBox = (await barA.boundingBox())!;
  const textBox = (await textA.boundingBox())!;
  expect(barBox.y).toBeGreaterThanOrEqual(textBox.y + textBox.height - 1);
  await expectNoClippedControls(rowA);

  // A tap on another row moves the toolbar there.
  const textB = rowB.getByText(second, { exact: true });
  await textB.tap();
  await expect(openToolbars(page)).toHaveCount(1);
  await expect(rowB.getByTestId('message-actions')).toBeVisible();
  await expect(barA).toBeHidden();

  // The same row again closes it.
  await textB.tap();
  await expect(openToolbars(page)).toHaveCount(0);
});

test('a tap on the composer (elsewhere) closes the open toolbar', async ({ page }) => {
  const text = `tap away ${RUN_TAG}`;
  const row = await post(page, text);
  await row.getByText(text, { exact: true }).tap();
  await expect(openToolbars(page)).toHaveCount(1);

  await channelComposer(page).tap();
  await expect(openToolbars(page)).toHaveCount(0);
});
