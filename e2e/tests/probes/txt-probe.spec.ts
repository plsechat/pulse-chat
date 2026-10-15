import { expect, test } from '@playwright/test';
import { authedPage, CORE_OWNER } from '../../helpers/fixtures';
import { channelComposer, selectChannel } from '../../helpers/ui';

/**
 * PROBE UTILITY — not a test. Verifies that an over-length code-block
 * message is auto-converted into a message.txt attachment on send. Runs
 * only when TXT_PROBE is set so it can never fire in CI.
 */

test.skip(!process.env.TXT_PROBE, 'probe utility, set TXT_PROBE=1');

test('oversized code block sends as message.txt', async ({ browser }) => {
  test.setTimeout(120_000);
  const { page } = await authedPage(
    browser,
    'http://127.0.0.1:14991',
    CORE_OWNER
  );

  await selectChannel(page, 'General Text');

  const composer = channelComposer(page);
  await composer.click();
  // 17k chars inside a fence — over the 16k plaintext budget
  const big = '```\n' + 'x'.repeat(17_000) + '\n```';
  await composer.fill(big);
  await page.keyboard.press('Enter');

  await expect(
    page.getByText('Message was over the length limit — sent as message.txt')
  ).toBeVisible({ timeout: 20_000 });

  // The attachment card lands in the channel
  await expect(page.getByText('message.txt').last()).toBeVisible({
    timeout: 15_000
  });
  await page.screenshot({ path: '/tmp/txt-probe.png' });
});
