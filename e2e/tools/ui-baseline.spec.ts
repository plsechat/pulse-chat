import { expect, test } from '@playwright/test';
import { mkdirSync } from 'fs';
import { psql } from '../helpers/db';
import { authedPage, CORE_OWNER } from '../helpers/fixtures';
import {
  channelComposer,
  goHome,
  messageRow,
  openDmViaAuthor,
  openMessageContextMenu,
  openUserSettings,
  selectChannel,
  sendDmMessage
} from '../helpers/ui';

/**
 * SCREENSHOT UTILITY — not a test (hence e2e/tools/, project `tools`).
 * Captures the UI-rework baseline/after shots for the design audit. Runs
 * only when UI_SHOTS is set so it can never fire in CI. Seeds
 * visually-rich content via psql, then walks the key surfaces and
 * screenshots each into UI_SHOTS_DIR:
 *   UI_SHOTS=1 UI_SHOTS_DIR=/tmp/ui-shots npx playwright test --project=tools
 */

const BASE = 'http://127.0.0.1:14991';
const OUT = process.env.UI_SHOTS_DIR ?? '/tmp/ui-shots';

test.skip(!process.env.UI_SHOTS, 'screenshot utility, set UI_SHOTS=1');

test('capture UI surfaces', async ({ browser }) => {
  test.setTimeout(600_000);
  const t0 = Date.now();
  const el = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
  mkdirSync(OUT, { recursive: true });

  // ---- seed rich content (idempotent-ish: tagged, re-runs add nothing) ----
  const seeded = psql('core', `SELECT count(*) FROM messages WHERE content LIKE 'uishot:%'`);
  if (seeded === '0') {
    const users = psql('core', `SELECT id, name FROM users ORDER BY id LIMIT 2`)
      .split('\n')
      .map((l) => l.split('|')[0]);
    const [owner, userB] = users;
    const rows = [
      [owner, `hey! welcome to the server 👋`, 55],
      [userB, `thanks! glad to be here`, 52],
      [userB, `this place looks really clean so far`, 51],
      [owner, `check **this** out — \`inline code\`, *italics* and ~~strikethrough~~ all render`, 45],
      [owner, `\`\`\`ts\nconst polish = (ui: Surface) => ui.refine();\npolish(everything);\n\`\`\``, 44],
      [userB, `https://github.com/plsechat/pulse-chat is the repo if anyone wants to contribute`, 38],
      [owner, `let's test reactions on this one`, 30],
      [userB, `Longer message to check wrapping and rhythm: design is not just what it looks like — spacing, alignment and contrast carry most of the perceived quality of an interface, long before color does.`, 20],
      [owner, `uishot: seed marker`, 1]
    ] as const;
    for (const [uid, content, minAgo] of rows) {
      psql('core', `INSERT INTO messages (content, user_id, channel_id, created_at) VALUES ('${String(content).replace(/'/g, "''")}', ${uid}, 1, (extract(epoch from now()) - ${minAgo} * 60) * 1000)`
      );
    }
    const target = psql('core', `SELECT id FROM messages WHERE content = 'let''s test reactions on this one'`);
    for (const [uid, emoji] of [[owner, 'thumbsup'], [userB, 'thumbsup'], [owner, 'tada'], [userB, 'heart']] as const) {
      psql('core', `INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (${target}, ${uid}, '${emoji}', extract(epoch from now()) * 1000)`
      );
    }
  }

  const { context, page } = await authedPage(browser, BASE, CORE_OWNER);
  await page.setViewportSize({ width: 1512, height: 950 });
  page.setDefaultTimeout(10_000);

  const shot = async (name: string, fn?: () => Promise<void>) => {
    try {
      if (fn) await fn();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/${name}.png` });
      console.log(`ok: ${name} @${el()}`);
    } catch (err) {
      console.log(`SKIP ${name} @${el()}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
      await page.keyboard.press('Escape').catch(() => {});
    }
  };

  // 01 — main server view with rich messages
  await shot('01-server-view', async () => {
    await selectChannel(page, 'General Text');
    await expect(messageRow(page, 'reactions on this one')).toBeVisible({ timeout: 15_000 });
  });

  // 02 — message hover (action bar)
  await shot('02-message-hover', async () => {
    await messageRow(page, 'reactions on this one').hover();
  });

  // 03 — reaction pill hover (rich who-reacted card)
  await shot('03-reaction-hover', async () => {
    const pill = messageRow(page, 'reactions on this one').getByRole('button').filter({ hasText: '2' }).first();
    await pill.hover();
    await page.waitForTimeout(600);
  });

  // 04 — context menu
  await shot('04-context-menu', async () => {
    await openMessageContextMenu(page, 'reactions on this one');
  });
  await page.keyboard.press('Escape').catch(() => {});

  // 05 — composer with content
  await shot('05-composer', async () => {
    const composer = channelComposer(page);
    await composer.click();
    await page.keyboard.type('Polishing the **composer** — with `inline code` and long enough text to see the send affordance');
  });
  try {
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Control+a'); await page.keyboard.press('Delete'); }
  } catch { /* non-fatal */ }

  // 06 — search popover
  await shot('06-search', async () => {
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Search messages...').fill('reactions');
    await page.waitForTimeout(1200);
  });
  await page.keyboard.press('Control+k').catch(() => {}); // search: no Esc handler (audit item) — Ctrl+K toggles

  // 07 — author popover
  await shot('07-user-popover', async () => {
    await page.getByText('E2EOwner', { exact: true }).first().click();
    await page.waitForTimeout(400);
  });
  await page.keyboard.press('Escape').catch(() => {});

  // 08 — create channel dialog
  await shot('08-create-channel', async () => {
    await page.locator('button[title="Create channel"]').first().click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });
  await page.keyboard.press('Escape').catch(() => {});

  // 09 — home view, then DM conversation
  await shot('09-home', async () => {
    await goHome(page);
  });
  await shot('09b-dm', async () => {
    await selectChannel(page, 'General Text');
    await openDmViaAuthor(page, 'E2EUserB');
    await sendDmMessage(page, 'DM baseline shot — how does this pane feel?');
    await sendDmMessage(page, 'second message for grouping rhythm');
  });

  // 10 — user settings (appearance)
  await shot('10-user-settings', async () => {
    await openUserSettings(page, 'Appearance');
  });

  // 11 — light theme main view
  await shot('11-light-theme', async () => {
    await page.getByText('Light', { exact: true }).first().click();
    await page.keyboard.press('Escape').catch(() => {});
    await goHome(page);
    await page.waitForTimeout(300);
  });

  // restore dark
  await openUserSettings(page, 'Appearance').catch(() => {});
  await page.getByText('Dark', { exact: true }).first().click().catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});

  await context.close();
});
