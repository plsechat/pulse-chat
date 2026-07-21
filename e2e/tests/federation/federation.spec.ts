import { expect, test, type Page } from '@playwright/test';
import { registerUser, storageStateFor } from '../../helpers/api';
import {
  channelButton,
  disableAnimations,
  waitForAppReady
} from '../../helpers/ui';

/**
 * Full federation loop between two instances, mirroring the manual smoke
 * run that found the peering bugs on 2026-07-14:
 *
 *   admin peering (add → accept) → per-server Federatable toggle →
 *   discover → join → cross-instance messaging both ways →
 *   cross-instance DM.
 *
 * fed-a is the "home" instance (baseURL, 127.0.0.1:14994); fed-b is the
 * peer, reached BY THE SAME URL THE CLIENT USES (http://pulse-fed-b:4991)
 * via the project's host-resolver rule → 127.0.0.1:14995.
 *
 * Regressions pinned here:
 *  - challenge audience = advertised domain (peering used to die with
 *    "Invalid signature" for any host:port dial)
 *  - client uses server-provided remoteUrl on reconnect (used to guess
 *    https:// and never connect to plain-http LAN peers)
 */

// Per-run unique message bodies: reruns against a live environment must
// not strict-mode-collide with rows persisted by earlier runs.
const RUN_TAG = Date.now();
const SMOKE_MSG = `federation smoke from A ${RUN_TAG}`;
const ACK_MSG = `ack from B ${RUN_TAG}`;
const DM_MSG = `cross-instance dm from A ${RUN_TAG}`;

const A_URL = 'http://127.0.0.1:14994';
const B_URL = 'http://127.0.0.1:14995';

const OWNER_A = {
  email: 'owner-a@e2e.local',
  password: 'e2e-password-1234',
  displayName: 'FedOwnerA'
};
const OWNER_B = {
  email: 'owner-b@e2e.local',
  password: 'e2e-password-1234',
  displayName: 'FedOwnerB'
};

async function loginPage(
  browser: import('@playwright/test').Browser,
  baseURL: string,
  tokens: { accessToken: string; refreshToken: string }
): Promise<Page> {
  const context = await browser.newContext({
    storageState: storageStateFor(baseURL, tokens),
    baseURL
  });
  const page = await context.newPage();
  await disableAnimations(page);
  await page.goto(baseURL);
  await waitForAppReady(page);
  return page;
}

async function openFederationSettings(page: Page): Promise<void> {
  // Server Settings lives in the server-name header dropdown
  await page.getByText('Pulse Server', { exact: true }).first().click();
  await page.getByText('Server Settings', { exact: true }).click();
  await page.getByRole('tab', { name: 'Federation' }).click();
}

/**
 * Generate the instance's Ed25519 federation keypair by saving the
 * federation settings. Enabling federation via config.ini alone does NOT
 * generate keys — that only happens through set-config (the Save button)
 * or the generateKeys route. Both peers need keys before the handshake.
 */
async function ensureFederationKeys(page: Page, baseURL: string): Promise<void> {
  await openFederationSettings(page);
  await page.getByRole('button', { name: 'Save Settings' }).click();
  // Give set-config time to persist the keypair, then reset to the app.
  await expect(page.getByRole('button', { name: 'Save Settings' })).toBeVisible();
  await page.waitForTimeout(1000);
  await page.goto(baseURL);
  await waitForAppReady(page);
}

