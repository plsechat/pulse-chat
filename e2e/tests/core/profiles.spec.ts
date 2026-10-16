import { expect, test, type Locator, type Page } from '@playwright/test';
import { authedPage, CORE_OWNER, RUN_TAG } from '../../helpers/fixtures';
import {
  memberList,
  openMemberList,
  openUserSettings,
  selectChannel,
  sendChannelMessage,
  toast
} from '../../helpers/ui';

/**
 * Profiles editor cosmetics: an avatar decoration equips on click and a
 * drafted display-name style is saved with the form; both then render
 * live (no reload) wherever the user is the primary label — member
 * list, chat author line, profile popover (helpers/name-style.ts).
 *
 * Leaves the owner clean (decoration None, style reset) so the shared
 * fixture account looks the same for every other spec.
 */

const BASE = 'http://127.0.0.1:14991';

/** The owner's member-list row (right sidebar), not a chat row. */
function ownMemberRow(page: Page): Locator {
  return memberList(page)
    .locator('div.group')
    .filter({ has: page.getByText(CORE_OWNER.displayName, { exact: true }) })
    .first();
}

test('decoration and name style equip and render on member list, chat and popover', async ({
  browser
}) => {
  test.setTimeout(120_000);
  const { context, page } = await authedPage(browser, BASE, CORE_OWNER);
  try {
    await selectChannel(page, 'General Text');
    // An own message so the chat author line is on screen.
    const text = `style ${RUN_TAG}`;
    await sendChannelMessage(page, text);
    await openMemberList(page);

    await openUserSettings(page, 'Personalization');

    // --- Decoration: equips on click (mutation + USER_UPDATE fanout) ---
    const lurker = page.locator('button[title="Lurker"]').first();
    await lurker.scrollIntoViewIfNeeded();
    await lurker.click();
    await expect(lurker).toHaveClass(/ring-primary/, { timeout: 10_000 });
    // The preview card composes the layer from the served asset.
    await expect(
      page
        .locator('img[src*="/decorations/mists.png"]')
        .filter({ visible: true })
        .first()
    ).toBeVisible({ timeout: 10_000 });
    const asset = await page.request.get(`${BASE}/decorations/mists.png`);
    expect(asset.status()).toBe(200);
    expect(asset.headers()['content-type']).toContain('image/png');

    // --- Name style: drafted (Neon), persisted by the form's Save ---
    const neon = page.getByRole('button', { name: 'Neon', exact: true });
    await neon.scrollIntoViewIfNeeded();
    await neon.click();
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(toast(page, 'Profile updated')).toBeVisible({
      timeout: 15_000
    });
    await page.keyboard.press('Escape');

    // Member list: decoration layer on the avatar, styled name (neon
    // carries a text-shadow glow).
    const row = ownMemberRow(page);
    await expect(row.locator('img[src*="/decorations/mists.png"]')).toHaveCount(
      1,
      { timeout: 10_000 }
    );
    const rowName = row.locator('span.name-effect-neon');
    await expect(rowName).toHaveCount(1, { timeout: 10_000 });
    expect(
      await rowName.evaluate((el) => getComputedStyle(el).textShadow)
    ).not.toBe('none');

    // Chat author line: the group header of the message sent above.
    await expect(
      page
        .locator('.name-effect-neon')
        .filter({ hasText: CORE_OWNER.displayName })
    ).not.toHaveCount(0, { timeout: 10_000 });

    // Profile popover (home-style surface): click the styled author
    // name in chat. Not getByText(...).first(): the hidden mobile copy of
    // the user control carries the same text earlier in the DOM, and a
    // click on it would wait forever.
    await page
      .getByTestId('message-scroll')
      .locator('.name-effect-neon')
      .filter({ hasText: CORE_OWNER.displayName })
      .last()
      .click();
    const popover = page.locator('[data-slot="popover-content"]');
    await expect(popover).toBeVisible();
    await expect(popover.locator('.name-effect-neon')).toHaveCount(1);
    await expect(popover.locator('img[src*="/decorations/mists.png"]')).toHaveCount(
      1
    );
    await page.keyboard.press('Escape');

    // --- Cleanup: back to no decoration, no style ---
    await openUserSettings(page, 'Personalization');
    // The DECORATION picker's None tile (the nameplate picker has one too).
    const none = page.locator('button.flex-col[title="None"]').first();
    await none.scrollIntoViewIfNeeded();
    await none.click();
    await expect(none).toHaveClass(/ring-primary/, { timeout: 10_000 });
    await page.getByRole('button', { name: 'Reset to default' }).click();
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(toast(page, 'Profile updated')).toBeVisible({
      timeout: 15_000
    });
    await page.keyboard.press('Escape');
    await expect(row.locator('img[src*="/decorations/"]')).toHaveCount(0, {
      timeout: 10_000
    });
    await expect(row.locator('span.name-effect-neon')).toHaveCount(0, {
      timeout: 10_000
    });
  } finally {
    await context.close();
  }
});
