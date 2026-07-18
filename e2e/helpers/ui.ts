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

/**
 * Sidebar channel row (a button named after the channel).
 *
 * An unread badge renders INSIDE the button, so its digits merge into the
 * accessible name ("General Text 2" → "General Text 2 3") and a
 * role+exact-name match then fails — exactly when you need to click an
 * unread channel. Match the button by its exact-text name span instead,
 * which the badge doesn't touch.
 */
export function channelButton(page: Page, name: string): Locator {
  return page
    .getByRole('button')
    .filter({ has: page.getByText(name, { exact: true }) })
    .first();
}

export async function selectChannel(page: Page, name: string): Promise<void> {
  const button = channelButton(page, name);
  await expect(button).toBeVisible();
  // Members without the reorder permission (any non-owner, and every
  // federated row) see channel rows with aria-disabled — it's the dnd
  // sortable marker, not a click gate. Force past the actionability
  // check; the explicit visibility assert above keeps the wait.
  await button.click({ force: true });
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
  // 30s (not 20s): with all projects running in parallel the shared host
  // is loaded, and initial WS connect + first data load can lag.
  await expect(
    page.getByRole('button', { name: 'General Text', exact: true }).first()
  ).toBeVisible({ timeout: 30_000 });
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
  ).toBeVisible({ timeout: 30_000 });
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
 * Navigate to the Home view via the left rail.
 *
 * Located by title attribute — the unread badge's TEXT replaces the
 * button's accessible name, so role+name matching breaks whenever unread
 * DMs exist. force: the badge overlays the button and fails the
 * actionability hit-test even though real clicks land fine.
 */
export async function goHome(page: Page): Promise<void> {
  await page
    .locator('button[title="Home"]')
    .filter({ visible: true })
    .first()
    .click({ force: true });
}

/**
 * Open a user's inline DM composer by clicking their name on a channel
 * message, returning the composer scoped to THAT user.
 *
 * Targets the user-specific placeholder (`Message @<name>`), not the
 * generic one: under load the message-author popover can briefly bind to
 * a previously-rendered author, so clicking one name can surface a
 * different user's popover. Retrying past a stale/wrong popover (Escape +
 * re-click) makes the DM-open deterministic instead of silently
 * addressing the wrong recipient.
 */
export async function openDmViaAuthor(
  page: Page,
  displayName: string
): Promise<Locator> {
  const composer = page.locator(
    `[contenteditable="true"]:has(p[data-placeholder="Message @${displayName}"])`
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByText(displayName, { exact: true }).first().click();
    try {
      await expect(composer).toBeVisible({ timeout: 5_000 });
      return composer;
    } catch {
      await page.keyboard.press('Escape');
    }
  }
  await expect(composer).toBeVisible({ timeout: 5_000 });
  return composer;
}

/** DM sidebar rows / DM open: click the entry named after the peer. */
export async function openDmWith(page: Page, name: string): Promise<void> {
  await goHome(page);
  await page.getByText(name).first().click();
  await expect(dmComposer(page)).toBeVisible({ timeout: 15_000 });
}

/** The DM message ROW element (`#dm-msg-<id>`) containing the text. */
export function dmMessageRow(page: Page, text: string): Locator {
  return page.locator('[id^="dm-msg-"]').filter({ hasText: text }).first();
}

/** Send a message in the open DM conversation and wait for round-trip. */
export async function sendDmMessage(page: Page, text: string): Promise<void> {
  const composer = dmComposer(page);
  await composer.click();
  await composer.fill(text);
  // Keyboard send — see sendChannelMessage for the tiptap rationale.
  await page.keyboard.press('Enter');
  await expect(
    page.locator('[id^="dm-msg-"]').getByText(text, { exact: true })
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * Open user settings (bottom-left gear) at the given section. Settings
 * screens close with Escape (useEscapeKey on the server-screens host).
 */
export async function openUserSettings(
  page: Page,
  section: string
): Promise<void> {
  // Two gears exist (desktop + hidden responsive variant).
  await page
    .locator('button[title="User settings"]')
    .filter({ visible: true })
    .first()
    .click();
  await page.getByRole('button', { name: section, exact: true }).click();
}

/** Sonner toast with the given text (they auto-dismiss — assert early). */
export function toast(page: Page, text: string | RegExp): Locator {
  return page.getByText(text).first();
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