test.describe.serial('federation: peer, join, message, DM', () => {
  let pageA: Page;
  let pageB: Page;

  test.beforeAll(async ({ browser }) => {
    let tokensA;
    let tokensB;
    try {
      tokensA = await registerUser(A_URL, OWNER_A);
    } catch {
      const { loginUser } = await import('../../helpers/api');
      tokensA = await loginUser(A_URL, OWNER_A.email, OWNER_A.password);
    }
    try {
      tokensB = await registerUser(B_URL, OWNER_B);
    } catch {
      const { loginUser } = await import('../../helpers/api');
      tokensB = await loginUser(B_URL, OWNER_B.email, OWNER_B.password);
    }
    pageA = await loginPage(browser, A_URL, tokensA);
    pageB = await loginPage(browser, B_URL, tokensB);

    // Both peers need their Ed25519 keypair before the handshake.
    await ensureFederationKeys(pageB, B_URL);
    await ensureFederationKeys(pageA, A_URL);
  });

  test.afterAll(async () => {
    await pageA?.context().close();
    await pageB?.context().close();
  });

  test('A adds B as a federated instance (advertised-domain handshake)', async () => {
    await openFederationSettings(pageA);

    // Config pre-seeded by the compose env: enabled + pulse-fed-a:4991
    await expect(
      pageA.getByPlaceholder('pulse.example.com')
    ).toHaveValue('pulse-fed-a:4991');

    await pageA
      .getByPlaceholder('https://pulse.other-instance.com')
      .fill('http://pulse-fed-b:4991');
    await pageA.getByRole('button', { name: 'Add Instance' }).click();

    // The specific success signal — not the old generic failure toast
    await expect(pageA.getByText('Federation request sent')).toBeVisible();
    await expect(pageA.getByText('pulse-fed-b:4991').first()).toBeVisible();
  });

  test('B sees the incoming request and accepts', async () => {
    await openFederationSettings(pageB);
    await expect(pageB.getByText('pulse-fed-a:4991').first()).toBeVisible();

    await pageB.getByRole('button', { name: /accept/i }).click();
    await expect(pageB.getByText(/active|mutual/i).first()).toBeVisible();
  });

  test('B marks its server federatable', async () => {
    // Per-server switch under Server Settings → General (distinct from the
    // instance-level Federation enable). Without it, B's server never
    // appears in A's remote discovery.
    await pageB.getByRole('tab', { name: 'General' }).click();

    // Anchor on the "Federatable" label, walk to the nearest ancestor row
    // that owns a switch, and toggle it.
    const federatable = pageB.locator(
      'xpath=//*[normalize-space(text())="Federatable"]/ancestor::*[.//button[@role="switch"]][1]//button[@role="switch"]'
    );
    if ((await federatable.getAttribute('data-state')) !== 'checked') {
      await federatable.click();
    }
    await pageB.getByRole('button', { name: /save/i }).first().click();
    await expect(federatable).toHaveAttribute('data-state', 'checked');
  });

  test('A discovers and joins the remote server', async () => {
    // Leave settings, open Discover → Federated
    await pageA.keyboard.press('Escape');
    await pageA.goto(A_URL);
    await waitForAppReady(pageA);

    // Discover view sits in the far-left rail
    await pageA
      .getByRole('button', { name: 'Discover Servers' })
      .first()
      .click();
    await pageA.getByRole('button', { name: 'Federated' }).first().click();

    await expect(pageA.getByText('pulse-fed-b:4991').first()).toBeVisible({
      timeout: 15_000
    });

    await pageA.getByRole('button', { name: /join/i }).first().click();
    await expect(pageA.getByText(/joined/i).first()).toBeVisible({
      timeout: 15_000
    });
  });

  test('cross-instance messaging works in both directions', async () => {
    // DIRECT navigation into the federated channel — no visit-another-
    // channel-first workaround. This pins the fixed channel-load bug:
    // the pane used to stay empty (or show the HOME channel's history for
    // the colliding numeric id) because the content key didn't change and
    // getTRPCClient fell back to the home client.
    //
    // channelButton (text filter), not role+exact-name: an unread badge
    // merges into the accessible name and breaks the exact match.
    // force: the federated channel rows carry aria-disabled (a dnd
    // reorder-permission marker, NOT a clickability gate) which Playwright
    // otherwise waits on forever.
    await channelButton(pageA, 'General Text').click({ force: true });

    const composerA = pageA.locator(
      '[contenteditable="true"]:has(p[data-placeholder^="Message #"])'
    );
    await expect(composerA).toBeVisible({ timeout: 15_000 });
    await composerA.fill(SMOKE_MSG);
    await pageA.keyboard.press('Enter');

    // Arrives on B's native view, authored by the federated shadow user
    await pageB.goto(B_URL);
    await waitForAppReady(pageB);
    await pageB.getByText('General Text', { exact: true }).first().click();
    await expect(
      pageB.getByText(SMOKE_MSG, { exact: true })
    ).toBeVisible({ timeout: 15_000 });
    await expect(pageB.getByText('FedOwnerA').first()).toBeVisible();

    // Reply propagates back to A's federated view
    const composerB = pageB.locator(
      '[contenteditable="true"]:has(p[data-placeholder^="Message #"])'
    );
    await composerB.fill(ACK_MSG);
    await pageB.keyboard.press('Enter');

    await expect(
      pageA.getByText(ACK_MSG, { exact: true })
    ).toBeVisible({ timeout: 15_000 });
  });

  test('a channel id that collides across instances loads the right history', async () => {
    // The exact id-collision repro: the federated "General Text" and the
    // home "General Text" share numeric id 1. View the HOME channel, then
    // the FEDERATED channel (same numeric id) — each must show its own
    // instance's content. Pre-fix, the unchanged numeric content key
    // skipped the remount and getTRPCClient fell back to the home client,
    // so the federated pane kept the home channel's (empty) content.
    //
    // Rail server buttons are distinguished by title: the home server is
    // "Pulse Server"; the federated one is "Pulse Server (pulse-fed-b:4991)".
    const homeServer = pageA.getByTitle('Pulse Server', { exact: true });
    const fedServer = pageA.getByTitle(/pulse-fed-b:4991/);

    // Home General Text has no federation messages.
    await homeServer.click();
    await waitForAppReady(pageA);
    await channelButton(pageA, 'General Text').click();
    await expect(
      pageA.getByText(SMOKE_MSG, { exact: true })
    ).toHaveCount(0);

    // Federated General Text (same numeric id 1) must load the federated
    // history — the content component must remount despite the id match.
    // The channel is clicked explicitly: selection auto-restore across
    // instances rides on preference sync, which is its own machinery and
    // not what this test pins.
    await fedServer.click();
    // Wait for the SWITCH to complete before clicking: the home sidebar
    // (identical channel names!) stays mounted until the remote data
    // lands, so an early click selects the HOME channel and the arriving
    // setInitialData then resets the selection. The federated rows are
    // the ones carrying aria-disabled (no reorder permission there).
    const fedGeneralText = pageA.getByRole('button', {
      name: 'General Text',
      exact: true,
      disabled: true
    });
    await expect(fedGeneralText.first()).toBeVisible({ timeout: 15_000 });
    await fedGeneralText.first().click({ force: true });
    await expect(
      pageA.getByText(SMOKE_MSG, { exact: true })
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      pageA.getByText(ACK_MSG, { exact: true })
    ).toBeVisible();
  });

  test('cross-instance DM reaches the peer with correct identities on BOTH sides', async () => {
    // From A's federated context, open B's author popover and use the
    // inline DM composer.
    await pageA.getByText('FedOwnerB').first().click();
    const popover = pageA.locator(
      '[contenteditable="true"]:has(p[data-placeholder^="Message @"])'
    );
    await expect(popover).toBeVisible();
    await popover.fill(DM_MSG);
    await pageA.keyboard.press('Enter');

    // SENDER-side identity pins (the fixed identity-swap bug: a fresh
    // federated DM used to render with sender/recipient swapped because
    // home-scoped surfaces resolved home ids against the REMOTE roster).
    // The app auto-navigates into the new DM conversation:
    //  - the conversation targets FedOwnerB (composer placeholder derives
    //    from the OTHER member via home ownUserId)
    //  - the sent message is authored by FedOwnerA (home id resolution)
    await expect(
      pageA.locator(
        '[contenteditable="true"]:has(p[data-placeholder="Message @FedOwnerB"])'
      )
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      pageA.locator('[id^="dm-msg-"]').getByText(DM_MSG, { exact: true })
    ).toBeVisible();
    await expect(
      pageA
        .getByText('FedOwnerA', { exact: true })
        .filter({ visible: true })
        .first()
    ).toBeVisible();

    // Receipt on B: navigate to Home, open the DM from the federated
    // FedOwnerA, and assert the message text arrived.
    await pageB.goto(B_URL);
    await waitForAppReady(pageB);
    // force: the unread-DM badge overlays the Home button and fails the
    // actionability hit-test even though real clicks land fine.
    // Locate by title attribute: the unread-DM badge's text REPLACES the
    // button's accessible name (content beats the title attr), so any
    // role+name match breaks whenever unread DMs exist.
    await pageB
      .locator('button[title="Home"]')
      .filter({ visible: true })
      .first()
      .click({ force: true });
    await pageB
      .getByText('FedOwnerA')
      .first()
      .click({ timeout: 15_000 });
    await expect(
      pageB.locator('[id^="dm-msg-"]').getByText(DM_MSG, { exact: true })
    ).toBeVisible({ timeout: 15_000 });
  });

  test('DM user popover resolves HOME identities while a federated server is active', async () => {
    // Regression for the UserPopover half of the identity-swap family:
    // avatars were fixed in aa2feb6 (homeScope), but the popover they
    // wrapped kept resolving via the AMBIENT roster — with fed-b active,
    // a home userId collides with a different person's remote id and the
    // popover showed the wrong profile.

    // B replies so the conversation has a message authored by EACH side.
    const dmReply = `dm reply from B ${RUN_TAG}`;
    const composerB = pageB.locator(
      '[contenteditable="true"]:has(p[data-placeholder^="Message @"])'
    );
    await composerB.click();
    await composerB.fill(dmReply);
    await pageB.keyboard.press('Enter');
    await expect(
      pageB.locator('[id^="dm-msg-"]').getByText(dmReply, { exact: true })
    ).toBeVisible({ timeout: 15_000 });

    // A activates the federated server (the ambient roster becomes the
    // REMOTE one), then opens the home DM.
    await pageA
      .getByTitle('Pulse Server (pulse-fed-b:4991)')
      .filter({ visible: true })
      .first()
      .click();
    await expect(
      // Badge-immune variant of channelButton that keeps the disabled
      // filter — aria-disabled marks the remote (non-reorderable) row,
      // distinguishing it from the identically-named home channel.
      pageA
        .getByRole('button', { disabled: true })
        .filter({ has: pageA.getByText('General Text', { exact: true }) })
        .first()
    ).toBeVisible({ timeout: 15_000 });
    await pageA
      .locator('button[title="Home"]')
      .filter({ visible: true })
      .first()
      .click({ force: true });
    await pageA.getByText('FedOwnerB').first().click({ timeout: 15_000 });
    await expect(
      pageA.locator('[id^="dm-msg-"]').getByText(dmReply, { exact: true })
    ).toBeVisible({ timeout: 15_000 });

    // Author-name spans (cursor-pointer style — distinct from the
    // sidebar row button and the header title) open the popover; each
    // must resolve to the clicked user's HOME identity. Scope the
    // assertion to the popover's own heading (h3.text-lg.font-bold) —
    // the DM profile panel renders its own h3 for the partner too.
    for (const name of ['FedOwnerA', 'FedOwnerB']) {
      await pageA
        .locator('span.cursor-pointer')
        .filter({ hasText: name })
        .first()
        .click();
      const popoverHeading = pageA
        .locator('h3.text-lg.font-bold')
        .filter({ hasText: name });
      await expect(popoverHeading).toBeVisible({ timeout: 10_000 });
      await pageA.keyboard.press('Escape');
      await expect(popoverHeading).toHaveCount(0);
    }
  });
});
