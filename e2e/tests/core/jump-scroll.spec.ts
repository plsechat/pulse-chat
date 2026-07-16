import {
  expect,
  test,
  type BrowserContext,
  type Page
} from '@playwright/test';
import { psql } from '../../helpers/db';
import { authedPage, CORE_OWNER, CORE_USER_B } from '../../helpers/fixtures';
import { channelButton, selectChannel } from '../../helpers/ui';

/**
 * Discord-style navigation: message-link jump (including to messages far
 * outside the loaded history, via the around-fetch), scroll-position
 * memory across channel switches, and landing on the "New messages"
 * divider when returning to a channel with unreads.
 *
 * IMPORTANT: this spec seeds its own DEDICATED channels via psql (never
 * the shared "General Text*" seed channels). The jump/scroll tests need
 * 150+ filler rows; dumping those into a shared channel leaves it with an
 * unread badge that breaks other specs' exact-name selectors (and core
 * setup) on the same DB.
 */

const BASE = 'http://127.0.0.1:14991';
const RUN = Date.now().toString(36);

// Dedicated channels created in beforeAll.
let bulkChanId = ''; // 1 target + 150 fillers
let bulkChanName = '';
let targetId = '';
let ownerId = '';

let ownerCtx: BrowserContext;
let ownerPage: Page;

/** The scrollable message container of the open channel. */
function messagePane(page: Page) {
  return page.getByTestId('message-scroll');
}

/** Create a dedicated TEXT channel on the default server; returns its id. */
function createChannel(name: string): string {
  psql(
    'core',
    `INSERT INTO channels (type, name, position, file_access_token, file_access_token_updated_at, public_id, category_id, server_id, created_at)
     VALUES ('TEXT', '${name}', 60, gen_random_uuid(), extract(epoch from now())*1000, gen_random_uuid(), 1, 1, extract(epoch from now())*1000)`
  );
  return psql('core', `SELECT id FROM channels WHERE name = '${name}'`);
}

