import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page
} from '@playwright/test';
import { psql } from '../../helpers/db';
import { authedPage, CORE_OWNER, CORE_USER_B } from '../../helpers/fixtures';
import { channelComposer, openServerSettings, selectChannel, toast } from '../../helpers/ui';

/**
 * Watch together from a TEXT channel (Tier 3): the owner switches the
 * official watch-together plugin on (address checking off, so the
 * server never reaches the network), allows plugin commands in the
 * community, and types `/watch <YouTube link>` into General Text. The
 * plugin posts a watch card; userB sees it, presses Watch and gets the
 * synced player (a side panel in the tab layout, a dialog in the
 * traditional one); the owner pauses from the composer and userB's
 * card reads Paused. `/watch stop` ends it in `finally`, and the
 * plugin goes back to the state it was found in.
 *
 * The YouTube player itself needs the site: where the runner has no
 * network the player reports that it could not be loaded, which the
 * spec accepts next to the iframe — the card, the panel and the
 * fan-out are what is under test.
 */

const BASE = 'http://127.0.0.1:14991';
const TEXT_CHANNEL = 'General Text';
const PLUGIN_ID = 'watch-together';
const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

/** The card the plugin posted (the newest one in the pane). */
function watchCard(page: Page): Locator {
  return page.locator('[data-testid="watch-card"]').last();
}

/** The open player, whichever layout hosts it. */
function watchPanel(page: Page): Locator {
  return page
    .getByRole('complementary', { name: 'Watch together' })
    .or(page.getByRole('dialog'))
    .locator('[data-testid="watch-panel"]')
    .first();
}

/** The plugin's row in Instance → Plugins: the innermost box holding its name and its switch. */
function pluginRow(page: Page): Locator {
  return page
    .locator('div')
    .filter({ has: page.getByRole('heading', { name: PLUGIN_ID, exact: true }) })
    .filter({ has: page.getByRole('switch') })
    .last();
}

async function typeCommand(page: Page, text: string): Promise<void> {
  // A command renders as a card, not as its text, so the shared helper's
  // round-trip wait does not apply. The send is proven by the editor
  // emptying; a send that did not land is retried once.
  const editor = page.locator('[contenteditable="true"]').first();
  for (let attempt = 0; attempt < 2; attempt++) {
    await editor.click();
    await editor.fill(text);
    await expect(editor).toContainText(text);
    await page.keyboard.press('Enter');
    try {
      await expect(editor).toHaveText('', { timeout: 5_000 });
      return;
    } catch {
      // Not sent: the composer still holds the text; try once more.
    }
  }
  throw new Error(`The composer did not send "${text}"`);
}

let ctxA: BrowserContext;
let ctxB: BrowserContext;
let pageA: Page;
let pageB: Page;

