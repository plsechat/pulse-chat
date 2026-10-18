import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { authedPage, CORE_OWNER } from '../../helpers/fixtures';
import { openServerSettings, selectChannel, toast, visibleComposer } from '../../helpers/ui';

/**
 * The command palette (Tier 3): with the official watch-together plugin
 * on and plugin commands allowed in the community, typing `/` lists the
 * commands, `/watch ` lists its sub-commands, the arrow keys and Enter
 * insert one, the usage hint above the composer follows the arguments,
 * Escape closes it, and `/watch pause` + Enter sends without a
 * suggestion swallowing the Enter (the command line shows "used /watch
 * pause" with the plugin's failed reply, since nothing plays). The
 * plugin goes back to the state it was found in.
 */

const BASE = 'http://127.0.0.1:14991';
const TEXT_CHANNEL = 'General Text';
const PLUGIN_ID = 'watch-together';

function palette(page: Page): Locator {
  return page.locator('[data-testid="command-palette"]');
}

function paletteOptions(page: Page): Locator {
  return palette(page).getByRole('option');
}

function hint(page: Page): Locator {
  return page.locator('[data-testid="command-hint"]');
}

/** The plugin's row in Instance → Plugins: the innermost box holding its name and its switch. */
function pluginRow(page: Page): Locator {
  return page
    .locator('div')
    .filter({ has: page.getByRole('heading', { name: PLUGIN_ID, exact: true }) })
    .filter({ has: page.getByRole('switch') })
    .last();
}

/** What the composer holds, as plain text. */
async function composerText(page: Page): Promise<string> {
  return (await visibleComposer(page).innerText()).replace(/ /g, ' ');
}

async function clearComposer(page: Page): Promise<void> {
  const composer = visibleComposer(page);
  await composer.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await expect(composer).toHaveText('');
}

let ctx: BrowserContext;
let page: Page;

