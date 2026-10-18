import { expect, test } from '@playwright/test';
import { registerUser, storageStateFor } from '../../helpers/api';
import { psql } from '../../helpers/db';
import { runUser } from '../../helpers/fixtures';
import { channelButton, disableAnimations, selectChannel } from '../../helpers/ui';

/**
 * Public directory: a listed server shows up as a card on the Discover
 * screen's Directory tab with its game, tags and description; the
 * search box (server-side, debounced) and the game filter narrow the
 * cards; Join on the card makes the fresh user a member.
 */

const BASE = 'http://127.0.0.1:14991';

test('a listed server appears in the Directory, is searchable and joinable from its card', async ({
  browser
}) => {
  test.setTimeout(180_000);

  // Listing needs the open join path the opt-in route enforces
  // (discoverable + accepting members). Idempotent on reruns.
  psql(
    'core',
    `UPDATE servers SET discoverable = true, allow_new_users = true,
       directory_listed = true, directory_game = 'Chess',
       directory_tags = '["casual","weekends"]'::jsonb,
       directory_description = 'Evening games for everyone'
     WHERE id = 1`
  );

  const fresh = runUser('directory');
  const tokens = await registerUser(BASE, fresh);

  const context = await browser.newContext({
    storageState: storageStateFor(BASE, tokens),
    baseURL: BASE
  });
  const page = await context.newPage();
  try {
    await disableAnimations(page);
    await page.goto(BASE);

    // A fresh user with zero servers lands on Discover (Local section).
    await expect(page.getByText('Pulse Server').first()).toBeVisible({
      timeout: 20_000
    });

    await page.getByRole('button', { name: 'Directory', exact: true }).click();

    const card = page.getByRole('article', { name: 'Pulse Server' });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText('Chess', { exact: true })).toBeVisible();
    await expect(card.getByText('#casual', { exact: true })).toBeVisible();
    await expect(card.getByText('#weekends', { exact: true })).toBeVisible();
    await expect(card.getByText('Evening games for everyone')).toBeVisible();
    await expect(card.getByText(/\d+ members? · \d+ online/)).toBeVisible();
    await expect(card.getByRole('button', { name: 'Preview', exact: true })).toBeVisible();

    // Search: a miss, then a hit by tag, then by game (ILIKE, so case-free).
    const search = page.getByRole('searchbox', { name: /Search the directory/ });
    await search.fill('zzz-nothing-here');
    await expect(page.getByText('No communities match')).toBeVisible({ timeout: 15_000 });
    await search.fill('weekends');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await search.fill('CHESS');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await search.fill('');

    // Game filter.
    await page.getByRole('combobox', { name: 'Filter by game' }).click();
    await page.getByRole('option', { name: 'Chess', exact: true }).click();
    await expect(card).toBeVisible({ timeout: 15_000 });

    // Join from the card: the community opens with its channel tree; a
    // channel is not selected for a fresh member until they pick one.
    await card.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(channelButton(page, 'General Text')).toBeVisible({ timeout: 30_000 });
    await selectChannel(page, 'General Text');
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({
      timeout: 30_000
    });

    const userId = psql(
      'core',
      `SELECT id FROM users WHERE name = '${fresh.displayName}'`
    );
    expect(userId).not.toBe('');
    await expect
      .poll(() =>
        psql('core', `SELECT count(*) FROM server_members WHERE user_id = ${userId} AND server_id = 1`)
      )
      .toBe('1');
  } finally {
    await context.close();
  }
});
