import { expect, test, type Page } from '@playwright/test';
import { psql } from '../../helpers/db';
import { authedPage, CORE_OWNER, CORE_USER_B, RUN_TAG } from '../../helpers/fixtures';
import { openServerSettings, toast } from '../../helpers/ui';

/**
 * A rename and a new description reach every member live. The owner
 * saves Server Settings → General while two other sessions of a member
 * are open — one on the community (sidebar header, deck tab when the
 * deck layout is on), one on Discover (the community's card) — and both
 * show the new values without a reload.
 *
 * The new name keeps "Pulse Server" as its prefix: the shared helpers
 * find the server by that text, and the specs after this one must still
 * find it. The original name and description are put back at the end,
 * straight into the database.
 */

const BASE = 'http://127.0.0.1:14991';

/**
 * Open Discover from wherever the layout puts it: the rail's compass in
 * the classic layout, the "Open a community" menu in the deck layout.
 */
async function openDiscover(page: Page): Promise<void> {
  const railButton = page
    .locator('button[title="Discover Servers"]')
    .filter({ visible: true })
    .first();
  if (await railButton.isVisible()) {
    await railButton.click();
    return;
  }
  await page.getByRole('button', { name: 'Open a community' }).click();
  await page.getByRole('menuitem', { name: 'Discover communities' }).click();
}

test('server rename + description reach a second member without reload', async ({
  browser
}) => {
  test.setTimeout(150_000);

  const newName = `Pulse Server ${RUN_TAG}`;
  const newDescription = `Evening raids and chatter ${RUN_TAG}`;
  const [originalName, originalDescription] = psql(
    'core',
    `SELECT name || E'\\t' || coalesce(description, '') FROM servers WHERE id = 1`
  ).split('\t');

  const owner = await authedPage(browser, BASE, CORE_OWNER);
  // Two fresh sessions for the member (per-context API login — refresh
  // tokens are one-time-use, so two pages in one context would race).
  const memberHome = await authedPage(browser, BASE, CORE_USER_B);
  const memberDiscover = await authedPage(browser, BASE, CORE_USER_B);
  try {
    // Member session 1 sits on the community: the sidebar header names it.
    const header = memberHome.page
      .locator('aside')
      .getByRole('heading', { level: 2 })
      .filter({ hasText: 'Pulse Server' })
      .first();
    await expect(header).toBeVisible();

    // Member session 2 sits on Discover, Local section, with the card
    // already rendered — anything that shows up later arrived live.
    await openDiscover(memberDiscover.page);
    const cardTitle = memberDiscover.page
      .getByRole('heading', { level: 3 })
      .filter({ hasText: 'Pulse Server' })
      .first();
    await expect(cardTitle).toBeVisible({ timeout: 20_000 });
    await expect(memberDiscover.page.getByText(newDescription)).toHaveCount(0);

    // Owner: rename + describe, save.
    await openServerSettings(owner.page, 'General');
    const nameInput = owner.page.getByPlaceholder('Enter server name');
    await expect(nameInput).toBeVisible();
    await nameInput.fill(newName);
    await owner.page.getByPlaceholder('Enter server description').fill(newDescription);
    await owner.page.getByRole('button', { name: 'Save Changes' }).first().click();
    await expect(toast(owner.page, 'Settings updated')).toBeVisible();

    // Member session 1: the header renames live; so does the deck tab
    // when the deck layout is on (its accessible name is the label).
    await expect(header).toHaveText(newName, { timeout: 15_000 });
    const tab = memberHome.page.getByRole('tab', { name: newName });
    if ((await tab.count()) > 0) {
      await expect(tab).toBeVisible();
      await expect(tab).toHaveAttribute('title', `${newName}\n${newDescription}`);
    }

    // Member session 2: the Discover card carries both, no navigation.
    await expect(
      memberDiscover.page
        .getByRole('heading', { level: 3 })
        .filter({ hasText: newName })
        .first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(memberDiscover.page.getByText(newDescription)).toBeVisible();

    // The owner's own sidebar header followed too.
    await owner.page.keyboard.press('Escape');
    await expect(
      owner.page
        .locator('aside')
        .getByRole('heading', { level: 2 })
        .filter({ hasText: newName })
        .first()
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    psql(
      'core',
      `UPDATE servers SET name = $q$${originalName}$q$, description = $q$${originalDescription}$q$ WHERE id = 1`
    );
    await owner.context.close();
    await memberHome.context.close();
    await memberDiscover.context.close();
  }
});