test.describe('watch card', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    // The viewer reports presence through the plugin's own command, so
    // userB needs Execute plugin commands (a plain member has not got it).
    // Idempotent on a long-lived stack: the role is reused if it exists.
    psql(
      'core',
      `INSERT INTO roles (name, color, is_persistent, is_default, server_id, position, created_at)
       SELECT 'e2e-watchers', '#ffffff', false, false, 1, 0, (extract(epoch from now()) * 1000)::bigint
       WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'e2e-watchers' AND server_id = 1)`
    );
    psql(
      'core',
      `INSERT INTO role_permissions (role_id, permission, created_at)
       SELECT r.id, 'EXECUTE_PLUGIN_COMMANDS', (extract(epoch from now()) * 1000)::bigint FROM roles r
       WHERE r.name = 'e2e-watchers' AND r.server_id = 1
         AND NOT EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.permission = 'EXECUTE_PLUGIN_COMMANDS')`
    );
    psql(
      'core',
      `INSERT INTO user_roles (user_id, role_id, created_at)
       SELECT u.id, r.id, (extract(epoch from now()) * 1000)::bigint FROM users u, roles r
       WHERE u.name = '${CORE_USER_B.displayName}' AND r.name = 'e2e-watchers' AND r.server_id = 1
         AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = r.id)`
    );
    ({ context: ctxA, page: pageA } = await authedPage(browser, BASE, CORE_OWNER));
    ({ context: ctxB, page: pageB } = await authedPage(browser, BASE, CORE_USER_B));
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('/watch in a text channel posts a card; the other member watches from it; a pause reaches their card', async () => {
    test.setTimeout(180_000);
    let pluginWasEnabled = true;

    try {
      // Instance → Plugins: switch the plugin on (remember how it was).
      await openServerSettings(pageA, 'Plugins');
      const row = pluginRow(pageA);
      await expect(row).toBeVisible({ timeout: 15_000 });
      const toggle = row.getByRole('switch');
      pluginWasEnabled = (await toggle.getAttribute('aria-checked')) === 'true';
      if (!pluginWasEnabled) {
        await toggle.click();
        await expect(row.getByText('Enabled', { exact: true })).toBeVisible({ timeout: 15_000 });
      }

      // Its settings: address checking off, so nothing is fetched.
      await row.getByRole('button', { name: 'Settings' }).click();
      const dialog = pageA.getByRole('dialog');
      await expect(dialog.getByText(`Settings for ${PLUGIN_ID}`)).toBeVisible({ timeout: 15_000 });
      await dialog.getByRole('button', { name: /Check addresses before playing/ }).click();
      const verify = dialog.locator('#setting-verifyUrls');
      await expect(verify).toBeVisible();
      if ((await verify.getAttribute('aria-checked')) === 'true') {
        await verify.click();
        await dialog.getByRole('button', { name: 'Save Changes' }).click();
        await expect(dialog.getByText('No unsaved changes')).toBeVisible({ timeout: 10_000 });
      }
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await pageA.keyboard.press('Escape');

      // Server Settings → General: let members run plugin commands.
      await openServerSettings(pageA, 'General');
      const pluginsSwitch = pageA
        .getByText('Let members run commands from the plugins')
        .locator('xpath=ancestor::div[2]')
        .getByRole('switch');
      await expect(pluginsSwitch).toBeVisible({ timeout: 15_000 });
      if ((await pluginsSwitch.getAttribute('aria-checked')) !== 'true') {
        await pluginsSwitch.click();
        await pageA.getByRole('button', { name: 'Save Changes' }).click();
        await expect(toast(pageA, 'Settings updated')).toBeVisible({ timeout: 10_000 });
      }
      await pageA.keyboard.press('Escape');

      // Both look at the text channel; the owner starts a watch there.
      await selectChannel(pageA, TEXT_CHANNEL);
      await selectChannel(pageB, TEXT_CHANNEL);
      await typeCommand(pageA, `/watch ${VIDEO}`);

      // The card arrives for both; it plays and names the owner.
      await expect(watchCard(pageA)).toBeVisible({ timeout: 20_000 });
      await expect(watchCard(pageB)).toBeVisible({ timeout: 20_000 });
      await expect(watchCard(pageB)).toHaveAttribute('data-status', 'playing');
      await expect(watchCard(pageB).locator('[data-testid="watch-card-status"]')).toContainText('Playing');
      await expect(watchCard(pageB)).toContainText(`Started by ${CORE_OWNER.displayName}`);
      // A YouTube card shows the video's poster from the known host.
      await expect(watchCard(pageB).locator('img[src*="i.ytimg.com/vi/dQw4w9WgXcQ"]')).toHaveCount(1);

      // userB presses Watch: the player opens with the YouTube embed (or
      // the player's own notice where the runner cannot reach the site).
      await watchCard(pageB).getByRole('button', { name: 'Watch', exact: true }).click();
      const panel = watchPanel(pageB);
      await expect(panel).toBeVisible({ timeout: 15_000 });
      const player = panel.locator('[data-testid="watch-together-player"]');
      await expect(player).toBeVisible();
      await expect(
        player
          .locator('iframe[src*="youtube-nocookie.com"]')
          .or(player.getByText(/could not be loaded|cannot be played here/))
      ).toBeVisible({ timeout: 30_000 });
      await expect(panel.locator('[data-testid="watch-panel-status"]')).toContainText('Playing');

      // The owner pauses from the composer: userB's card and panel follow.
      await typeCommand(pageA, '/watch pause');
      await expect(watchCard(pageB)).toHaveAttribute('data-status', 'paused', { timeout: 15_000 });
      await expect(watchCard(pageB).locator('[data-testid="watch-card-status"]')).toContainText('Paused');
      await expect(panel.locator('[data-testid="watch-panel-status"]')).toContainText('Paused');
      // The viewer's presence reached the card.
      await expect(watchCard(pageA)).toContainText('1 watching', { timeout: 15_000 });
    } finally {
      // End the session: the card reads Ended and its button disables.
      await pageA.keyboard.press('Escape');
      if (await channelComposer(pageA).isVisible().catch(() => false)) {
        await typeCommand(pageA, '/watch stop');
        await expect(watchCard(pageA)).toHaveAttribute('data-status', 'ended', { timeout: 15_000 });
        await expect(watchCard(pageA).getByRole('button', { name: 'Ended', exact: true })).toBeDisabled();
      }
      // Leave the plugin as it was found.
      if (!pluginWasEnabled) {
        await openServerSettings(pageA, 'Plugins');
        const row = pluginRow(pageA);
        if (await row.isVisible().catch(() => false)) {
          const toggle = row.getByRole('switch');
          if ((await toggle.getAttribute('aria-checked')) === 'true') await toggle.click();
        }
        await pageA.keyboard.press('Escape');
      }
    }
  });
});
