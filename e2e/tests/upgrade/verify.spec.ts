import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fetchInfo } from '../../helpers/api';
import { disableAnimations, selectChannel, waitForAppReady } from '../../helpers/ui';
import {
  journalMigrationCount,
  readMigrationRows,
  readState,
  UPGRADE_BASE,
  UPGRADE_OWNER,
  UPGRADE_PHASE,
  upgradePsql
} from './shared';

/**
 * Upgrade smoke, second half — runs against the FRESHLY BUILT image
 * started on the volumes seed.spec.ts populated under the previous
 * release. Everything an operator expects to survive `docker compose
 * pull && up -d` is asserted here: the process answers, it is the new
 * version, the old credentials log in, the channel/message/upload are
 * still there, and the migrator ran each migration exactly once.
 *
 * Driven by docker/upgrade-smoke.sh; never part of the default run.
 */

test.skip(
  UPGRADE_PHASE !== 'verify',
  'upgrade smoke, verify half — set UPGRADE_PHASE=verify (docker/upgrade-smoke.sh)'
);

/** The version the new image must report: the checkout it was built from. */
function expectedVersion(): string {
  if (process.env.UPGRADE_EXPECT_VERSION) return process.env.UPGRADE_EXPECT_VERSION;
  const pkg = path.join(__dirname, '..', '..', '..', 'apps', 'server', 'package.json');
  return (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version: string }).version;
}

test('the new image serves everything seeded under the old one', async ({
  page
}) => {
  const state = readState();

  // Liveness + identity: the process answers and it IS the new build.
  const health = await page.request.get(`${UPGRADE_BASE}/healthz`);
  expect(health.status()).toBe(200);
  expect(((await health.json()) as { status: string }).status).toBe('ok');

  const info = await fetchInfo(UPGRADE_BASE);
  expect(info.version).toBe(expectedVersion());
  expect(info.version).not.toBe('0.0.0-dev');
  console.log(`[upgrade verify] ${state.oldVersion} -> ${String(info.version)}`);

  // The seeded account logs in through the real form: local-auth rows
  // (password hash, user, membership) survived the swap.
  expect(
    upgradePsql(
      `SELECT count(*) FROM local_auth_users WHERE email = '${UPGRADE_OWNER.email}'`
    )
  ).toBe('1');
  await disableAnimations(page);
  await page.goto(UPGRADE_BASE);
  await page.getByPlaceholder('you@example.com').fill(UPGRADE_OWNER.email);
  await page.getByPlaceholder('Enter your password').fill(UPGRADE_OWNER.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await waitForAppReady(page);

  // Channel + message written under the old image.
  await selectChannel(page, state.channelName);
  await expect(
    page.locator('[id^="msg-"]').getByText(state.messageText, { exact: true })
  ).toBeVisible({ timeout: 15_000 });

  // The upload: its row and its bytes, through the same URL the old
  // image handed out, rendered in the message and served raw.
  const filePath = new URL(state.fileUrl).pathname;
  await expect(page.locator(`img[src*="${filePath}"]`).first()).toBeVisible({
    timeout: 15_000
  });
  const served = await page.request.get(state.fileUrl);
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toContain('image/png');
  expect(served.headers()['content-disposition']).toContain('pixel.png');

  // Migrations: the journal of the checkout under test is fully applied,
  // no migration was recorded twice, the rows the old image wrote are
  // untouched (same id/hash/created_at — nothing re-ran), and whatever
  // the new image added sits strictly after them.
  const rows = readMigrationRows();
  expect(rows.length).toBe(journalMigrationCount());
  expect(new Set(rows.map((r) => r.hash)).size).toBe(rows.length);
  expect(rows.slice(0, state.migrations.length)).toEqual(state.migrations);
  const added = rows.slice(state.migrations.length);
  console.log(
    `[upgrade verify] migrations: ${state.migrations.length} carried over, ${added.length} applied by the new image, ${rows.length} total`
  );
});
