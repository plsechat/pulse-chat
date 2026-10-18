import { expect, test } from '@playwright/test';
import { authedPage, CORE_OWNER } from '../../helpers/fixtures';
import { selectChannel, visibleComposer } from '../../helpers/ui';

/**
 * Composer (tiptap) keyboard behaviour that the message specs don't
 * cover: Tab/Shift+Tab inside a code block indent/outdent instead of
 * moving focus out of the editor.
 */

const BASE = 'http://127.0.0.1:14991';

test('Tab indents and Shift+Tab outdents inside a code block without leaving the composer', async ({
  browser
}) => {
  const { context, page } = await authedPage(browser, BASE, CORE_OWNER);
  try {
    await selectChannel(page, 'General Text');

    const composer = visibleComposer(page);
    await composer.click();
    // "```<lang> " triggers the code-block input rule.
    await page.keyboard.type('```ts ');
    await page.keyboard.type('if (x) {');

    const codeText = () =>
      composer.evaluate(
        (el) => el.querySelector('pre code')?.textContent ?? '<no codeblock>'
      );
    expect(await codeText()).toBe('if (x) {');

    // Tab indents by two spaces and focus STAYS in the composer.
    await page.keyboard.press('Tab');
    await page.keyboard.type('doIt();');
    expect(await codeText()).toBe('if (x) {  doIt();');
    await expect(composer).toBeFocused();

    // Shift+Tab outdents the current line's leading spaces.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('deep');
    expect(await codeText()).toContain('\n  deep');
    await page.keyboard.press('Shift+Tab');
    expect(await codeText()).toContain('\ndeep');
    await expect(composer).toBeFocused();

    // Nothing was sent: the draft is still in the composer, not the pane.
    await expect(
      page.locator('[id^="msg-"]').filter({ hasText: 'doIt();' })
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});
