import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Shared locators/actions for the Pulse client. Centralized so a UI
 * change is a one-file fix.
 *
 * First-boot seed channels: "General Text", "General Text 2",
 * "General Voice", "General Voice 2".
 */

/** The main channel composer (tiptap). Placeholder: `Write to #<name>`. */
export function channelComposer(page: Page): Locator {
  return page.locator(
    '[contenteditable="true"]:has(p[data-placeholder^="Write to #"])'
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
  // channelButton, not role+exact-name: an unread badge merges into the
  // accessible name and breaks the exact match on a lived-in instance.
  // 30s (not 20s): with all projects running in parallel the shared host
  // is loaded, and initial WS connect + first data load can lag.
  await expect(channelButton(page, 'General Text')).toBeVisible({
    timeout: 30_000
  });
}

/**
 * Weaker readiness: authenticated into the app shell, but NOT necessarily
 * a member of any server. A freshly registered non-operator lands on the
 * Discover view until they join something — use this to assert "reached
 * the app" without requiring server membership.
 */
export async function waitForAuthedShell(page: Page): Promise<void> {
  // The tab layout (the default) shows a Home tab; the traditional
  // layout a Home rail button.
  await expect(
    page
      .getByRole('tab', { name: 'Home' })
      .or(page.getByRole('button', { name: 'Home' }))
      .first()
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByPlaceholder('you@example.com')).toHaveCount(0);
}

/**
 * The tab layout is on (wide viewport, the default preference). Waits for
 * either shell marker first: a page that has just loaded has neither for
 * a moment, and deciding on an empty page would send the helpers to the
 * wrong layout.
 */
export async function isDeckLayout(page: Page): Promise<boolean> {
  const tab = page.getByRole('tab', { name: 'Home' });
  const rail = page.locator('button[title="Home"]');
  try {
    await expect(tab.or(rail).first()).toBeAttached({ timeout: 15_000 });
  } catch {
    // Neither shell (phone viewport): the callers' classic branch applies.
  }
  return (await tab.count()) > 0;
}

/**
 * Open a user-tray panel (Friends, Messages, Inbox) in the tab layout;
 * a no-op click is avoided when it is already open (the button toggles).
 */
export async function openTrayPanel(
  page: Page,
  label: 'Friends' | 'Messages' | 'Inbox'
): Promise<void> {
  const button = page.getByRole('button', { name: new RegExp(`^${label}(,|$)`) }).first();
  if ((await button.getAttribute('aria-pressed')) !== 'true') {
    await button.click();
  }
  await expect(page.getByRole('complementary', { name: label })).toBeVisible();
}

/** Discover: the rail's compass in the traditional layout, the "Open a community" menu in the tab layout. */
export async function openDiscover(page: Page): Promise<void> {
  if (await isDeckLayout(page)) {
    await page.getByRole('button', { name: 'Open a community' }).click();
    await page.getByRole('menuitem', { name: 'Discover communities' }).click();
    return;
  }
  await page
    .locator('button[title="Discover Servers"]')
    .filter({ visible: true })
    .first()
    .click();
}

/** The DM list: the Messages side panel in the tab layout, the Home view in the traditional one. */
export async function openDmList(page: Page): Promise<void> {
  if (await isDeckLayout(page)) {
    await openTrayPanel(page, 'Messages');
    // The panel remembers the last conversation; the list is one step back.
    const back = page.getByRole('button', { name: 'Back to conversations' });
    if ((await back.count()) > 0) await back.click();
    return;
  }
  await goHome(page);
}

/** A DM list row by the peer's (or group's) name, in whichever layout holds the list. */
export async function dmListRow(page: Page, name: string): Promise<Locator> {
  await openDmList(page);
  const scope = (await isDeckLayout(page))
    ? page.getByRole('complementary', { name: 'Messages' })
    : page;
  return scope.getByText(name).first();
}

/** The Friends view: the Friends tray panel in the tab layout (opened, never toggled shut), Home → Friends in the traditional one. */
export async function openFriends(page: Page): Promise<void> {
  await goHome(page);
  if (await isDeckLayout(page)) {
    await openTrayPanel(page, 'Friends');
    return;
  }
  await page.getByRole('button', { name: 'Friends' }).first().click();
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
  if (await isDeckLayout(page)) {
    await page.getByRole('tab', { name: 'Home' }).click();
    return;
  }
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
/** Resolves once the visible message pane's scroll position has held still. */
export async function waitForPaneSettle(page: Page): Promise<void> {
  const pane = page.locator('[data-testid="message-scroll"]').filter({ visible: true }).first();
  if ((await pane.count()) === 0) return;
  let last = Number.NaN;
  await expect
    .poll(
      async () => {
        const cur = await pane.evaluate((el) => el.scrollTop).catch(() => Number.NaN);
        const stable = cur === last;
        last = cur;
        return stable;
      },
      { timeout: 5_000, intervals: [150, 150, 150, 150] }
    )
    .toBe(true);
}

export async function openDmViaAuthor(
  page: Page,
  displayName: string
): Promise<Locator> {
  const composer = page.locator(
    `[contenteditable="true"]:has(p[data-placeholder="Message @${displayName}"])`
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    // A freshly opened channel is still running its scroll-restore ladder
    // (up to 200 ms after the rows render; on a lived-in stack it lands a
    // new member on the New Messages divider far from the bottom). A click
    // issued while rows are still moving lands on a neighbour, so wait for
    // the pane to hold still first.
    await waitForPaneSettle(page);
    // Prefer the member list when it is open: on phones it is an overlay
    // whose backdrop covers the chat, so the chat author behind it would
    // swallow the click. Both entries open the same profile popover.
    const inMembers = page.locator('aside').getByText(displayName, { exact: true });
    const target = (await inMembers.count())
      ? inMembers.first()
      : page.getByText(displayName, { exact: true }).first();
    await target.click();
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
  if (await isDeckLayout(page)) {
    // DMs live in the Messages side panel: its list, then the conversation.
    await (await dmListRow(page, name)).click();
  } else {
    await goHome(page);
    await page.getByText(name).first().click();
  }
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
  // Two gears exist (desktop + hidden responsive variant); the bottom-left
  // user control carries it in both layouts.
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

/**
 * Open Server Settings (server-name dropdown in the left sidebar) at the
 * given section. Settings navigation is buttons, not tabs.
 */
export async function openServerSettings(
  page: Page,
  section: string
): Promise<void> {
  await page
    .locator('aside')
    .getByRole('button')
    .filter({ hasText: 'Pulse Server' })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await page.getByRole('button', { name: section, exact: true }).click();
}

/**
 * The visible composer regardless of placeholder state. tiptap drops the
 * data-placeholder attribute once the field has content, so the
 * placeholder-scoped locators above stop resolving mid-typing; this one
 * keeps resolving for keyboard-driven input (code blocks, mentions).
 */
export function visibleComposer(page: Page): Locator {
  return page
    .locator('[contenteditable="true"]')
    .filter({ visible: true })
    .first();
}

/**
 * Sidebar voice-roster entries for `name` (every voice channel's rows): a
 * cursor-pointer row carrying the member's name and a mic icon
 * (components/left-sidebar/voice-user.tsx). The member list on the right
 * shows names without a mic icon, so the icon filter keeps the two apart.
 */
export function voiceRosterEntry(page: Page, name: string): Locator {
  return page
    .locator('div.cursor-pointer:has(svg.lucide-mic, svg.lucide-mic-off)')
    .filter({ hasText: name });
}

/** The desktop member list (right sidebar); `w-60` when open, `w-0` closed. */
export function memberList(page: Page): Locator {
  return page.locator('aside.lg\\:bg-sidebar\\/50');
}

/**
 * Open the desktop member list. It is CLOSED by default in a fresh
 * context (RIGHT_SIDEBAR_STATE localStorage) and toggled from the top
 * bar's panel button; idempotent.
 */
export async function openMemberList(page: Page): Promise<void> {
  const list = memberList(page);
  await expect(list).toBeAttached();
  if (!/\bw-60\b/.test((await list.getAttribute('class')) ?? '')) {
    await page
      .locator('.app-topbar button:has(svg.lucide-panel-right)')
      .click();
  }
  await expect(list).toHaveClass(/\bw-60\b/);
}

/**
 * Layout guard (v0.4.0 findings #2/#4/#8/#16): every visible control in
 * `scope` — buttons, inputs, role=button — must lie inside the box of its
 * nearest ancestor that clips (any overflow other than `visible`), and
 * inside the viewport. The failure mode this pins down is a single-line
 * flex row whose items all refuse to shrink: the row grows past its
 * container and the first `overflow-hidden`/`overflow-y-auto` up the tree
 * cuts the last control off silently.
 *
 * A vertical scroller (`overflow-y: auto|scroll`) legitimately holds
 * controls below the fold, so only the horizontal axis is checked against
 * it; a horizontal scroll of a form row is never intended and IS reported.
 * Hidden controls (display:none, visibility:hidden, zero box, aria-hidden
 * subtree) are skipped. Failure messages name each offending control.
 */
export async function expectNoClippedControls(scope: Locator): Promise<void> {
  const offenders = await scope.evaluate((root) => {
    const TOLERANCE = 1.5;
    const CONTROL = 'button, input, [role="button"]';
    const round = (n: number) => Math.round(n);
    const describe = (el: Element) => {
      const html = el as HTMLElement;
      const label =
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('placeholder') ||
        (html.innerText || '').trim().slice(0, 40) ||
        el.id ||
        el.className.toString().slice(0, 40);
      return `${el.tagName.toLowerCase()}[${label}]`;
    };
    const clipping = (el: Element) => {
      const style = getComputedStyle(el);
      return {
        x: style.overflowX !== 'visible',
        y: style.overflowY !== 'visible',
        scrollsY: style.overflowY === 'auto' || style.overflowY === 'scroll'
      };
    };

    const controls = Array.from(root.querySelectorAll<HTMLElement>(CONTROL));
    if (root.matches(CONTROL)) controls.unshift(root as HTMLElement);

    const out: string[] = [];
    for (const el of controls) {
      if (el.closest('[aria-hidden="true"]')) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      // an ancestor with display:none leaves no offsetParent (fixed aside)
      if (el.offsetParent === null && style.position !== 'fixed') continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;

      // A fixed-position control (or one inside a fixed layer such as a
      // dialog) is laid out against the viewport, so an overflow-hidden
      // ancestor in the document flow cannot clip it; only the viewport
      // check below applies.
      let ancestor = el.parentElement;
      let fixedLayer = style.position === 'fixed';
      while (ancestor && ancestor !== document.body && !fixedLayer) {
        if (getComputedStyle(ancestor).position === 'fixed') {
          fixedLayer = true;
          break;
        }
        const clip = clipping(ancestor);
        if (clip.x || clip.y) {
          const a = ancestor.getBoundingClientRect();
          const problems: string[] = [];
          if (clip.x && (box.left < a.left - TOLERANCE || box.right > a.right + TOLERANCE)) {
            problems.push(
              `x ${round(box.left)}–${round(box.right)} outside ${round(a.left)}–${round(a.right)}`
            );
          }
          if (
            clip.y &&
            !clip.scrollsY &&
            (box.top < a.top - TOLERANCE || box.bottom > a.bottom + TOLERANCE)
          ) {
            problems.push(
              `y ${round(box.top)}–${round(box.bottom)} outside ${round(a.top)}–${round(a.bottom)}`
            );
          }
          if (problems.length) {
            out.push(
              `${describe(el)}: ${problems.join('; ')} — clipped by ${describe(ancestor)}`
            );
          }
          break; // the nearest clipping ancestor decides
        }
        ancestor = ancestor.parentElement;
      }

      if (box.left < -TOLERANCE || box.right > window.innerWidth + TOLERANCE) {
        out.push(
          `${describe(el)}: x ${round(box.left)}–${round(box.right)} outside the ${window.innerWidth}px viewport`
        );
      }
    }
    return out;
  });
  expect(offenders, `clipped controls:\n${offenders.join('\n')}`).toEqual([]);
}