test.describe('command palette', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    ({ context: ctx, page } = await authedPage(browser, BASE, CORE_OWNER));
  });

  test.afterAll(async () => {
    await ctx?.close();
  });

  test('/ lists commands, /watch lists its verbs, arrows insert, the hint follows, Enter sends', async () => {
    test.setTimeout(180_000);
    let pluginWasEnabled = true;

    try {
      // Instance → Plugins: switch the plugin on (remember how it was).
      await openServerSettings(page, 'Plugins');
      const row = pluginRow(page);
      await expect(row).toBeVisible({ timeout: 15_000 });
      const toggle = row.getByRole('switch');
      pluginWasEnabled = (await toggle.getAttribute('aria-checked')) === 'true';
      if (!pluginWasEnabled) {
        await toggle.click();
        await expect(row.getByText('Enabled', { exact: true })).toBeVisible({ timeout: 15_000 });
      }
      await page.keyboard.press('Escape');

      // Server Settings → General: let members run plugin commands.
      await openServerSettings(page, 'General');
      const pluginsSwitch = page
        .getByText('Let members run commands from the plugins')
        .locator('xpath=ancestor::div[2]')
        .getByRole('switch');
      await expect(pluginsSwitch).toBeVisible({ timeout: 15_000 });
      if ((await pluginsSwitch.getAttribute('aria-checked')) !== 'true') {
        await pluginsSwitch.click();
        await page.getByRole('button', { name: 'Save Changes' }).click();
        await expect(toast(page, 'Settings updated')).toBeVisible({ timeout: 10_000 });
      }
      await page.keyboard.press('Escape');

      await selectChannel(page, TEXT_CHANNEL);
      const composer = visibleComposer(page);
      await composer.click();

      // Level one: the commands, with the header line and the signature.
      await page.keyboard.type('/');
      await expect(palette(page)).toBeVisible({ timeout: 15_000 });
      await expect(palette(page)).toHaveAttribute('data-level', 'commands');
      await expect(palette(page)).toContainText('Commands');
      const watchRow = paletteOptions(page).filter({ hasText: '/watch' });
      await expect(watchRow).toHaveCount(1);
      await expect(watchRow).toContainText('/watch play | pause | seek | stop | status');
      await expect(palette(page).getByRole('listbox')).toHaveAttribute('aria-activedescendant', /command-option-/);

      // Level two: the name and a space list the verbs.
      await page.keyboard.type('watch ');
      await expect(palette(page)).toHaveAttribute('data-level', 'subcommands', { timeout: 10_000 });
      await expect(paletteOptions(page)).toHaveText([/^play/, /^pause/, /^seek/, /^stop/, /^status/]);
      await expect(paletteOptions(page).nth(0)).toHaveAttribute('aria-selected', 'true');
      // The hint names the verbs while one is still to be picked.
      await expect(hint(page)).toContainText('/watch');
      await expect(hint(page).locator('[data-active]')).toHaveText('play | pause | seek | stop | status');

      // ArrowDown three times lands on stop; Enter inserts "/watch stop ".
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await expect(paletteOptions(page).nth(3)).toHaveAttribute('aria-selected', 'true');
      await expect(palette(page).getByRole('status')).toContainText('/watch stop');
      await page.keyboard.press('Enter');
      await expect.poll(() => composerText(page)).toBe('/watch stop ');
      // A verb without arguments: nothing more to offer, the hint reads it out.
      await expect(palette(page)).toHaveCount(0);
      await expect(hint(page)).toContainText('/watch stop');
      await expect(hint(page)).toContainText('End the watch');

      // Arguments: /watch seek shows <seconds> marked while it is typed.
      await clearComposer(page);
      await page.keyboard.type('/watch seek ');
      await expect(palette(page)).toHaveCount(0);
      await expect(hint(page)).toContainText('/watch seek');
      await expect(hint(page).locator('[data-active]')).toHaveText('<90>');
      await expect(hint(page)).toContainText('Jump everyone to a position');
      await page.keyboard.type('4');
      await expect(hint(page).locator('[data-active]')).toHaveText('<90>');

      // Escape closes the hint; typing on brings it back.
      await page.keyboard.press('Escape');
      await expect(hint(page)).toHaveCount(0);
      await expect(composer).toBeFocused();
      await page.keyboard.type('5');
      await expect(hint(page)).toBeVisible();
      await expect.poll(() => composerText(page)).toBe('/watch seek 45');

      // Escape with the list open closes the list (and the hint).
      await clearComposer(page);
      await page.keyboard.type('/watch ');
      await expect(palette(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(palette(page)).toHaveCount(0);
      await expect(hint(page)).toHaveCount(0);
      await expect.poll(() => composerText(page)).toBe('/watch ');

      // A partial verb filters; Tab completes it.
      await page.keyboard.type('pa');
      await expect(paletteOptions(page)).toHaveText([/^pause/]);
      await page.keyboard.press('Tab');
      await expect.poll(() => composerText(page)).toBe('/watch pause ');
      await expect(palette(page)).toHaveCount(0);

      // "/watch pause" + Enter sends: no suggestion swallows the Enter.
      await clearComposer(page);
      await page.keyboard.type('/watch pause');
      await expect(palette(page)).toHaveCount(0);
      await expect(hint(page)).toContainText('Pause for everyone');
      await page.keyboard.press('Enter');
      await expect(composer).toHaveText('', { timeout: 10_000 });
      const line = page.locator('[data-testid="command-line"]').last();
      await expect(line).toBeVisible({ timeout: 15_000 });
      await expect(line).toContainText('used /watch pause');
      // The command ran (the plugin answers at once). On a quiet channel
      // nothing plays, so the refusal is the reply, inline and red; on a
      // lived-in stack another spec's card may be live and the pause
      // simply lands.
      await expect(line).toHaveAttribute('data-status', /completed|failed/, { timeout: 15_000 });
      if ((await line.getAttribute('data-status')) === 'failed') {
        await expect(line.getByRole('alert')).toContainText('Nothing is playing in this channel.');
      }
    } finally {
      await page.keyboard.press('Escape');
      // Leave the plugin as it was found.
      if (!pluginWasEnabled) {
        await openServerSettings(page, 'Plugins');
        const row = pluginRow(page);
        if (await row.isVisible().catch(() => false)) {
          const toggle = row.getByRole('switch');
          if ((await toggle.getAttribute('aria-checked')) === 'true') await toggle.click();
        }
        await page.keyboard.press('Escape');
      }
    }
  });
});
