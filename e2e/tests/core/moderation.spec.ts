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
import { toast } from '../../helpers/ui';

/**
 * Moderation: kick, ban (live disconnect + blocked login), unban, and
 * voice server-mute — all shipped with no e2e coverage; voice moderation
 * shipped blind in v0.2.3 (its target-side state sync was broken until
 * the ownVoiceState mirror fix that lands with this suite).
 *
 * Uses a per-run throwaway target: bans are INSTANCE-WIDE login blocks,
 * so banning a shared fixture user would wreck every other spec if a run
 * dies between ban and unban.
 */

const BASE = 'http://127.0.0.1:14991';

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
   * The two product blockers this fixme originally documented are FIXED:
   *  - Grid tile (voice-user-card.tsx): the ContextMenu now has its own
   *    DOM node (display:contents wrapper) instead of asChild-merging
   *    onto the Popover's node, so right-click opens the moderation menu.
   *  - Sidebar row (voice-user.tsx): same wrapper + contextmenu
   *    stopPropagation, so the USER menu opens instead of the channel's.
   *  - ownVoiceState split-brain: updateVoiceUserState now mirrors
   *    serverMuted/serverDeafened into ownVoiceState for the own user,
   *    so the mic-button guard and moderator toasts work.
   *
   * What still blocks the e2e: driving two REAL voice-channel joins
   * (mediasoup produce/consume) from Playwright — the harness has no
   * voice-join fixture yet. That's the Tier 3 "voice lifecycle" roadmap
   * item; this test should be written alongside it.
   */
  test.fixme(
    'voice server-mute: enforced roster icon, target refusal toast, disconnect (needs Tier-3 voice-join harness)',
    () => {}
  );
});
