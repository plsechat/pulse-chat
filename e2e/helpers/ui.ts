import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Shared locators/actions for the Pulse client. Centralized so a UI
 * change is a one-file fix.
 *
 * First-boot seed channels: "General Text", "General Text 2",
 * "General Voice", "General Voice 2".
 */

/** The main channel composer (tiptap). Placeholder: `Message #<name>`. */
export function channelComposer(page: Page): Locator {
  return page.locator(
    '[contenteditable="true"]:has(p[data-placeholder^="Message #"])'
  );
}

/** The DM conversation composer. Placeholder: `Message @<name>`. */
export function dmComposer(page: Page): Locator {
  return page.locator(
    '[contenteditable="true"]:has(p[data-placeholder^="Message @"])'
  );
}

/** Sidebar channel row (rendered as a button named after the channel). */
export function channelButton(page: Page, name: string): Locator {
  return page.getByRole('button', { name, exact: true }).first();
}

export async function selectChannel(page: Page, name: string): Promise<void> {
  await channelButton(page, name).click();
}

export async function sendChannelMessage(
  page: Page,
  text: string
): Promise<void> {
  const composer = channelComposer(page);
  await composer.click();
  await composer.fill(text);
  // Send via the keyboard, not composer.press: tiptap drops the
  // data-placeholder attribute once the field has content, so the
  // placeholder-based locator no longer resolves after fill(). The field
  // keeps focus, so a keyboard Enter reaches it.
  await page.keyboard.press('Enter');
  // The sent message must render back in the pane (round-trip through
  // the server, not just local echo clearing the input).
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}

/** A rendered message row containing the given text. */
export function messageWithText(page: Page, text: string): Locator {
  return page.getByText(text, { exact: true }).first();
}

/**
 * The message ROW element (`#msg-<id>`) containing the given text. This
 * is the context-menu trigger and the hover-action-bar owner — right-
 * clicking the bare text span does NOT open the Radix context menu, but
 * the row does.
 */
export function messageRow(page: Page, text: string): Locator {
  return page.locator('[id^="msg-"]').filter({ hasText: text }).first();
}

/** Right-click a message row and wait for its Radix context menu. */
export async function openMessageContextMenu(
  page: Page,
  text: string
): Promise<void> {
  await messageRow(page, text).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Reply' })).toBeVisible();
}

export async function waitForAppReady(page: Page): Promise<void> {
  // The left sidebar's seeded channel list is the "logged in AND a member
  // of the default server" signal — only renders after WS connect + join.
  // Role-scoped: the bare text also matches top-bar titles.
  await expect(
    page.getByRole('button', { name: 'General Text', exact: true }).first()
  ).toBeVisible({ timeout: 20_000 });
}

/**
 * Weaker readiness: authenticated into the app shell, but NOT necessarily
 * a member of any server. A freshly registered non-operator lands on the
 * Discover view until they join something — use this to assert "reached
 * the app" without requiring server membership.
 */
export async function waitForAuthedShell(page: Page): Promise<void> {
  await expect(
    page.getByRole('button', { name: 'Home' }).first()
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByPlaceholder('you@example.com')).toHaveCount(0);
}

/**
 * Kill CSS animations/transitions for the whole page. Radix overlays
 * (context menus, popovers) use enter animations that never satisfy
 * Playwright's click-stability check — the element is perpetually "not
 * stable" and clicks time out even though it's visible. Call before the
 * first navigation so the injected rule is present on every document.
 */
export async function disableAnimations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent =
      '*,*::before,*::after{animation-duration:0s !important;animation-delay:0s !important;transition-duration:0s !important;transition-delay:0s !important;}';
    // Run when the document element exists.
    const attach = () => document.documentElement.appendChild(style);
    if (document.documentElement) attach();
    else document.addEventListener('DOMContentLoaded', attach);
  });
}

export async function gotoApp(page: Page, url = '/'): Promise<void> {
  await disableAnimations(page);
  await page.goto(url);
  await waitForAppReady(page);
}

/**
 * Authenticate a page with a FRESH session and land in the app.
 *
 * Why not a shared storageState file: refresh tokens are one-time-use
 * (rotation with jti tracking), so a storage state captured once goes
 * stale as soon as any context consumes it — later contexts land on the
 * login screen. A per-test API login costs one POST and is immune.
 */
export async function authedGoto(
  page: Page,
  baseURL: string,
  email: string,
  password: string
): Promise<void> {
  const { loginUser } = await import('./api');
  const tokens = await loginUser(baseURL, email, password);
  await disableAnimations(page);
  await page.addInitScript(
    ([a, r]) => {
      localStorage.setItem('pulse:auth:access_token', a!);
      localStorage.setItem('pulse:auth:refresh_token', r!);
    },
    [tokens.accessToken, tokens.refreshToken]
  );
  await page.goto(baseURL);
  await waitForAppReady(page);
}
