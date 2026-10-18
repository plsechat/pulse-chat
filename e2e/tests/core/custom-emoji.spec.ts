import { expect, test } from '@playwright/test';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { authedPage, CORE_OWNER, RUN_TAG } from '../../helpers/fixtures';
import {
  openServerSettings,
  selectChannel,
  toast,
  visibleComposer
} from '../../helpers/ui';

/**
 * Custom server emoji: upload → picker (without a reload) → category
 * order → used in a message. Closes the Tier 3 "custom emoji upload→use"
 * roadmap item.
 *
 * Regression background: emoji-mart freezes its category snapshot on the
 * FIRST picker init, so a server whose picker was opened before any
 * custom emoji existed used to never learn about the Server Emojis
 * category until a reload. The picker is therefore deliberately opened
 * once BEFORE the upload.
 */

const BASE = 'http://127.0.0.1:14991';
const FIXTURE_PNG = path.join(__dirname, '..', '..', 'fixtures', 'pixel.png');

test('upload shows in the picker without reload, in category order, and renders in a sent message', async ({
  browser
}) => {
  test.setTimeout(120_000);
  const { context, page } = await authedPage(browser, BASE, CORE_OWNER);
  try {
    await selectChannel(page, 'General Text');

    // The emoji name derives from the uploaded filename — a per-run
    // name keeps reruns on a lived-in instance from colliding.
    const emojiName = `emo${RUN_TAG}`;
    const file = test.info().outputPath(`${emojiName}.png`);
    copyFileSync(FIXTURE_PNG, file);

    // Composer-row smile button; message hover bars carry an identical
    // "Add Reaction" smile icon, hence the title exclusion.
    const emojiButton = page
      .locator('button:has(svg.lucide-smile):not([title="Add Reaction"])')
      .filter({ visible: true })
      .first();
    const picker = page.locator('em-emoji-picker');

    // First init BEFORE the upload (see the file comment).
    await emojiButton.click();
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);

    await openServerSettings(page, 'Emojis');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload Emoji' }).click();
    await (await chooserPromise).setFiles(file);
    await expect(toast(page, 'Emoji created')).toBeVisible({
      timeout: 15_000
    });
    await page.keyboard.press('Escape');

    // No reload: the picker must already know the new emoji.
    await emojiButton.click();
    await expect(picker).toBeVisible();

    // Category order: Server Emojis directly after Frequently used.
    const navLabels = await picker
      .locator('nav button')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
    expect(navLabels[0]).toMatch(/frequent/i);
    expect(navLabels[1]).toMatch(/server emojis/i);

    // Search finds it by its unique name; Enter picks the first result,
    // which inserts the custom-emoji node into the composer and closes
    // the picker.
    const search = picker.locator('input[type="search"]');
    await search.fill(emojiName);
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
    await search.press('Enter');
    await expect(picker).toHaveCount(0);

    // The composer holds the custom-emoji node; send it.
    const composer = visibleComposer(page);
    await expect(composer.locator(`img[alt="${emojiName}"]`)).toHaveCount(1);
    await composer.click();
    await page.keyboard.press('Enter');

    // Rendered message: the `<:name:id>` token resolves to the server
    // emoji image (lib/converters/custom-emoji.tsx — alt carries the
    // name, title the :shortcode:).
    const rendered = page
      .locator('[id^="msg-"]')
      .locator(`img.emoji-image[alt="${emojiName}"]`)
      .last();
    await expect(rendered).toBeVisible({ timeout: 15_000 });
    await expect(rendered).toHaveAttribute('title', `:${emojiName}:`);
    const src = await rendered.getAttribute('src');
    const res = await page.request.get(new URL(src!, BASE).href);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/');
  } finally {
    await context.close();
  }
});
