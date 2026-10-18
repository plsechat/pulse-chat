import { expect, test } from '@playwright/test';
import { loginUser, storageStateFor } from '../../helpers/api';
import { CORE_OWNER } from '../../helpers/fixtures';
import { waitForAppReady } from '../../helpers/ui';

/**
 * PROBE UTILITY — not a test. Walks the four observability sections of
 * the admin area (Health / Activity Log / Storage / Logs) and
 * screenshots each. Runs only when OBS_PROBE is set.
 */

test.skip(!process.env.OBS_PROBE, 'probe utility, set OBS_PROBE=1');

const BASE = 'http://127.0.0.1:14991';
const SHOTS = 'probe-shots';

test('observability sections render live data', async ({ browser }) => {
  test.setTimeout(120_000);

  const tokens = await loginUser(BASE, CORE_OWNER.email, CORE_OWNER.password);
  const context = await browser.newContext({
    storageState: storageStateFor(BASE, tokens),
    baseURL: BASE
  });
  const page = await context.newPage();
  await page.goto(BASE);
  await waitForAppReady(page);

  await page
    .locator('aside')
    .getByRole('button')
    .filter({ hasText: 'Pulse Server' })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();

  await page.getByRole('button', { name: 'Health', exact: true }).click();
  await expect(page.getByText('Server version')).toBeVisible({
    timeout: 15_000
  });
  await expect(page.getByText('Uptime', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Database size', { exact: true })
  ).toBeVisible();
  // Graphs: chart cards render once the sampler has ≥2 points.
  await expect(page.getByText('CPU', { exact: true })).toBeVisible({
    timeout: 60_000
  });
  await expect(page.getByText('Event-loop lag', { exact: true })).toBeVisible();
  await expect(page.locator('svg path[stroke]').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/obs-1-health.png` });
  await page
    .getByText('Event-loop lag', { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/obs-1b-graphs.png` });

  await page.getByRole('button', { name: 'All Servers', exact: true }).click();
  // count() doesn't wait — anchor on the row itself with a timeout.
  const demoRow = page.getByText('Deletable Demo', { exact: true }).first();
  await expect(demoRow).toBeVisible({ timeout: 15_000 });
  await demoRow.click();
  // exact: the settings sidebar has its own capital-S "Delete Server".
  await expect(
    page.getByRole('button', { name: 'Delete server', exact: true })
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/obs-5-server-delete.png` });

  await page.getByRole('button', { name: 'Activity Log', exact: true }).click();
  await expect(page.getByText(/entr(y|ies)/).first()).toBeVisible({
    timeout: 15_000
  });
  await page.screenshot({ path: `${SHOTS}/obs-2-activity.png` });

  await page.getByRole('button', { name: 'Storage', exact: true }).click();
  await expect(page.getByText('Orphan cleanup')).toBeVisible({
    timeout: 15_000
  });
  await page.screenshot({ path: `${SHOTS}/obs-3-storage.png` });

  await page.getByRole('button', { name: 'Logs', exact: true }).click();
  // The ring holds at least the boot lines from the recent restart.
  await expect(page.locator('.font-mono div').first()).toBeVisible({
    timeout: 15_000
  });
  await page.screenshot({ path: `${SHOTS}/obs-4-logs.png` });
});
