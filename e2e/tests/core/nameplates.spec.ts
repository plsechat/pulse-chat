import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page
} from '@playwright/test';
import path from 'node:path';
import { authedPage, CORE_OWNER, RUN_TAG } from '../../helpers/fixtures';
import {
  memberList,
  openMemberList,
  openServerSettings,
  openUserSettings,
  toast
} from '../../helpers/ui';

/**
 * Nameplates: the bundled presets render in the picker and their art
 * serves; a server-uploaded pack goes through the crop step (PNG) or
 * skips it (animated GIF, which cropping would flatten); every picker
 * tile's background URL actually serves; equipping paints the member
 * row live. Pack names carry RUN_TAG so reruns on a lived-in instance
 * never collide with a preset label or an earlier upload.
 */

const BASE = 'http://127.0.0.1:14991';
const FIXTURES = path.join(__dirname, '..', '..', 'fixtures');

// components/nameplate/presets.ts — gradient presets + bundled GIFs.
const GRADIENT_PRESETS = [
  'Aurora', 'Ember', 'Ocean', 'Synthwave', 'Forest', 'Rose', 'Gold',
  'Steel', 'Midnight', 'Wave'
];
const ANIMATED_PRESETS = [
  'Drowned', 'Sakura', 'Borealis', 'Sunset Drive', 'Tide', 'Lava',
  'Fireflies', 'Prism', 'Daydream', 'Koi Pond', 'Runes', 'Cipher', 'Storm',
  'Starfield', 'Eclipse', 'Abyss', 'City Rain', 'Snowfall', 'Neon Wave',
  'Embers', 'Glitch', 'Night Racer', 'Moto', 'Bullseye', 'Gridiron',
  'Arcade', 'Player One', 'Manga Burst', 'Ronin', 'Haunted',
  "Jack-o'-Lantern", 'Sunny Day', 'Rainbow', 'Kawaii', 'High Roller',
  'Equalizer', 'Buzzer Beater'
];

let ctx: BrowserContext;
let page: Page;

/**
 * A NAMEPLATE picker tile. The avatar-decoration picker on the same
 * page shares labels (Koi Pond, Sakura, None), so match the nameplate
 * tile's row shape (h-11) rather than the title alone.
 */
function tile(label: string): Locator {
  return page
    .locator(`button.h-11[title="${label.replace(/"/g, '\\"')}"]`)
    .first();
}

/** The background-image URL of a picker tile's art layer. */
async function tileImageUrl(label: string): Promise<string> {
  const t = tile(label);
  await t.scrollIntoViewIfNeeded();
  await expect(t).toBeVisible();
  const bg = await t.evaluate((el) => {
    const layer = el.querySelector('[aria-hidden]') as HTMLElement | null;
    return layer ? getComputedStyle(layer).backgroundImage : '<none>';
  });
  const match = /url\("?([^")]+)"?\)/.exec(bg);
  expect(match, `tile "${label}" has no background url (${bg})`).not.toBeNull();
  return new URL(match![1]!, BASE).href;
}

/** The owner's member-list row (right sidebar). */
function ownMemberRow(): Locator {
  return memberList(page)
    .locator('div.group')
    .filter({ has: page.getByText(CORE_OWNER.displayName, { exact: true }) })
    .first();
}

/** Nameplate art layer painted behind the member row (NameplateBackground). */
function rowPlate(): Locator {
  return ownMemberRow().locator('div[aria-hidden="true"].absolute');
}

async function equipFromPicker(label: string): Promise<void> {
  await openUserSettings(page, 'Personalization');
  const t = tile(label);
  await t.scrollIntoViewIfNeeded();
  await t.click();
  await expect(t).toHaveClass(/ring-primary/, { timeout: 10_000 });
  await page.keyboard.press('Escape');
}

