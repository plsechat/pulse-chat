import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fetchInfo, loginUser, registerUser } from '../../helpers/api';
import { RUN_TAG } from '../../helpers/fixtures';
import {
  authedGoto,
  channelButton,
  channelComposer,
  selectChannel,
  sendChannelMessage
} from '../../helpers/ui';
import {
  readMigrationRows,
  UPGRADE_BASE,
  UPGRADE_OWNER,
  UPGRADE_PHASE,
  writeState
} from './shared';

/**
 * Upgrade smoke, first half — runs against the PREVIOUS release image
 * booted on fresh volumes (docker/compose.upgrade.yml). Creates the data
 * an operator would have on disk the night before an upgrade and records
 * what verify.spec.ts must find after the image swap.
 *
 * Driven by docker/upgrade-smoke.sh; never part of the default run.
 */

test.skip(
  UPGRADE_PHASE !== 'seed',
  'upgrade smoke, seed half — set UPGRADE_PHASE=seed (docker/upgrade-smoke.sh)'
);

const FIXTURE_PNG = path.join(__dirname, '..', '..', 'fixtures', 'pixel.png');

test('seed the old image: owner, channel, message, upload', async ({
  page
}) => {
  const info = await fetchInfo(UPGRADE_BASE);
  const oldVersion = String(info.version);
  expect(oldVersion).toMatch(/^\d+\.\d+\.\d+/);
  expect(info.passwordLoginEnabled).toBe(true);

  // First registration on the fresh instance = operator (server owner).
  // Login fallback only matters when the stack was kept between runs.
  try {
    await registerUser(UPGRADE_BASE, UPGRADE_OWNER);
  } catch {
    await loginUser(UPGRADE_BASE, UPGRADE_OWNER.email, UPGRADE_OWNER.password);
  }
  await authedGoto(page, UPGRADE_BASE, UPGRADE_OWNER.email, UPGRADE_OWNER.password);

  // A dedicated channel: the verify half must find it by name, so the
  // seeded ones (which the new image would re-create anyway) prove
  // nothing.
  const channelName = `upgrade-${RUN_TAG}`;
  const dialog = page.getByRole('dialog');
  const dialogHeading = dialog.getByRole('heading', { name: 'Create New Channel' });
  await expect(async () => {
    await page.locator('button[title="Create channel"]').first().click();
    await expect(dialogHeading).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  await dialog.getByPlaceholder('Channel name').fill(channelName);
  await dialog.getByRole('button', { name: 'Create channel' }).click();
  await expect(channelButton(page, channelName)).toBeVisible({ timeout: 15_000 });
  await selectChannel(page, channelName);

  const messageText = `upgrade-${RUN_TAG} written before the upgrade`;
  await sendChannelMessage(page, messageText);

  // An attachment: the stored file lives in the data volume, its row in
  // postgres — both must line up again after the swap.
  await page.locator('input[type="file"]').first().setInputFiles(FIXTURE_PNG);
  await channelComposer(page).click();
  await page.keyboard.press('Enter');
  const img = page.locator('img[src*="/public/"]').last();
  await expect(img).toBeVisible({ timeout: 15_000 });
  const src = await img.getAttribute('src');
  expect(src).toBeTruthy();
  const fileUrl = new URL(src!, UPGRADE_BASE).href;
  const served = await page.request.get(fileUrl);
  expect(served.status()).toBe(200);

  const migrations = readMigrationRows();
  expect(migrations.length).toBeGreaterThan(0);

  writeState({
    oldVersion,
    runTag: RUN_TAG,
    channelName,
    messageText,
    fileUrl,
    migrations
  });
  console.log(
    `[upgrade seed] version=${oldVersion} channel=${channelName} migrations=${migrations.length} file=${fileUrl}`
  );
});
