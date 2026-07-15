import { expect, test as setup } from '@playwright/test';
import { loginUser, registerUser, storageStateFor } from '../../helpers/api';
import { waitForAppReady } from '../../helpers/ui';

/**
 * One-time setup for the `core` project:
 *  - registers the operator (first registration) and a second user
 *  - drives the second user through joining the default server via the
 *    UI, so they appear in the operator's member list (the DM specs open
 *    a conversation from there). A fresh registrant lands on Discover,
 *    not auto-joined.
 *
 * Idempotent: re-registration failures fall back to login; the join is a
 * no-op if already a member.
 */

const BASE = 'http://127.0.0.1:14991';

export const CORE_OWNER = {
  email: 'owner@e2e.local',
  password: 'e2e-password-1234',
  displayName: 'E2EOwner'
};

export const CORE_USER_B = {
  email: 'userb@e2e.local',
  password: 'e2e-password-1234',
  displayName: 'E2EUserB'
};

setup('register core users and join the default server', async ({
  browser
}) => {
  // Operator first (becomes the server owner).
  try {
    await registerUser(BASE, CORE_OWNER);
  } catch {
    /* already registered */
  }

  let tokensB;
  try {
    tokensB = await registerUser(BASE, CORE_USER_B);
  } catch {
    tokensB = await loginUser(BASE, CORE_USER_B.email, CORE_USER_B.password);
  }

  // userB joins the default server through the UI.
  const context = await browser.newContext({
    storageState: storageStateFor(BASE, tokensB),
    baseURL: BASE
  });
  const page = await context.newPage();
  await page.goto(BASE);

  const generalText = page
    .getByRole('button', { name: 'General Text', exact: true })
    .first();
  const joinButton = page.getByRole('button', { name: /^join$/i }).first();

  // Wait for the app to settle into ONE of the two states before
  // branching — isVisible() doesn't wait, so checking too early would
  // false-negative and click a Join button that isn't there yet.
  await expect(generalText.or(joinButton)).toBeVisible({ timeout: 20_000 });

  if (!(await generalText.isVisible())) {
    // On the Discover view: join "Pulse Server".
    await joinButton.click();
    await waitForAppReady(page);
  }

  await context.close();
});