test.describe('message jump + scroll memory', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    ownerId = psql(
      'core',
      `SELECT id FROM users WHERE name = '${CORE_OWNER.displayName}'`
    );

    // One dedicated channel: a target message buried under 150 newer
    // fillers (far outside the latest-page window).
    bulkChanName = `js-bulk-${RUN}`;
    bulkChanId = createChannel(bulkChanName);
    psql(
      'core',
      `INSERT INTO messages (content, user_id, channel_id, created_at)
       VALUES ('jump target ${RUN}', ${ownerId}, ${bulkChanId}, extract(epoch from now())*1000)`
    );
    targetId = psql(
      'core',
      `SELECT id FROM messages WHERE channel_id = ${bulkChanId} AND content = 'jump target ${RUN}'`
    );
    psql(
      'core',
      `INSERT INTO messages (content, user_id, channel_id, created_at)
       SELECT 'filler ${RUN} ' || i, ${ownerId}, ${bulkChanId},
              (SELECT created_at FROM messages WHERE id = ${targetId}) + i * 1000
       FROM generate_series(1, 150) AS i`
    );

    ({ context: ownerCtx, page: ownerPage } = await authedPage(
      browser,
      BASE,
      CORE_OWNER
    ));
    // Reload so the client picks up the DB-created channel.
    await ownerPage.reload();
    await expect(channelButton(ownerPage, bulkChanName)).toBeVisible({
      timeout: 20_000
    });
  });

  test.afterAll(async () => {
    await ownerCtx?.close();
  });

  test('a message link jumps to an old message and Jump to Present reattaches', async () => {
    // Paste the link token into a DIFFERENT channel (General Text) and
    // send it. A run-unique marker scopes the badge click.
    await selectChannel(ownerPage, 'General Text');
    const composer = ownerPage
      .locator('[contenteditable="true"]')
      .filter({ visible: true })
      .first();
    await composer.click();
    await composer.fill(`see-${RUN} <#msg:${bulkChanId}/${targetId}>`);
    await ownerPage.keyboard.press('Enter');

    // The token renders as a "Message in <channel>" badge — click THIS
    // run's, scoped to the row carrying our marker.
    await ownerPage
      .locator('[id^="msg-"]')
      .filter({ hasText: `see-${RUN}` })
      .getByRole('button', { name: `Message in ${bulkChanName}` })
      .first()
      .click();

    // The jump switches channels, around-fetches, scrolls to the target
    // and flashes it. Assert the highlight FIRST — it auto-clears after
    // 2.5s, so a slower assertion ahead of it would race the fade.
    const row = ownerPage
      .locator('[id^="msg-"]')
      .filter({ hasText: `jump target ${RUN}` })
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toHaveClass(/animate-msg-highlight/, { timeout: 5_000 });
    await expect(row).toBeInViewport();

    // DETACHED from the live tail (150 newer messages below) — the pill
    // must rejoin the present on click.
    const pill = ownerPage.getByRole('button', { name: 'Jump to Present' });
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(
      ownerPage.getByText(`filler ${RUN} 150`, { exact: true })
    ).toBeVisible({ timeout: 15_000 });
    await expect(row).not.toBeInViewport();
  });

  test('scroll position is remembered when switching channels and back', async () => {
    // Fresh page decouples from the previous test's detached/reattach.
    await ownerPage.reload();
    await expect(channelButton(ownerPage, bulkChanName)).toBeVisible({
      timeout: 20_000
    });
    await selectChannel(ownerPage, bulkChanName);
    await expect(
      ownerPage
        .locator('[id^="msg-"]')
        .filter({ hasText: `filler ${RUN} 150` })
        .first()
    ).toBeVisible({ timeout: 15_000 });

    // Scroll a mid-page message up from the bottom — a real scroll (drives
    // onScroll, saving position) via a message anchor, not pixel math.
    const anchor = ownerPage
      .locator('[id^="msg-"]')
      .filter({ hasText: `filler ${RUN} 90` })
      .first();
    await anchor.scrollIntoViewIfNeeded();
    await expect(anchor).toBeInViewport();
    const parkedTop = await messagePane(ownerPage).evaluate(
      (el) => el.scrollTop
    );
    expect(parkedTop).toBeGreaterThan(100);

    // Leave and come back.
    await selectChannel(ownerPage, 'General Text');
    await expect(channelButton(ownerPage, bulkChanName)).toBeVisible();
    await selectChannel(ownerPage, bulkChanName);

    // The reported regression: returning snaps you to the bottom. The
    // restore must land back near the parked spot — poll the settled
    // position (restore runs on a short retry ladder after the remount).
    const pane = messagePane(ownerPage);
    await expect(pane.locator('[id^="msg-"]').first()).toBeVisible({
      timeout: 15_000
    });
    await expect
      .poll(
        () =>
          pane.evaluate(
            (el) => el.scrollHeight - (el.scrollTop + el.clientHeight)
          ),
        { timeout: 15_000 }
      )
      .toBeGreaterThan(200);
    const restoredTop = await pane.evaluate((el) => el.scrollTop);
    expect(Math.abs(restoredTop - parkedTop)).toBeLessThan(400);
  });

  test('returning to a channel with unreads lands on the New Messages divider', async ({
    browser
  }) => {
    // A second dedicated channel with just a seed message.
    const chan = `js-dv-${RUN}`;
    const chanId = createChannel(chan);
    psql(
      'core',
      `INSERT INTO messages (content, user_id, channel_id, created_at)
       VALUES ('seed ${RUN}', ${ownerId}, ${chanId}, extract(epoch from now())*1000)`
    );

    const { context: ctxB, page: pageB } = await authedPage(
      browser,
      BASE,
      CORE_USER_B
    );
    try {
      // B reloads to pick up the DB-created channel, reads it (the initial
      // load marks read up to the seed), then leaves.
      await pageB.reload();
      await selectChannel(pageB, chan);
      await expect(
        pageB.getByText(`seed ${RUN}`, { exact: true })
      ).toBeVisible({ timeout: 15_000 });
      await pageB.waitForTimeout(500);
      await selectChannel(pageB, 'General Text');

      // Three messages arrive while B is away.
      psql(
        'core',
        `INSERT INTO messages (content, user_id, channel_id, created_at)
         SELECT 'unseen ${RUN} ' || i, ${ownerId}, ${chanId},
                extract(epoch from now())*1000 + i
         FROM generate_series(1, 3) AS i`
      );

      // B reconnects (snapshot: read up to the seed, before the unseen)
      // and opens the channel. The divider must render above the unseen
      // messages AND be scrolled into view — the reported "nothing scrolls
      // to the divider" gap.
      await pageB.reload();
      await selectChannel(pageB, chan);
      const divider = pageB.locator('#new-messages-divider');
      await expect(divider).toBeVisible({ timeout: 15_000 });
      await expect(divider).toBeInViewport();
      await expect(
        pageB.getByText(`unseen ${RUN} 1`, { exact: true })
      ).toBeInViewport();
    } finally {
      await ctxB.close();
    }
  });
});
