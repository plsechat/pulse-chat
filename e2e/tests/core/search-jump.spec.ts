import {
  expect,
  test,
  type BrowserContext,
  type Page
} from '@playwright/test';
import { psql } from '../../helpers/db';
import { authedPage, CORE_OWNER } from '../../helpers/fixtures';
import { channelButton, selectChannel } from '../../helpers/ui';

/**
 * Server search (top-right / Ctrl+K) jump-to-message. The target lives in
 * a DIFFERENT channel than the one open, buried far past the initial
 * page, so the jump must switch channels, around-fetch, then scroll to +
 * highlight the message in the pane. Regression guard for the bug where
 * the jump switched channels but the scroll controller's post-fetch
 * scroll-to-bottom yanked the (highlighted) target off-screen.
 */

const BASE = 'http://127.0.0.1:14991';
const RUN = Date.now().toString(36);

// A run-unique term only the target message carries (fillers use a
// different word), so the search returns exactly one result.
const TARGET_TERM = `srchtarget${RUN}`;

let chanName = '';
let chanId = '';
let ownerId = '';

let ownerCtx: BrowserContext;
let ownerPage: Page;

function messagePane(page: Page) {
  return page.getByTestId('message-scroll');
}

function createChannel(name: string): string {
  psql(
    'core',
    `INSERT INTO channels (type, name, position, file_access_token, file_access_token_updated_at, public_id, category_id, server_id, created_at)
     VALUES ('TEXT', '${name}', 60, gen_random_uuid(), extract(epoch from now())*1000, gen_random_uuid(), 1, 1, extract(epoch from now())*1000)`
  );
  return psql('core', `SELECT id FROM channels WHERE name = '${name}'`);
}

test.describe('search jump-to-message', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    ownerId = psql(
      'core',
      `SELECT id FROM users WHERE name = '${CORE_OWNER.displayName}'`
    );

    chanName = `srch-${RUN}`;
    chanId = createChannel(chanName);

    // Target first, then 130 fillers on top (> the 100-message initial
    // page) so the target is only reachable via the around-fetch.
    psql(
      'core',
      `INSERT INTO messages (content, user_id, channel_id, created_at)
       VALUES ('${TARGET_TERM} needle', ${ownerId}, ${chanId}, extract(epoch from now())*1000)`
    );
    psql(
      'core',
      `INSERT INTO messages (content, user_id, channel_id, created_at)
       SELECT 'filler ${RUN} ' || i, ${ownerId}, ${chanId},
              extract(epoch from now())*1000 + i * 1000
       FROM generate_series(1, 130) AS i`
    );

    ({ context: ownerCtx, page: ownerPage } = await authedPage(
      browser,
      BASE,
      CORE_OWNER
    ));
    await ownerPage.reload();
    await expect(channelButton(ownerPage, chanName)).toBeVisible({
      timeout: 20_000
    });
  });

  test.afterAll(async () => {
    await ownerCtx?.close();
  });

  /** Open the top-bar search and run a query; returns when a result shows. */
  async function search(page: Page, query: string) {
    // Ctrl+K toggles the search popover (see top-bar keydown handler).
    await page.keyboard.press('Control+k');
    const input = page.getByPlaceholder('Search messages...');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(query);
    // The Jump affordance only exists on a rendered result — wait for it
    // (the query term is <mark>-split in the result text, so match on the
    // button instead). Debounced fetch → generous timeout.
    await expect(
      page.getByRole('button', { name: 'Jump' }).first()
    ).toBeVisible({ timeout: 15_000 });
  }

  async function assertJumpedToTarget(page: Page) {
    const row = page
      .locator('[id^="msg-"]')
      .filter({ hasText: `${TARGET_TERM} needle` })
      .first();
    // Highlight auto-clears after 2.5s — assert it before the fade.
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toHaveClass(/animate-msg-highlight/, { timeout: 5_000 });
    await expect(row).toBeInViewport();
  }

  test('the Jump button scrolls to + highlights the target in the pane', async () => {
    // Start on a DIFFERENT channel so the jump must switch channels.
    await selectChannel(ownerPage, 'General Text');
    await search(ownerPage, TARGET_TERM);

    await ownerPage.getByRole('button', { name: 'Jump' }).first().click();
    await assertJumpedToTarget(ownerPage);
  });

  test('clicking the result row also jumps to + highlights the target', async () => {
    // Fresh page so this decouples from the previous jump's detached state.
    await ownerPage.reload();
    await expect(channelButton(ownerPage, chanName)).toBeVisible({
      timeout: 20_000
    });
    await selectChannel(ownerPage, 'General Text');
    await search(ownerPage, TARGET_TERM);

    // Click the result ROW (role=button, carries 'needle' in its content),
    // NOT the Jump affordance. Playwright clicks the row's center — the
    // avatar/username line, safely away from the top-right Jump button.
    await ownerPage
      .locator('[role="button"]')
      .filter({ hasText: 'needle' })
      .first()
      .click();
    await assertJumpedToTarget(ownerPage);
  });
});
