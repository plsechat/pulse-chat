import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page
} from '@playwright/test';
import { loginUser } from '../../helpers/api';
import { psql } from '../../helpers/db';
import {
  authedPage,
  CORE_OWNER,
  registerAndJoin,
  runUser
} from '../../helpers/fixtures';
import { selectChannel, toast, voiceRosterEntry } from '../../helpers/ui';

/**
 * Moderation: kick, ban (live disconnect + blocked login), unban, and
 * voice server-mute + moderator disconnect. Voice moderation shipped
 * blind in v0.2.3 (its target-side state sync was broken until the
 * ownVoiceState mirror fix); the voice test here rides the real media
 * path the e2e compose publishes for the core instance.
 *
 * Uses a per-run throwaway target: bans are INSTANCE-WIDE login blocks,
 * so banning a shared fixture user would wreck every other spec if a run
 * dies between ban and unban.
 */

const BASE = 'http://127.0.0.1:14991';
const VOICE_CHANNEL = 'General Voice';

const TARGET = runUser('mod-target');
const KICK_REASON = `kick-reason-${TARGET.displayName}`;
const BAN_REASON = `ban-reason-${TARGET.displayName}`;

let ownerCtx: BrowserContext;
let ownerPage: Page;
// Browser handle captured in beforeAll so each test can mint its OWN live
// target page — a kicked/banned page is torn down, so a shared one can't
// survive across the serial tests.
let sharedBrowser: Browser;

function targetId(): string {
  return psql(
    'core',
    `SELECT id FROM users WHERE name = '${TARGET.displayName}'`
  );
}

/** A fresh, live, WS-connected target page (member of the server). */
async function freshTarget(): Promise<{ context: BrowserContext; page: Page }> {
  return authedPage(sharedBrowser, BASE, TARGET);
}

/** Owner opens the moderation sheet for TARGET via Server Settings → Users. */
async function openModView(page: Page): Promise<void> {
  // Dismiss any lingering sheet/settings screen from a previous action so
  // this opens against a clean shell (Escape closes the mod sheet, then
  // the settings screen).
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('heading', { name: 'Server Settings' })
  ).toHaveCount(0);
  await page
    .locator('aside')
    .getByRole('button')
    .filter({ hasText: 'Pulse Server' })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  // The users table accumulates rows across runs — filter to the one
  // target so its kebab button is the only one on screen.
  await page
    .getByPlaceholder('Search users by name or identity...')
    .fill(TARGET.displayName);
  await expect(page.getByText(TARGET.displayName).first()).toBeVisible({
    timeout: 15_000
  });
  await page
    .locator('button:has(svg.lucide-ellipsis-vertical)')
    .filter({ visible: true })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Moderate User' }).click();
  // The sheet loads user info async — wait for its action row.
  await expect(page.getByRole('button', { name: 'Kick' })).toBeVisible({
    timeout: 15_000
  });
}

