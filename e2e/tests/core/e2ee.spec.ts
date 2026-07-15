import {
  expect,
  test,
  type BrowserContext,
  type Page
} from '@playwright/test';
import { psql } from '../../helpers/db';
import { authedPage, registerAndJoin, runUser } from '../../helpers/fixtures';
import {
  dmComposer,
  dmMessageRow,
  goHome,
  openDmViaAuthor,
  openDmWith,
  openUserSettings,
  selectChannel,
  sendChannelMessage,
  sendDmMessage,
  toast
} from '../../helpers/ui';

/**
 * E2EE DM flows — the pillar with the worst shipping record (restore
 * break, multi-device break, plaintext-downgrade, image copy). Serial:
 * later tests build on the encrypted channel + pinned identities the
 * earlier ones establish.
 *
 * Uses per-run throwaway users, NOT the shared owner/userB pair:
 * encryption enable is one-way, and an encrypted owner↔userB DM would
 * contaminate every other spec that expects plaintext DMs.
 */

const BASE = 'http://127.0.0.1:14991';

const USER_A = runUser('e2ee-a');
const USER_B = runUser('e2ee-b');

const SEED_MSG = `e2ee seed ${USER_A.displayName}`;
const DM_HELLO = `plaintext hello ${USER_A.displayName}`;
const SECRET_A = `secret-from-a ${USER_A.displayName}`;
const SECRET_B = `secret-from-b ${USER_A.displayName}`;
const POST_RESET_MSG = `post-reset ${USER_A.displayName}`;
const PASSPHRASE = 'backup-passphrase-1234';

let ctxA: BrowserContext;
let ctxB: BrowserContext;
let pageA: Page;
let pageB: Page;
let identityKeyBefore = '';
let dmChannelId = '';

function identityKeyOf(displayName: string): string {
  return psql(
    'core',
    `SELECT identity_public_key FROM user_identity_keys k JOIN users u ON u.id = k.user_id WHERE u.name = '${displayName}'`
  );
}

/**
 * The peer row on the Verify Identity page. The settings screen is a
 * partial overlay — the DM sidebar row shares the peer's accessible
 * name and sits earlier in the DOM, so scope by the row's "Pinned"
 * subtitle instead of taking .first().
 */
function pinnedPeerRow(page: Page, name: string) {
  return page
    .getByRole('button')
    .filter({ hasText: name })
    .filter({ hasText: 'Pinned' })
    .first();
}

/** The 60-digit safety number on the Verify Identity detail view. */
async function readSafetyNumber(page: Page): Promise<string> {
  let digits = '';
  await expect
    .poll(
      async () => {
        const monos = page.locator('.font-mono');
        const n = await monos.count();
        for (let i = 0; i < n; i++) {
          const t = (await monos.nth(i).innerText()).replace(/\D/g, '');
          if (t.length === 60) {
            digits = t;
            return 60;
          }
        }
        return 0;
      },
      { timeout: 15_000 }
    )
    .toBe(60);
  return digits;
}

