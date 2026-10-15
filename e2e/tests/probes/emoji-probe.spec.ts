import { expect, test, type Page } from '@playwright/test';
import { copyFileSync } from 'fs';
import { authedPage, CORE_OWNER } from '../../helpers/fixtures';

async function serverMenu(page: Page, item: string): Promise<void> {
  await page
    .locator('aside')
    .getByRole('button')
    .filter({ hasText: 'Pulse Server' })
    .first()
    .click();
  await page.getByRole('menuitem', { name: item }).click();
}

/**
 * PROBE UTILITY — not a test. Verifies that a newly uploaded custom server
 * emoji appears in the emoji picker immediately (no page reload) and that
 * the Server Emojis category sits right under Frequently used. Runs only
 * when EMOJI_PROBE is set so it can never fire in CI.
 */

test.skip(!process.env.EMOJI_PROBE, 'probe utility, set EMOJI_PROBE=1');

test('custom emoji appears in picker without reload', async ({ browser }) => {
  test.setTimeout(120_000);
  const { page } = await authedPage(
    browser,
    'http://127.0.0.1:14991',
    CORE_OWNER
  );

  const emojiName = `probe${Date.now().toString(36)}`;
  const tmpFile = `/tmp/${emojiName}.png`;
  copyFileSync('fixtures/pixel.png', tmpFile);

  // IMPORTANT: open the picker ONCE BEFORE uploading — the bug being
  // verified is emoji-mart freezing its category snapshot on first init,
  // so the regression only reproduces when the first init happens before
  // the new emoji exists. Scope the smile button to the composer row —
  // message hover bars have an identical "Add Reaction" smile icon.
  const emojiButton = page
    .locator('button:has(svg.lucide-smile):not([title="Add Reaction"])')
    .filter({ visible: true })
    .first();
  await emojiButton.click();
  await expect(page.locator('em-emoji-picker')).toBeVisible();
  await page.keyboard.press('Escape');

  // Upload a new emoji via Server Settings -> Emojis
  await serverMenu(page, 'Server Settings');
  await page.getByRole('button', { name: 'Emojis', exact: true }).click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload Emoji' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(tmpFile);
  await expect(
    page.getByText(/emoji.*(uploaded|added|created)/i).first()
  ).toBeVisible({ timeout: 15_000 });

  // WITHOUT reloading: back to the channel view, open the picker again
  await page.keyboard.press('Escape');
  await emojiButton.click();
  const picker = page.locator('em-emoji-picker');
  await expect(picker).toBeVisible();

  // Category order: Server Emojis directly after Frequently used
  const navLabels = await picker
    .locator('nav button')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  expect(navLabels[0]).toMatch(/frequent/i);
  expect(navLabels[1]).toMatch(/server emojis/i);

  // The just-uploaded emoji is findable by its unique name — customs
  // render deep in the picker's shadow DOM (background-image cells), so
  // assert on the shadow root's serialized content.
  await picker.locator('input[type="search"]').fill(emojiName);
  await expect(picker.getByText('Search Results')).toBeVisible();
  await expect
    .poll(
      () =>
        picker.evaluate((el, name) => {
          const root = el.shadowRoot;
          return root ? root.innerHTML.includes(name) : 'no-shadow-root';
        }, emojiName),
      { timeout: 10_000 }
    )
    .toBe(true);

  await page.screenshot({ path: '/tmp/emoji-probe.png' });
});
