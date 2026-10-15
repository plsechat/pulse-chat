import { expect, test } from '@playwright/test';
import { authedPage, CORE_OWNER } from '../../helpers/fixtures';
import { channelButton } from '../../helpers/ui';

/**
 * PROBE UTILITY — not a test. Verifies Tab/Shift+Tab indent/outdent
 * inside a composer code block. Runs only when TAB_PROBE is set.
 */

test.skip(!process.env.TAB_PROBE, 'probe utility, set TAB_PROBE=1');

test('tab indents inside a code block', async ({ browser }) => {
  test.setTimeout(60_000);
  const { page } = await authedPage(
    browser,
    'http://127.0.0.1:14991',
    CORE_OWNER
  );

  await channelButton(page, 'General Text').click({ force: true });

  const composer = page
    .locator('[contenteditable="true"]')
    .filter({ visible: true })
    .first();
  await composer.click();
  // ``` + space triggers the code-block input rule
  await page.keyboard.type('```ts ');
  await page.keyboard.type('if (x) {');

  const codeText = () =>
    composer.evaluate(
      (el) => el.querySelector('pre code')?.textContent ?? '<no codeblock>'
    );

  expect(await codeText()).toBe('if (x) {');

  // Tab indents by two spaces and focus STAYS in the composer
  await page.keyboard.press('Tab');
  await page.keyboard.type('doIt();');
  expect(await codeText()).toBe('if (x) {  doIt();');
  await expect(composer).toBeFocused();

  // Shift+Tab outdents the line's leading spaces... insert a fresh
  // indented line first
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('deep');
  expect(await codeText()).toContain('\n  deep');
  await page.keyboard.press('Shift+Tab');
  expect(await codeText()).toContain('\ndeep');
  await expect(composer).toBeFocused();
});
