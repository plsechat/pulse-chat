import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { loginUser, registerUser, storageStateFor } from './api';
import { authedGoto, waitForAppReady } from './ui';

export type TSeedUser = {
  email: string;
  password: string;
  displayName: string;
};

/**
 * The two stable accounts the `core` project shares (registered once by
 * core.setup.ts). CORE_OWNER is the operator/server owner (first
 * registration); CORE_USER_B is a joined non-owner member. Reused by
 * specs that need a known member without minting a fresh one.
 */
export const CORE_OWNER: TSeedUser = {
  email: 'owner@e2e.local',
  password: 'e2e-password-1234',
  displayName: 'E2EOwner'
};

export const CORE_USER_B: TSeedUser = {
  email: 'userb@e2e.local',
  password: 'e2e-password-1234',
  displayName: 'E2EUserB'
};

/**
 * Per-run unique suffix. Display names are globally unique on an
 * instance, so reruns against a live env collide without this.
 */
export const RUN_TAG = Date.now().toString(36);

/** A per-run unique throwaway user. */
export function runUser(prefix: string): TSeedUser {
  return {
    email: `${prefix}-${RUN_TAG}@e2e.local`,
    password: 'e2e-password-1234',
    displayName: `${prefix}-${RUN_TAG}`
  };
}

/**
 * Register a user via HTTP and make them a member of the default server
 * by driving the Discover → Join UI once (membership is a tRPC-over-WS
 * flow — there is no plain-HTTP fixture for it). Idempotent: falls back
 * to login, and skips the join when the channel list is already there.
 */
export async function registerAndJoin(
  browser: Browser,
  baseURL: string,
  user: TSeedUser
): Promise<void> {
  let tokens;
  try {
    tokens = await registerUser(baseURL, user);
  } catch {
    tokens = await loginUser(baseURL, user.email, user.password);
  }

  const context = await browser.newContext({
    storageState: storageStateFor(baseURL, tokens),
    baseURL
  });
  const page = await context.newPage();
  await page.goto(baseURL);

  const generalText = page
    .getByRole('button', { name: 'General Text', exact: true })
    .first();
  const joinButton = page.getByRole('button', { name: /^join$/i }).first();
  // Wait for ONE of the two states before branching — isVisible() doesn't
  // wait, so checking too early would false-negative.
  await expect(generalText.or(joinButton)).toBeVisible({ timeout: 20_000 });
  if (!(await generalText.isVisible())) {
    await joinButton.click();
    await waitForAppReady(page);
  }
  await context.close();
}

/**
 * A fresh context + page authenticated as the given user (per-context API
 * login — refresh tokens are one-time-use, so storageState can't be
 * shared). Caller owns the context and must close it.
 */
export async function authedPage(
  browser: Browser,
  baseURL: string,
  user: TSeedUser
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await authedGoto(page, baseURL, user.email, user.password);
  return { context, page };
}