test.describe('nameplates', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    ({ context: ctx, page } = await authedPage(browser, BASE, CORE_OWNER));
    await openMemberList(page);
  });

  test.afterAll(async () => {
    await ctx?.close();
  });

  test('bundled presets render in the picker, the animated art serves as GIF, equipping paints the member row', async () => {
    test.setTimeout(120_000);
    await openUserSettings(page, 'Personalization');
    await expect(tile('None')).toBeVisible();
    for (const label of [...GRADIENT_PRESETS, ...ANIMATED_PRESETS]) {
      await expect(tile(label)).toBeVisible();
    }

    const koi = await tileImageUrl('Koi Pond');
    const res = await page.request.get(koi);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/gif');
    await page.keyboard.press('Escape');

    await expect(rowPlate()).toHaveCount(0);
    await equipFromPicker('Koi Pond');
    await expect(rowPlate()).toHaveCount(1, { timeout: 10_000 });
    expect(
      await rowPlate().evaluate((el) => getComputedStyle(el).backgroundImage)
    ).toContain('/nameplates/koi.gif');

    await equipFromPicker('None');
    await expect(rowPlate()).toHaveCount(0, { timeout: 10_000 });
  });

  test('an animated GIF pack skips the crop step and serves as a real GIF', async () => {
    test.setTimeout(120_000);
    const name = `gif-${RUN_TAG}`;
    await openServerSettings(page, 'Nameplates');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose Image' }).click();
    await (await chooserPromise).setFiles(
      path.join(FIXTURES, 'pulse-nameplate-drowned.gif')
    );

    // GIFs must NOT get the crop dialog — straight to the upload form.
    const nameInput = page.getByPlaceholder('Enter nameplate name');
    await expect(nameInput).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Crop nameplate' })
    ).toHaveCount(0);
    await nameInput.fill(name);
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(toast(page, 'Nameplate uploaded')).toBeVisible({
      timeout: 15_000
    });
    await page.keyboard.press('Escape');

    // Picker: the pack tile's art serves as an (animated-size) gif.
    await openUserSettings(page, 'Personalization');
    await expect(page.getByText('Server nameplates')).toBeVisible({
      timeout: 10_000
    });
    const url = await tileImageUrl(name);
    const res = await page.request.get(url);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/gif');
    expect((await res.body()).length).toBeGreaterThan(100_000);
    await page.keyboard.press('Escape');

    // Equip the pack → row paints with the uploaded file.
    await equipFromPicker(name);
    await expect(rowPlate()).toHaveCount(1, { timeout: 10_000 });
    expect(
      await rowPlate().evaluate((el) => getComputedStyle(el).backgroundImage)
    ).toContain(new URL(url).pathname);
    await equipFromPicker('None');
    await expect(rowPlate()).toHaveCount(0, { timeout: 10_000 });
  });

  test('a PNG pack goes through the crop step and its picker tile serves', async () => {
    test.setTimeout(120_000);
    const name = `png-${RUN_TAG}`;
    await openServerSettings(page, 'Nameplates');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose Image' }).click();
    await (await chooserPromise).setFiles(path.join(FIXTURES, 'plate-test.png'));

    // Crop runs between pick and the upload form.
    await expect(
      page.getByRole('heading', { name: 'Crop nameplate' })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Crop', exact: true }).click();

    const nameInput = page.getByPlaceholder('Enter nameplate name');
    await nameInput.fill(name);
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(toast(page, 'Nameplate uploaded')).toBeVisible({
      timeout: 15_000
    });
    // The admin list shows the new pack.
    await expect(page.getByText(name).first()).toBeVisible({
      timeout: 15_000
    });
    await page.keyboard.press('Escape');

    // The reported bug: pack tiles rendered blank because the file URL
    // did not serve. Assert the tile's URL answers with an image.
    await openUserSettings(page, 'Personalization');
    await expect(page.getByText('Server nameplates')).toBeVisible({
      timeout: 10_000
    });
    const url = await tileImageUrl(name);
    const res = await page.request.get(url);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^image\//);
    expect((await res.body()).length).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
  });
});
