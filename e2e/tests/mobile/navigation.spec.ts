import { expect, test, type Locator, type Page } from '@playwright/test';
import { CORE_OWNER, CORE_USER_B, RUN_TAG } from '../../helpers/fixtures';
import {
  authedGoto,
  channelButton,
  channelComposer,
  dmComposer,
  openDmViaAuthor,
  selectChannel
} from '../../helpers/ui';

/**
 * Mobile viewport (Pixel 7, 412×915 < MOBILE_BREAKPOINT 768): the app
 * shell at phone width. The server rail is hidden (< 480px), so Home and
 * settings go through the bottom nav; channels and DMs live in the
 * left drawer behind the header's hamburger (`title="Open channels"`,
 * components/mobile-header); members in the right drawer.
 */

const BASE = 'http://127.0.0.1:14991';

function hamburger(page: Page): Locator {
  return page.locator('button[title="Open channels"]').filter({ visible: true }).first();
}

/** The mobile header's members-drawer toggle (right side, users icon). */
function membersButton(page: Page): Locator {
  return page
    .locator('.md\\:hidden button:has(svg.lucide-users)')
    .filter({ visible: true })
    .first();
}

/** The left drawer (channel list or home sidebar). */
function leftDrawer(page: Page): Locator {
  return page.locator('aside.fixed').first();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await authedGoto(page, BASE, CORE_OWNER.email, CORE_OWNER.password);
});

test('the shell fits the viewport and the hamburger opens the channel drawer', async ({
  page
}) => {
  await expectNoHorizontalOverflow(page);

  // Drawer parked off-screen: the channel rows exist but are not in view.
  const general = channelButton(page, 'General Text 2');
  await expect(general).not.toBeInViewport();

  await hamburger(page).click();
  await expect(general).toBeInViewport();
  await expect(leftDrawer(page)).toBeInViewport();
  await expectNoHorizontalOverflow(page);
});

test('selecting a channel closes the drawer; the Send button posts the message', async ({
  page
}) => {
  await hamburger(page).click();
  await selectChannel(page, 'General Text 2');

  // Auto-close on channel change; the composer is usable.
  await expect(channelButton(page, 'General Text 2')).not.toBeInViewport();
  const composer = channelComposer(page);
  await expect(composer).toBeVisible();

  const text = `mobile ${RUN_TAG}`;
  await composer.click();
  await composer.fill(text);
  // On-screen send affordance instead of a hardware Enter.
  await page.locator('button:has(svg.lucide-send)').filter({ visible: true }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible({
    timeout: 15_000
  });
  await expectNoHorizontalOverflow(page);
});

test('the members drawer opens from the header', async ({ page }) => {
  // The default channel is already selected; no left drawer involved.
  const ownRow = page
    .locator('aside')
    .locator('div.group')
    .filter({ has: page.getByText(CORE_OWNER.displayName, { exact: true }) })
    .first();
  await expect(ownRow).not.toBeInViewport();

  await membersButton(page).click();
  await expect(ownRow).toBeInViewport({ timeout: 10_000 });
  await expectNoHorizontalOverflow(page);
});

test('Home → DM from the drawer works', async ({ page }) => {
  // A DM with B is not guaranteed to exist: open it from the member
  // list's profile popover (inline composer) so Home has a row to show.
  await membersButton(page).click();
  const inline = await openDmViaAuthor(page, CORE_USER_B.displayName);
  const seed = `mobile dm seed ${RUN_TAG}`;
  await inline.click();
  await inline.fill(seed);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /^Home/ }).click();
  await expect(page.getByText('Direct Messages').first()).toBeVisible({
    timeout: 15_000
  });

  await hamburger(page).click();
  await leftDrawer(page)
    .getByText(CORE_USER_B.displayName, { exact: true })
    .first()
    .click();
  const composer = dmComposer(page);
  await expect(composer).toBeVisible({ timeout: 15_000 });
  // Drawer auto-closed on selection; history is there.
  await expect(leftDrawer(page)).not.toBeInViewport();
  await expect(
    page.locator('[id^="dm-msg-"]').getByText(seed, { exact: true })
  ).toBeVisible({ timeout: 15_000 });

  const text = `mobile dm ${RUN_TAG}`;
  await composer.click();
  await composer.fill(text);
  await page.locator('button:has(svg.lucide-send)').filter({ visible: true }).click();
  await expect(
    page.locator('[id^="dm-msg-"]').getByText(text, { exact: true })
  ).toBeVisible({ timeout: 15_000 });
  await expectNoHorizontalOverflow(page);
});

test('settings open full-screen from the bottom nav and close', async ({
  page
}) => {
  await page.getByRole('button', { name: 'You' }).click();
  const heading = page.getByRole('heading', { name: 'Settings' });
  await expect(heading).toBeVisible();

  // The floating card covers the viewport minus its 1.5rem inset.
  const card = page.locator('div.fixed.inset-6');
  await expect(card).toBeVisible();
  const box = (await card.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.width).toBeGreaterThanOrEqual(viewport.width - 48 - 2);
  expect(box.height).toBeGreaterThanOrEqual(viewport.height - 48 - 2);
  // Mobile nav strip (sections as a horizontal tab row).
  await expect(
    page.getByRole('button', { name: 'Personalization', exact: true })
  ).toBeVisible();

  // The mobile back chevron closes it.
  await card.locator('button:has(svg.lucide-chevron-left)').first().click();
  await expect(heading).toHaveCount(0);
  // Back on the shell. The remembered channel on a lived-in instance may
  // be a voice channel (no composer), so assert the mobile header instead.
  await expect(page.getByRole('button', { name: 'Open channels' })).toBeVisible();
});