test.describe('moderation', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    sharedBrowser = browser;
    await registerAndJoin(browser, BASE, TARGET);
    ({ context: ownerCtx, page: ownerPage } = await authedPage(
      browser,
      BASE,
      CORE_OWNER
    ));
  });

  test.afterAll(async () => {
    await ownerCtx?.close();
  });

  test('kick removes membership and boots the live target', async () => {
    const { context, page: target } = await freshTarget();
    try {
      await openModView(ownerPage);
      await ownerPage.getByRole('button', { name: 'Kick' }).click();

      const dialog = ownerPage.getByRole('alertdialog');
      await expect(
        dialog.getByRole('heading', { name: 'Kick User' })
      ).toBeVisible();
      await dialog.getByRole('textbox').fill(KICK_REASON);
      await dialog.getByRole('button', { name: 'Kick' }).click();
      await expect(toast(ownerPage, 'User kicked successfully')).toBeVisible({
        timeout: 15_000
      });

      // Membership row gone; the target's client auto-reconnects (kick is
      // recoverable) and no longer sees the server's channels.
      await expect
        .poll(
          () =>
            psql(
              'core',
              `SELECT count(*) FROM server_members WHERE user_id = ${targetId()}`
            ),
          { timeout: 15_000 }
        )
        .toBe('0');
      // Badge-immune absence check — an exact-name match would also
      // resolve to 0 for a MEMBER whose row carries an unread badge.
      await expect(
        target
          .getByRole('button')
          .filter({ has: target.getByText('General Text', { exact: true }) })
      ).toHaveCount(0, { timeout: 20_000 });

      // The kick is journaled with its reason.
      await expect
        .poll(
          () =>
            psql(
              'core',
              `SELECT count(*) FROM activity_log WHERE type = 'USER_KICKED' AND details::text LIKE '%${KICK_REASON}%'`
            ),
          { timeout: 15_000 }
        )
        .toBe('1');
    } finally {
      await context.close();
    }

    // Re-add membership cleanly (fresh join) for the ban test, rather
    // than driving the just-booted page's reconnect.
    await registerAndJoin(sharedBrowser, BASE, TARGET);
  });

  test('ban live-disconnects the target onto the banned screen and blocks login', async () => {
    const { context, page: target } = await freshTarget();
    try {
      await runBanFlow(target);
    } finally {
      await context.close();
    }
  });

  async function runBanFlow(target: Page): Promise<void> {
    await openModView(ownerPage);
    await ownerPage.getByRole('button', { name: 'Ban', exact: true }).click();

    const dialog = ownerPage.getByRole('alertdialog');
    await expect(
      dialog.getByRole('heading', { name: 'Ban User' })
    ).toBeVisible();
    await dialog.getByRole('textbox').fill(BAN_REASON);
    await dialog.getByRole('button', { name: 'Ban' }).click();
    await expect(toast(ownerPage, 'User banned successfully')).toBeVisible({
      timeout: 15_000
    });

    // Target: WS closed with the BANNED code → dedicated screen with the
    // reason and NO reconnect escape hatch.
    await expect(
      target.getByRole('heading', { name: 'You have been banned' })
    ).toBeVisible({ timeout: 20_000 });
    await expect(target.getByText(BAN_REASON)).toBeVisible();
    await expect(
      target.getByRole('button', { name: 'Reconnect' })
    ).toHaveCount(0);

    // Instance-wide: login is rejected outright with the reason.
    expect(psql('core', `SELECT banned FROM users WHERE id = ${targetId()}`)).toBe(
      't'
    );
    const res = await ownerPage.request.post(`${BASE}/login`, {
      data: { email: TARGET.email, password: TARGET.password }
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain(`Account banned: ${BAN_REASON}`);
  }

  test('unban restores login', async () => {
    await openModView(ownerPage);
    await ownerPage.getByRole('button', { name: 'Unban' }).click();

    const dialog = ownerPage.getByRole('alertdialog');
    await expect(
      dialog.getByRole('heading', { name: 'Unban User' })
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Unban' }).click();
    await expect(toast(ownerPage, 'User unbanned successfully')).toBeVisible({
      timeout: 15_000
    });

    await expect
      .poll(() =>
        psql('core', `SELECT banned FROM users WHERE id = ${targetId()}`)
      )
      .toBe('f');
    // The helper throws on a non-OK login — reaching the next line IS the
    // assertion.
    await loginUser(BASE, TARGET.email, TARGET.password);
  });

  /**
   * Voice server-mute: moderator toggles → the target's roster entry
   * shows the enforced-mute icon in BOTH contexts, the target cannot lift
   * it (mic button refused with a toast; the server also drops the unmute
   * in voice.updateState), and a moderator Disconnect evicts the target
   * with a toast. Signalling-level assertions; the media path exists
   * (compose publishes the media port) but silence is not asserted.
   */
  test('voice server-mute: enforced roster icon in both contexts, target refusal toast, moderator disconnect', async () => {
    test.setTimeout(120_000);
    // unban leaves TARGET without membership — rejoin, then a live page.
    await registerAndJoin(sharedBrowser, BASE, TARGET);
    const { context, page: target } = await freshTarget();
    try {
      // Clear any settings/mod sheet the previous test left on the owner.
      await ownerPage.keyboard.press('Escape');
      await ownerPage.keyboard.press('Escape');
      await selectChannel(ownerPage, 'General Text');

      // Target joins voice and mutes itself, so the only remaining mic
      // action is an UNMUTE — the one a server-mute must refuse.
      await selectChannel(target, VOICE_CHANNEL);
      await expect(voiceRosterEntry(ownerPage, TARGET.displayName)).toHaveCount(
        1,
        { timeout: 15_000 }
      );
      await target
        .locator('button[title^="Mute microphone"]:visible')
        .first()
        .click();
      const unmuteButton = target
        .locator('button[title^="Unmute microphone"]:visible')
        .first();
      await expect(unmuteButton).toBeVisible();

      const enforcedIcon = (page: Page) =>
        voiceRosterEntry(page, TARGET.displayName).locator(
          'div[title="Muted by a moderator"]'
        );
      await expect(enforcedIcon(ownerPage)).toHaveCount(0);

      // Moderator: right-click the roster entry → Server Mute.
      await voiceRosterEntry(ownerPage, TARGET.displayName)
        .first()
        .click({ button: 'right' });
      await ownerPage.getByRole('menuitem', { name: 'Server Mute' }).click();

      // Enforced icon on both sides; the target is told once.
      await expect(enforcedIcon(ownerPage)).toHaveCount(1, { timeout: 10_000 });
      await expect(enforcedIcon(target)).toHaveCount(1, { timeout: 10_000 });
      const mutedToast = toast(target, 'You have been muted by a moderator');
      await expect(mutedToast).toBeVisible({ timeout: 10_000 });
      // Let the transition toast dismiss so the refusal below is
      // unambiguous (same text, different trigger).
      await expect(mutedToast).toHaveCount(0, { timeout: 15_000 });

      // Target tries to unmute: refused client-side with the toast, the
      // button stays on "Unmute", and the roster still shows the
      // enforced icon everywhere.
      await unmuteButton.click();
      await expect(
        toast(target, 'You have been muted by a moderator')
      ).toBeVisible({ timeout: 5_000 });
      await expect(unmuteButton).toBeVisible();
      await expect(enforcedIcon(ownerPage)).toHaveCount(1);
      await expect(enforcedIcon(target)).toHaveCount(1);

      // Moderator disconnect: the target is evicted with a toast and
      // leaves every roster.
      await voiceRosterEntry(ownerPage, TARGET.displayName)
        .first()
        .click({ button: 'right' });
      await ownerPage
        .getByRole('menuitem', { name: 'Disconnect from Voice' })
        .click();
      await expect(
        toast(target, 'You were disconnected from the voice channel')
      ).toBeVisible({ timeout: 10_000 });
      await expect(voiceRosterEntry(ownerPage, TARGET.displayName)).toHaveCount(
        0,
        { timeout: 10_000 }
      );
      await expect(voiceRosterEntry(target, TARGET.displayName)).toHaveCount(
        0,
        { timeout: 10_000 }
      );
      await expect(
        target.getByRole('button', { name: 'Disconnect', exact: true })
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
