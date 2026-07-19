import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page
} from '@playwright/test';
import { loginUser, registerUser } from '../../helpers/api';
import { psql } from '../../helpers/db';
import {
  authedPage,
  CORE_OWNER,
  CORE_USER_B,
  registerAndJoin,
  runUser
} from '../../helpers/fixtures';
import {
  channelButton,
  disableAnimations,
  selectChannel,
  toast,
  waitForAppReady
} from '../../helpers/ui';

/**
 * Invites and roles/permissions. Invite JOIN (a second context actually
 * joining via ?invite=) and live permission gating were both untested —
 * only the invite form's rendering was covered before.
 */

const BASE = 'http://127.0.0.1:14991';
const SERVER_NAME = 'Pulse Server';

let ownerCtx: BrowserContext;
let ownerPage: Page;

/** Open the left-sidebar server-name dropdown and click a menu item. */
async function serverMenu(page: Page, item: string): Promise<void> {
  await page
    .locator('aside')
    .getByRole('button')
    .filter({ hasText: SERVER_NAME })
    .first()
    .click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** Land a freshly-registered (non-member) user on a URL with a fresh session. */
async function openWithSession(
  browser: Browser,
  user: { email: string; password: string },
  path: string
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  const tokens = await loginUser(BASE, user.email, user.password);
  await disableAnimations(page);
  await page.addInitScript(
    ([a, r]) => {
      localStorage.setItem('pulse:auth:access_token', a!);
      localStorage.setItem('pulse:auth:refresh_token', r!);
    },
    [tokens.accessToken, tokens.refreshToken]
  );
  await page.goto(path);
  return { context, page };
}

test.describe('invites and roles', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    ({ context: ownerCtx, page: ownerPage } = await authedPage(
      browser,
      BASE,
      CORE_OWNER
    ));
  });

  test.afterAll(async () => {
    await ownerCtx?.close();
  });

  test('owner creates an invite and a second user joins via ?invite=', async ({
    browser
  }) => {
    const code = `e2einv-join-${Date.now().toString(36)}`;

    await serverMenu(ownerPage, 'Create Invite');
    await expect(
      ownerPage.getByRole('heading', { name: 'Create Server Invite' })
    ).toBeVisible();
    await ownerPage.getByPlaceholder('Invite code').fill(code);
    await ownerPage.getByPlaceholder('Max uses').fill('0'); // unlimited
    await ownerPage.getByRole('button', { name: 'Create Invite' }).click();
    await expect(toast(ownerPage, 'Invite created')).toBeVisible({
      timeout: 15_000
    });

    // Persisted with the exact code and unlimited uses (NULL max_uses).
    await expect
      .poll(
        () =>
          psql('core', `SELECT count(*) FROM invites WHERE code = '${code}'`),
        { timeout: 15_000 }
      )
      .toBe('1');
    expect(
      psql('core', `SELECT max_uses FROM invites WHERE code = '${code}'`)
    ).toBe('');

    // A brand-new user (registered, NOT a member) opens the invite link and
    // is dropped straight into the server — no confirmation screen.
    const joiner = runUser('invite-join');
    await registerUser(BASE, joiner);
    const { context, page } = await openWithSession(
      browser,
      joiner,
      `${BASE}/?invite=${code}`
    );
    try {
      await waitForAppReady(page); // seeded channel list = joined
      // ?invite= is stripped once consumed.
      await expect(page).not.toHaveURL(/invite=/);

      const joinerId = psql(
        'core',
        `SELECT id FROM users WHERE name = '${joiner.displayName}'`
      );
      const serverId = psql(
        'core',
        `SELECT server_id FROM invites WHERE code = '${code}'`
      );
      await expect
        .poll(
          () =>
            psql(
              'core',
              `SELECT count(*) FROM server_members WHERE user_id = ${joinerId} AND server_id = ${serverId}`
            ),
          { timeout: 15_000 }
        )
        .toBe('1');
      expect(
        Number(psql('core', `SELECT uses FROM invites WHERE code = '${code}'`))
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
    }
  });

  test('an expired invite fails to join and grants no membership', async ({
    browser
  }) => {
    const code = `e2einv-exp-${Date.now().toString(36)}`;
    await serverMenu(ownerPage, 'Create Invite');
    await ownerPage.getByPlaceholder('Invite code').fill(code);
    await ownerPage.getByRole('button', { name: 'Create Invite' }).click();
    await expect(toast(ownerPage, 'Invite created')).toBeVisible({
      timeout: 15_000
    });

    // The DatePicker can't create an already-expired invite (minDate=now),
    // so expire it at the DB level — the only host access to the container.
    psql('core', `UPDATE invites SET expires_at = 1 WHERE code = '${code}'`);

    const joiner = runUser('invite-fail');
    await registerUser(BASE, joiner);
    const { context, page } = await openWithSession(
      browser,
      joiner,
      `${BASE}/?invite=${code}`
    );
    try {
      // The authenticated ?invite= path surfaces only the generic toast.
      await expect(toast(page, 'Failed to join server')).toBeVisible({
        timeout: 15_000
      });
      // Still a non-member: no seeded channel list, no membership row.
      // Badge-immune absence check — an exact-name match would also
      // resolve to 0 for a MEMBER whose row carries an unread badge.
      await expect(
        page
          .getByRole('button')
          .filter({ has: page.getByText('General Text', { exact: true }) })
      ).toHaveCount(0);
      const joinerId = psql(
        'core',
        `SELECT id FROM users WHERE name = '${joiner.displayName}'`
      );
      expect(
        psql(
          'core',
          `SELECT count(*) FROM server_members WHERE user_id = ${joinerId}`
        )
      ).toBe('0');
    } finally {
      await context.close();
    }
  });

  test('owner creates a role and a permission toggle persists', async () => {
    const roleName = `e2erole-${Date.now().toString(36)}`;

    // A previous run that died between create and rename leaves a literal
    // "New Role" behind; on a long-lived stack these accumulate and trip
    // the strict-mode locator below. Clear them first (CI starts fresh).
    for (const table of [
      'user_roles',
      'role_permissions',
      'channel_role_permissions'
    ]) {
      psql(
        'core',
        `DELETE FROM ${table} WHERE role_id IN (SELECT id FROM roles WHERE name = 'New Role')`
      );
    }
    psql('core', `DELETE FROM roles WHERE name = 'New Role'`);

    await serverMenu(ownerPage, 'Server Settings');
    await ownerPage.getByRole('tab', { name: 'Roles' }).click();

    // The Plus in the Roles card header creates a role immediately ("New
    // Role"). Scope to the card header — a bare plus-icon filter also
    // matches the left rail's "Create Server" button.
    await ownerPage
      .locator('div.flex.items-center.justify-between')
      .filter({ hasText: 'Roles' })
      .filter({ has: ownerPage.locator('svg.lucide-plus') })
      .getByRole('button')
      .first()
      .click();
    await expect(toast(ownerPage, 'Role created')).toBeVisible({
      timeout: 15_000
    });

    // Rename and grant one permission.
    await ownerPage.getByRole('button', { name: 'New Role' }).click();
    const nameInput = ownerPage.locator('input[value="New Role"]').first();
    await nameInput.fill(roleName);
    await ownerPage
      .locator('div.flex.items-center.justify-between')
      .filter({ hasText: 'Manage messages' })
      .getByRole('switch')
      .click();
    await ownerPage.getByRole('button', { name: 'Save Role' }).click();
    await expect(toast(ownerPage, 'Role updated')).toBeVisible({
      timeout: 15_000
    });

    // Row + the granted permission both landed.
    const roleId = psql(
      'core',
      `SELECT id FROM roles WHERE name = '${roleName}' ORDER BY id DESC LIMIT 1`
    );
    expect(roleId).not.toBe('');
    await expect
      .poll(
        () =>
          psql(
            'core',
            `SELECT count(*) FROM role_permissions WHERE role_id = ${roleId} AND permission = 'MANAGE_MESSAGES'`
          ),
        { timeout: 15_000 }
      )
      .toBe('1');

    // Clean up the role so reruns don't accumulate "New Role" leftovers.
    // The trash lives in the Edit Role card header (icon-only, no name).
    await ownerPage
      .locator('button:has(svg.lucide-trash-2)')
      .first()
      .click();
    await ownerPage.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(toast(ownerPage, 'Role deleted')).toBeVisible({
      timeout: 15_000
    });
    await ownerPage.keyboard.press('Escape');
  });

  test('making a channel private hides it from a non-owner live', async ({
    browser
  }) => {
    // A dedicated channel so the shared seeded ones stay public for other
    // specs. userB is a joined member; bring them online in a 2nd context.
    await registerAndJoin(browser, BASE, CORE_USER_B);
    const { context: bCtx, page: bPage } = await authedPage(
      browser,
      BASE,
      CORE_USER_B
    );

    const chan = `priv-${Date.now().toString(36)}`;
    try {
      // Owner creates the channel via the category "Create channel" control.
      await ownerPage
        .locator('button[title="Create channel"]')
        .first()
        .click();
      await expect(
        ownerPage.getByRole('heading', { name: 'Create New Channel' })
      ).toBeVisible();
      await ownerPage.getByPlaceholder('Channel name').fill(chan);
      await ownerPage.getByRole('button', { name: 'Create channel' }).click();

      // The non-owner sees the public channel appear live.
      await expect(channelButton(bPage, chan)).toBeVisible({ timeout: 15_000 });

      // Owner marks it private (no overrides → nobody but the owner keeps
      // VIEW_CHANNEL).
      await ownerPage.getByRole('button', { name: chan, exact: true }).first().click({ force: true });
      await selectChannel(ownerPage, chan);
      await ownerPage
        .getByRole('button', { name: chan, exact: true })
        .first()
        .click({ button: 'right', force: true });
      await ownerPage.getByRole('menuitem', { name: 'Edit' }).click();
      await expect(
        ownerPage.getByRole('heading', { name: 'Channel Settings' })
      ).toBeVisible();
      await ownerPage
        .locator('div')
        .filter({ hasText: /^Private/ })
        .getByRole('switch')
        .first()
        .click();
      await ownerPage.getByRole('button', { name: 'Save Changes' }).click();

      // It disappears from the non-owner's sidebar with NO refresh...
      await expect(channelButton(bPage, chan)).toHaveCount(0, {
        timeout: 15_000
      });
      // ...while the owner still sees it (owner bypasses channel gating).
      await ownerPage.keyboard.press('Escape');
      await expect(
        ownerPage.getByRole('button', { name: chan, exact: true }).first()
      ).toBeVisible();
    } finally {
      await bCtx.close();
    }
  });
});
