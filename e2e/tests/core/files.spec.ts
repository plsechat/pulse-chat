import { expect, test } from '@playwright/test';
import path from 'node:path';
import { authedGoto, channelComposer, selectChannel } from '../../helpers/ui';

/**
 * File storage security model (shipped 2026-07-13/14):
 *  - stored names are random UUIDs (originals only in the DB + the
 *    download Content-Disposition) — so a public URL can't be guessed
 *    from the original filename
 *  - DM/private-channel attachments require a per-file HMAC token
 *  - a fresh boot must serve tokened files (regression b6b06a5: the HMAC
 *    secret was never warmed at boot and every file-token path 500'd)
 */

const FIXTURE_PNG = path.join(__dirname, '..', '..', 'fixtures', 'pixel.png');

test('channel attachment is stored under an unguessable UUID name and serves', async ({
  page
}) => {
  await authedGoto(page, 'http://127.0.0.1:14991', 'owner@e2e.local', 'e2e-password-1234');
  await selectChannel(page, 'General Text');

  await page.locator('input[type="file"]').first().setInputFiles(FIXTURE_PNG);
  // Attachment preview appears in the composer; send it.
  await channelComposer(page).click();
  await page.keyboard.press('Enter');

  const img = page.locator('img[src*="/public/"]').last();
  await expect(img).toBeVisible({ timeout: 15_000 });

  const src = await img.getAttribute('src');
  expect(src).toBeTruthy();

  const served = new URL(src!, 'http://127.0.0.1:14991');
  // Unguessable-name property: the served path is a UUID, not pixel.png
  expect(path.basename(served.pathname)).toMatch(/^[0-9a-f-]{36}\.png$/i);
  expect(served.pathname).not.toContain('pixel');

  const res = await page.request.get(served.href);
  expect(res.status()).toBe(200);
  // Original name is preserved for the download, not the URL
  expect(res.headers()['content-disposition']).toContain('pixel.png');
});

/**
 * DM attachment token gating (403 without token / 200 with / no cold-boot
 * 500) through the real DM UI.
 *
 * Deferred: reliably reaching a DM composer needs a second user who is
 * ONLINE (a member joined via API but never WS-connected doesn't surface
 * in the member list, and the message-author popover path races the live
 * session). Wants a proper "live second user" fixture.
 *
 * The underlying security is already covered where it's deterministic:
 *   - server unit test apps/server/src/http/__tests__/public.test.ts
 *     asserts DM 403-without / 200-with-token and the HMAC path
 *   - the b6b06a5 cold-boot regression is caught by the server booting at
 *     all (warmFileHmacSecret runs in the boot sequence)
 */
test.fixme('DM attachment: 403 without token, 200 with, no cold-boot 500', () => {});