test.describe('E2EE direct messages', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    await registerAndJoin(browser, BASE, USER_A);
    await registerAndJoin(browser, BASE, USER_B);
    ({ context: ctxA, page: pageA } = await authedPage(browser, BASE, USER_A));
    ({ context: ctxB, page: pageB } = await authedPage(browser, BASE, USER_B));

    // Key regeneration confirms via a NATIVE window.confirm — the only
    // native dialog in the app. A regenerates on pageA in two tests, so
    // register the auto-accept ONCE here (a per-test handler would stack
    // and the second accept() throws "already handled").
    pageA.on('dialog', (d) => void d.accept());
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('fresh pair establishes a DM through the author popover', async () => {
    // B posts in the shared channel so A has an author name to click.
    await selectChannel(pageB, 'General Text');
    await sendChannelMessage(pageB, SEED_MSG);

    await selectChannel(pageA, 'General Text');
    await expect(
      pageA.getByText(SEED_MSG, { exact: true })
    ).toBeVisible({ timeout: 15_000 });

    // UserPopover inline composer → auto-navigates into the new DM.
    const popoverComposer = await openDmViaAuthor(pageA, USER_B.displayName);
    await popoverComposer.fill(DM_HELLO);
    await pageA.keyboard.press('Enter');
    await expect(
      pageA.locator(
        `[contenteditable="true"]:has(p[data-placeholder="Message @${USER_B.displayName}"])`
      )
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      pageA.locator('[id^="dm-msg-"]').getByText(DM_HELLO, { exact: true })
    ).toBeVisible();

    await openDmWith(pageB, USER_A.displayName);
    await expect(
      pageB.locator('[id^="dm-msg-"]').getByText(DM_HELLO, { exact: true })
    ).toBeVisible({ timeout: 15_000 });
  });

  test('both users register encryption keys from Settings', async () => {
    for (const page of [pageA, pageB]) {
      await openUserSettings(page, 'Encryption');
      await expect(
        page.getByText('No encryption keys found on this device')
      ).toBeVisible();
      await page.getByRole('button', { name: 'Generate Keys' }).click();
      await expect(toast(page, 'Keys generated successfully')).toBeVisible({
        timeout: 15_000
      });
      await expect(
        page.getByText('End-to-end encryption keys are registered')
      ).toBeVisible();
      await page.keyboard.press('Escape');
    }

    for (const user of [USER_A, USER_B]) {
      expect(identityKeyOf(user.displayName)).not.toBe('');
    }
    identityKeyBefore = identityKeyOf(USER_A.displayName);
  });

  test('enable encryption: ciphertext at rest, live decrypt both ways', async () => {
    await goHome(pageA);
    await pageA
      .getByText(USER_B.displayName)
      .first()
      .click({ button: 'right' });
    await pageA
      .getByRole('menuitem', { name: 'Enable Encryption' })
      .click();
    await expect(
      pageA.getByText(
        'This will enable end-to-end encryption for this conversation.',
        { exact: false }
      )
    ).toBeVisible();
    await pageA.getByRole('button', { name: 'Enable', exact: true }).click();
    await expect(toast(pageA, 'Encryption enabled')).toBeVisible({
      timeout: 15_000
    });

    // Exchange encrypted messages in both directions.
    await openDmWith(pageA, USER_B.displayName);
    await sendDmMessage(pageA, SECRET_A);
    // Per-message lock icon marks the row as encrypted.
    await expect(
      dmMessageRow(pageA, SECRET_A).locator('svg.lucide-lock')
    ).toBeVisible();

    await expect(
      pageB.locator('[id^="dm-msg-"]').getByText(SECRET_A, { exact: true })
    ).toBeVisible({ timeout: 15_000 });
    await sendDmMessage(pageB, SECRET_B);
    await expect(
      pageA.locator('[id^="dm-msg-"]').getByText(SECRET_B, { exact: true })
    ).toBeVisible({ timeout: 15_000 });

    // At-rest assertions: the plaintext appears NOWHERE in the database,
    // while the pre-encryption control message is stored verbatim.
    expect(
      psql(
        'core',
        `SELECT count(*) FROM dm_messages WHERE content LIKE '%${SECRET_A}%' OR content LIKE '%${SECRET_B}%'`
      )
    ).toBe('0');
    expect(
      psql('core', `SELECT count(*) FROM dm_messages WHERE content = '${DM_HELLO}'`)
    ).toBe('1');

    dmChannelId = psql(
      'core',
      `SELECT dm_channel_id FROM dm_messages WHERE content = '${DM_HELLO}'`
    );
    expect(
      psql('core', `SELECT e2ee FROM dm_channels WHERE id = ${dmChannelId}`)
    ).toBe('t');
    // 1:1 pairwise wire format is the libsignal JSON envelope.
    expect(
      psql(
        'core',
        `SELECT count(*) FROM dm_messages WHERE dm_channel_id = ${dmChannelId} AND e2ee = true`
      )
    ).toBe('2');
    expect(
      psql(
        'core',
        `SELECT count(*) FROM dm_messages WHERE dm_channel_id = ${dmChannelId} AND e2ee = true AND content NOT LIKE '{"type":%'`
      )
    ).toBe('0');

    // Idempotency: the menu no longer offers Enable Encryption.
    await pageA
      .getByText(USER_B.displayName)
      .first()
      .click({ button: 'right' });
    await expect(
      pageA.getByRole('menuitem', { name: 'Leave Conversation' })
    ).toBeVisible();
    await expect(
      pageA.getByRole('menuitem', { name: 'Enable Encryption' })
    ).toHaveCount(0);
    await pageA.keyboard.press('Escape');
  });

  test('safety numbers match across devices; manual verification pins', async () => {
    await openUserSettings(pageA, 'Verify Identity');
    await pinnedPeerRow(pageA, USER_B.displayName).click();
    const numberOnA = await readSafetyNumber(pageA);

    await openUserSettings(pageB, 'Verify Identity');
    await pinnedPeerRow(pageB, USER_A.displayName).click();
    const numberOnB = await readSafetyNumber(pageB);

    // The safety number is a property of the PAIR — identical on both.
    expect(numberOnA).toBe(numberOnB);

    for (const page of [pageA, pageB]) {
      await page.getByRole('button', { name: 'Mark as verified' }).click();
      await expect(toast(page, /Marked .* as verified/)).toBeVisible();
      await page.keyboard.press('Escape');
    }

    // The DM header badge upgrades to the verified shield.
    await openDmWith(pageA, USER_B.displayName);
    await expect(
      pageA.locator('svg.lucide-shield-check').first()
    ).toBeVisible();
  });

  test('key backup restores decryption on a fresh device (44b294b regression)', async ({
    browser
  }) => {
    await openUserSettings(pageA, 'Encryption');
    await pageA
      .getByPlaceholder('Passphrase (min. 8 characters)')
      .first()
      .fill(PASSPHRASE);
    await pageA.getByPlaceholder('Confirm passphrase').first().fill(PASSPHRASE);
    await pageA.getByRole('button', { name: 'Back Up to Server' }).click();
    await expect(toast(pageA, 'Keys backed up to server')).toBeVisible({
      timeout: 15_000
    });
    await pageA.keyboard.press('Escape');

    expect(
      psql(
        'core',
        `SELECT count(*) FROM user_key_backups k JOIN users u ON u.id = k.user_id WHERE u.name = '${USER_A.displayName}'`
      )
    ).toBe('1');

    // Fresh device: no local keys → encrypted history is unreadable.
    const { context: ctxA2, page: pageA2 } = await authedPage(
      browser,
      BASE,
      USER_A
    );
    try {
      await openDmWith(pageA2, USER_B.displayName);
      await expect(
        pageA2.getByText('Unable to decrypt this message').first()
      ).toBeVisible({ timeout: 15_000 });

      await openUserSettings(pageA2, 'Encryption');
      await expect(
        pageA2.getByText(/Server backup exists/)
      ).toBeVisible({ timeout: 15_000 });
      // First 'Backup passphrase' input is the Restore section (the
      // Import section reuses the placeholder further down).
      await pageA2.getByPlaceholder('Backup passphrase').first().fill(PASSPHRASE);
      await pageA2
        .getByRole('button', { name: 'Restore from Server' })
        .click();
      await expect(toast(pageA2, 'Keys restored from server')).toBeVisible({
        timeout: 15_000
      });

      // What restore PROMISES (44b294b + finalizeRestoredKeys):
      // identity continuity, not history recovery. Sessions are wiped
      // and rebuilt by design (forward secrecy — the plaintext cache is
      // deliberately excluded from the backup), so old pairwise
      // messages stay unreadable on the new device...
      await pageA2.reload();
      await openDmWith(pageA2, USER_B.displayName);
      await expect(
        pageA2.getByText('Unable to decrypt this message').first()
      ).toBeVisible({ timeout: 15_000 });
      // ...but the manual-verification pin survives the round-trip...
      await expect(
        pageA2.locator('svg.lucide-shield-check').first()
      ).toBeVisible();
      // ...the server identity did NOT rotate...
      expect(identityKeyOf(USER_A.displayName)).toBe(identityKeyBefore);
      // ...and messaging continues in both directions with NO
      // identity-changed alarm on the peer (the actual 44b294b bug:
      // restore left the server on the regen identity, breaking
      // decryption both ways).
      const restoredMsg = `post-restore ${USER_A.displayName}`;
      const restoredReply = `post-restore-reply ${USER_A.displayName}`;
      await openDmWith(pageB, USER_A.displayName);
      await sendDmMessage(pageA2, restoredMsg);
      await expect(
        pageB.locator('[id^="dm-msg-"]').getByText(restoredMsg, { exact: true })
      ).toBeVisible({ timeout: 15_000 });
      await expect(pageB.getByText(/identity has changed/)).toHaveCount(0);
      await expect(
        pageB.getByText(/encryption keys have changed/)
      ).toHaveCount(0);
      await sendDmMessage(pageB, restoredReply);
      await expect(
        pageA2
          .locator('[id^="dm-msg-"]')
          .getByText(restoredReply, { exact: true })
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await ctxA2.close();
    }
  });

  test('identity reset (online peer): system message, silent re-pin, messaging continues', async () => {
    // B watches the conversation live, so B RECEIVES the reset broadcast.
    await openDmWith(pageB, USER_A.displayName);

    // A regenerates keys on their live device (Settings › Encryption).
    await openUserSettings(pageA, 'Encryption');
    await pageA.getByRole('button', { name: 'Regenerate Keys' }).click();
    await expect(toast(pageA, 'Keys regenerated successfully')).toBeVisible({
      timeout: 15_000
    });
    await pageA.keyboard.press('Escape');

    // The rotation actually took server-side.
    await expect
      .poll(() => identityKeyOf(USER_A.displayName), { timeout: 15_000 })
      .not.toBe(identityKeyBefore);

    // B sees the system message land live in the open DM.
    await expect(
      pageB.getByText(/encryption keys have changed/).first()
    ).toBeVisible({ timeout: 15_000 });

    // Because B processed the live reset broadcast, handlePeerIdentityReset
    // re-pinned A's new identity silently — B's next send goes through with
    // NO identity-changed dialog and messaging continues both ways.
    await sendDmMessage(pageB, POST_RESET_MSG);
    await expect(pageB.getByText(/identity has changed/)).toHaveCount(0);
    await openDmWith(pageA, USER_B.displayName);
    await expect(
      pageA.locator('[id^="dm-msg-"]').getByText(POST_RESET_MSG, { exact: true })
    ).toBeVisible({ timeout: 15_000 });

    // The reset was journaled into the encrypted channel as a system
    // message (rendered to both members).
    expect(
      Number(
        psql(
          'core',
          `SELECT count(*) FROM dm_messages WHERE content = 'identity_reset' AND dm_channel_id = ${dmChannelId}`
        )
      )
    ).toBeGreaterThanOrEqual(1);
  });

  /**
   * The identity-changed modal is the attack-detection surface — it fires
   * only when a peer's key changes WITHOUT an accompanying reset event (a
   * malicious server swapping keys). We could not trigger it deterministically
   * through the client UI, and confirmed WHY empirically:
   *
   *  - A legitimate rotation always emits E2EE_IDENTITY_RESET. Any peer that
   *    is online — OR that reconnects and re-subscribes — re-receives it
   *    through the `e2ee.onIdentityReset` subscription (subscriptions.ts:94)
   *    and `handlePeerIdentityReset` (index.ts:1394) silently re-pins the new
   *    identity BEFORE the next send, so `buildSession`'s pin check never
   *    trips. Dropping the WS and clearing B's Signal session both failed to
   *    reach the dialog for this reason (the subscription re-delivers on
   *    reconnect; reload re-decrypts history which re-establishes state).
   *  - The only remaining trigger is a server that returns a different
   *    identity key from getPreKeyBundle with no reset event — i.e. a
   *    genuinely hostile server. The e2e harness runs the real server, which
   *    doesn't do that.
   *
   * The online reset path (system message + silent re-pin + continued
   * messaging) is covered by the preceding test. The dialog dispatch logic
   * itself lives in lib/e2ee/identity-change-dispatch.ts (presentIdentityChange,
   * single-modal collapse) and warrants a focused client unit test with a
   * mocked store rather than a full-stack e2e.
   */
  test.fixme(
    'identity change dialog fires on an unannounced key swap (needs a hostile-server harness)',
    () => {}
  );
});
