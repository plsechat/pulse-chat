import { expect, test, type Page } from '@playwright/test';
import { registerUser, storageStateFor } from '../../helpers/api';
import { disableAnimations, waitForAppReady } from '../../helpers/ui';

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

  // fixme: this flow is real and DOES pass, but only intermittently —
  // it's gated on the unfixed federated-channel-load bug (#5 below).
  // Directly selecting a federated channel whose numeric id collides with
  // the currently selected local channel frequently never dispatches the
  // history fetch; the manual smoke needed 20+ retries. The
  // visit-another-channel-first workaround below reduces but does not
  // eliminate the flake, so this stays fixme (executable documentation of
  // the full path) until #5 is fixed — shipping it green would make CI
  // flaky. The peer/accept/federatable/join steps above cover the
  // handshake regressions deterministically.
  test.fixme('cross-instance messaging works in both directions', async () => {
    // force: the federated channel rows carry aria-disabled (a dnd
    // reorder-permission marker, NOT a clickability gate) which Playwright
    // otherwise waits on forever.
    await pageA
      .getByRole('button', { name: 'General Text 2', exact: true })
      .first()
      .click({ force: true });
    await pageA
      .getByRole('button', { name: 'General Text', exact: true })
      .first()
      .click({ force: true });

    const composerA = pageA.locator(
      '[contenteditable="true"]:has(p[data-placeholder^="Message #"])'
    );
    await expect(composerA).toBeVisible({ timeout: 15_000 });
    await composerA.fill('federation smoke from A');
    await pageA.keyboard.press('Enter');

    // Arrives on B's native view, authored by the federated shadow user
    await pageB.goto(B_URL);
    await waitForAppReady(pageB);
    await pageB.getByText('General Text', { exact: true }).first().click();
    await expect(
      pageB.getByText('federation smoke from A', { exact: true })
    ).toBeVisible({ timeout: 15_000 });
    await expect(pageB.getByText('FedOwnerA').first()).toBeVisible();

    // Reply propagates back to A's federated view
    const composerB = pageB.locator(
      '[contenteditable="true"]:has(p[data-placeholder^="Message #"])'
    );
    await composerB.fill('ack from B');
    await pageB.keyboard.press('Enter');

    await expect(
      pageA.getByText('ack from B', { exact: true })
    ).toBeVisible({ timeout: 15_000 });
  });

  // fixme: depends on the same flaky federated-channel-load (#5) to reach
  // the author popover, plus the sender-side identity-swap bug (#6). Kept
  // as executable documentation of the cross-instance DM path.
  test.fixme('cross-instance DM reaches the peer', async () => {
    // From A's federated context, open B's author popover and use the
    // inline DM composer
    await pageA.getByText('FedOwnerB').first().click();
    const popover = pageA.locator(
      '[contenteditable="true"]:has(p[data-placeholder^="Message @"])'
    );
    await expect(popover).toBeVisible();
    await popover.fill('cross-instance dm from A');
    await pageA.keyboard.press('Enter');

    // Receipt on B: navigate to Home, open the DM from the federated
    // FedOwnerA, and assert the message text arrived. (The SENDER-side
    // rendering of a fresh federated DM has a separate known identity-swap
    // bug — see the test.fixme below — but the receiver side is correct.)
    await pageB.goto(B_URL);
    await waitForAppReady(pageB);
    await pageB.getByRole('button', { name: 'Home' }).first().click();
    await pageB
      .getByText('FedOwnerA')
      .first()
      .click({ timeout: 15_000 });
    await expect(
      pageB.getByText('cross-instance dm from A', { exact: true })
    ).toBeVisible({ timeout: 15_000 });
  });

  test.fixme(
    'direct navigation into a federated channel with a colliding id loads history',
    async () => {
      // Pins the KNOWN BUG worked around above: select the federated
      // server and click straight into "General Text" (id collides with
      // the local instance's id-1 channel) — history must load without
      // visiting another channel first. Un-fixme once text-channel
      // selection is keyed by publicId like voice channels already are.
    }
  );

  test.fixme(
    "sender's own view of a fresh federated DM shows correct identities",
    async () => {
      // Pins the KNOWN BUG found 2026-07-14: on the sending instance, a
      // just-created federated DM (via profile-popover composer) renders
      // with sender/recipient swapped (sidebar label, author, friend
      // banner) while the receiving side is correct.
    }
  );
});
