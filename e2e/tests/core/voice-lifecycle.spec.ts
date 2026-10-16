import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page
} from '@playwright/test';
import { authedPage, CORE_OWNER, CORE_USER_B } from '../../helpers/fixtures';
import { channelButton, selectChannel } from '../../helpers/ui';

/**
 * Voice lifecycle (Tier 3) — join / state / leave as the OTHER member
 * sees it, plus the reload-no-ghost regression. Two live contexts, no
 * page refresh except where the test is about one.
 *
 * Media: the `core` project runs Chromium with fake media devices
 * (--use-fake-device-for-media-stream / --use-fake-ui-for-media-stream,
 * playwright.config.ts), so the microphone is granted without a prompt.
 * The assertions here are on SIGNALLING (roster membership, mute flag,
 * leave) — what the voice runtime publishes to every member — and do not
 * depend on media flowing. docker/compose.yml does publish the media
 * port (40000 udp+tcp) for pulse-core so ICE can complete and the client
 * never hits its transport-failure recovery path during these tests.
 *
 * Roster rows live under the voice channel in the left sidebar: a
 * cursor-pointer row carrying the member's name and a mic icon
 * (components/left-sidebar/voice-user.tsx). The member list on the right
 * shows names without a mic icon, so the `:has(svg.lucide-mic…)` filter
 * keeps the two apart.
 */

const BASE = 'http://127.0.0.1:14991';
const VOICE_CHANNEL = 'General Voice';

/** Sidebar roster entries for `name` (every voice channel's rows). */
function rosterEntry(page: Page, name: string): Locator {
  return page
    .locator('div.cursor-pointer:has(svg.lucide-mic, svg.lucide-mic-off)')
    .filter({ hasText: name });
}

/** The "Disconnect" button in the sidebar's voice control block. */
function disconnectButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Disconnect', exact: true });
}

let ctxA: BrowserContext;
let ctxB: BrowserContext;
let pageA: Page;
let pageB: Page;

test.describe('voice lifecycle', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    ({ context: ctxA, page: pageA } = await authedPage(browser, BASE, CORE_OWNER));
    ({ context: ctxB, page: pageB } = await authedPage(browser, BASE, CORE_USER_B));
    // B watches from a text channel: the roster is in the sidebar, which
    // stays visible whatever B has open.
    await selectChannel(pageB, 'General Text');
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('join shows up in the other member\'s roster, mute propagates, leave empties it', async () => {
    await expect(rosterEntry(pageB, CORE_OWNER.displayName)).toHaveCount(0);

    // Join: click the voice channel row.
    await selectChannel(pageA, VOICE_CHANNEL);

    // Signalling completes → both sides list A exactly once.
    await expect(rosterEntry(pageA, CORE_OWNER.displayName).first()).toBeVisible({
      timeout: 15_000
    });
    await expect(rosterEntry(pageB, CORE_OWNER.displayName)).toHaveCount(1, {
      timeout: 15_000
    });
    await expect(disconnectButton(pageA)).toBeVisible();

    // A joins unmuted (fake mic granted) — B sees the live-mic icon.
    await expect(
      rosterEntry(pageB, CORE_OWNER.displayName).locator('svg.lucide-mic')
    ).toHaveCount(1);

    // Mute: the user-control mic button (title carries the shortcut). The
    // control is mounted twice — a mobile copy hidden at desktop width
    // comes first in the DOM — so only the visible one counts.
    await pageA.locator('button[title^="Mute microphone"]:visible').first().click();

    await expect(
      rosterEntry(pageB, CORE_OWNER.displayName).locator('svg.lucide-mic-off')
    ).toHaveCount(1, { timeout: 10_000 });
    await expect(
      pageA.locator('button[title^="Unmute microphone"]:visible').first()
    ).toBeVisible();

    // Unmute again — the fake device re-acquires without a prompt.
    await pageA.locator('button[title^="Unmute microphone"]:visible').first().click();
    await expect(
      rosterEntry(pageB, CORE_OWNER.displayName).locator('svg.lucide-mic')
    ).toHaveCount(1, { timeout: 10_000 });

    // Leave.
    await disconnectButton(pageA).click();

    await expect(rosterEntry(pageB, CORE_OWNER.displayName)).toHaveCount(0, {
      timeout: 10_000
    });
    await expect(rosterEntry(pageA, CORE_OWNER.displayName)).toHaveCount(0, {
      timeout: 10_000
    });
    await expect(disconnectButton(pageA)).toHaveCount(0);
  });

  test('reload mid-voice leaves no ghost: the socket close evicts, a rejoin lists the member once', async () => {
    await selectChannel(pageA, VOICE_CHANNEL);
    await expect(rosterEntry(pageB, CORE_OWNER.displayName)).toHaveCount(1, {
      timeout: 15_000
    });

    // The navigation closes A's socket; the server evicts the session.
    await pageA.reload();
    await expect(channelButton(pageA, 'General Text')).toBeVisible({
      timeout: 30_000
    });

    await expect(rosterEntry(pageB, CORE_OWNER.displayName)).toHaveCount(0, {
      timeout: 10_000
    });

    // Rejoin after the reload: exactly one entry on both sides, never the
    // orphaned pair of an earlier release.
    await selectChannel(pageA, VOICE_CHANNEL);
    await expect(rosterEntry(pageB, CORE_OWNER.displayName)).toHaveCount(1, {
      timeout: 15_000
    });
    await expect(rosterEntry(pageA, CORE_OWNER.displayName)).toHaveCount(1, {
      timeout: 15_000
    });

    await disconnectButton(pageA).click();
    await expect(rosterEntry(pageB, CORE_OWNER.displayName)).toHaveCount(0, {
      timeout: 10_000
    });
  });

  test('closing the tab without leaving evicts the member for everyone else', async ({
    browser
  }) => {
    const { context, page } = await authedPage(browser, BASE, CORE_OWNER);
    await selectChannel(page, VOICE_CHANNEL);
    await expect(rosterEntry(pageB, CORE_OWNER.displayName)).toHaveCount(1, {
      timeout: 15_000
    });

    await context.close();

    await expect(rosterEntry(pageB, CORE_OWNER.displayName)).toHaveCount(0, {
      timeout: 10_000
    });
  });
});
