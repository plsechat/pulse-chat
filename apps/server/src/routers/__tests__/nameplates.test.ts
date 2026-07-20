import type { TTempFile } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { initTest, uploadFile } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { files, nameplates, users } from '../../db/schema';

type Caller = Awaited<ReturnType<typeof initTest>>['caller'];

/** Upload a png and create a nameplate pack through the routes. */
async function addTestNameplate(
  caller: Caller,
  mockedToken: string,
  name = 'test_plate'
) {
  const file = new File(['nameplate content'], 'plate.png', {
    type: 'image/png'
  });

  const uploadResponse = await uploadFile(file, mockedToken);
  const uploadData = (await uploadResponse.json()) as TTempFile;

  return caller.nameplates.add({ name, tempFileId: uploadData.id });
}

/** Insert a nameplate row directly (for packs on servers without routes set up). */
async function insertNameplateRow(serverId: number, name = 'direct_plate') {
  const tdb = getTestDb();

  const [file] = await tdb
    .insert(files)
    .values({
      name: `nameplate-${serverId}-${name}.png`,
      originalName: 'plate.png',
      md5: `md5-${serverId}-${name}`,
      userId: 1,
      size: 128,
      mimeType: 'image/png',
      extension: '.png',
      createdAt: Date.now()
    })
    .returning();

  const [nameplate] = await tdb
    .insert(nameplates)
    .values({
      serverId,
      name,
      fileId: file!.id,
      createdAt: Date.now()
    })
    .returning();

  return nameplate!;
}

describe('nameplates', () => {
  test('preset equip works and appears in the public user payload', async () => {
    const { caller } = await initTest(1);

    await caller.users.setNameplate({ nameplate: 'preset:aurora' });

    const members = await caller.others.getServerMembers();
    const me = members.find((m) => m.id === 1);

    expect(me).toBeDefined();
    expect(me!.nameplate).toBe('preset:aurora');

    // Clearing works too
    await caller.users.setNameplate({ nameplate: null });

    const cleared = await caller.others.getServerMembers();
    expect(cleared.find((m) => m.id === 1)!.nameplate).toBeNull();
  });

  test('invalid slugs and malformed values are refused', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.users.setNameplate({ nameplate: 'preset:not-a-real-slug' })
    ).rejects.toThrow('Unknown nameplate preset');

    await expect(
      caller.users.setNameplate({ nameplate: 'sparkles' })
    ).rejects.toThrow('Invalid nameplate value');
  });

  test('custom equip requires membership of the pack server', async () => {
    const { caller: owner, mockedToken } = await initTest(1);
    const { caller: member } = await initTest(2);

    // Pack on server 1 — user 2 is a member, equip works
    const plate = await addTestNameplate(owner, mockedToken, 'shared_plate');
    await member.users.setNameplate({ nameplate: `custom:${plate.id}` });

    const tdb = getTestDb();
    const [row] = await tdb
      .select({ nameplate: users.nameplate })
      .from(users)
      .where(eq(users.id, 2))
      .limit(1);
    expect(row!.nameplate).toBe(`custom:${plate.id}`);

    // Pack on a second server user 2 is NOT a member of — refused
    const server2 = await owner.servers.create({ name: 'Nameplate Island' });
    const foreignPlate = await insertNameplateRow(server2.id, 'foreign_plate');

    await expect(
      member.users.setNameplate({ nameplate: `custom:${foreignPlate.id}` })
    ).rejects.toThrow('Nameplate not found');

    // …but user 1 (creator, hence member of server 2) may equip it
    await owner.users.setNameplate({ nameplate: `custom:${foreignPlate.id}` });

    // Nonexistent pack id is refused
    await expect(
      member.users.setNameplate({ nameplate: 'custom:999999' })
    ).rejects.toThrow('Nameplate not found');
  });

  test('add and delete are permission-gated', async () => {
    const { caller: member, mockedToken } = await initTest(2);

    const file = new File(['nameplate content'], 'plate.png', {
      type: 'image/png'
    });
    const uploadResponse = await uploadFile(file, mockedToken);
    const uploadData = (await uploadResponse.json()) as TTempFile;

    await expect(
      member.nameplates.add({ name: 'nope', tempFileId: uploadData.id })
    ).rejects.toThrow('Insufficient permissions');

    await expect(member.nameplates.delete({ id: 1 })).rejects.toThrow(
      'Insufficient permissions'
    );
  });

  test('getAll is scoped to the active server', async () => {
    const { caller: owner, mockedToken } = await initTest(1);

    const plate = await addTestNameplate(owner, mockedToken, 'local_plate');

    // A pack on another server must not show up in server 1's list
    const server2 = await owner.servers.create({ name: 'Other Plates' });
    await insertNameplateRow(server2.id, 'elsewhere_plate');

    const all = await owner.nameplates.getAll();

    expect(all.find((n) => n.id === plate.id)).toBeDefined();
    expect(all.find((n) => n.name === 'elsewhere_plate')).toBeUndefined();

    // Any member (no MANAGE_EMOJIS) can list
    const { caller: member } = await initTest(2);
    const memberView = await member.nameplates.getAll();
    expect(memberView.find((n) => n.id === plate.id)).toBeDefined();
  });

  test('delete clears the nameplate of every user equipping it', async () => {
    const { caller: owner, mockedToken } = await initTest(1);
    const { caller: member } = await initTest(2);

    const plate = await addTestNameplate(owner, mockedToken, 'ephemeral');
    await member.users.setNameplate({ nameplate: `custom:${plate.id}` });

    await owner.nameplates.delete({ id: plate.id });

    const tdb = getTestDb();
    const [row] = await tdb
      .select({ nameplate: users.nameplate })
      .from(users)
      .where(eq(users.id, 2))
      .limit(1);
    expect(row!.nameplate).toBeNull();

    const remaining = await owner.nameplates.getAll();
    expect(remaining.find((n) => n.id === plate.id)).toBeUndefined();
  });

  test('a pack file is NOT considered orphaned (public serving + cleanup cron)', async () => {
    // The /public file route refuses orphaned files and the cleanup cron
    // deletes them — both walk the same reference checklist, which must
    // know about the nameplates table or pack art 404s in the picker and
    // eventually gets deleted off disk.
    const { isFileOrphaned, getOrphanedFileIds } = await import(
      '../../db/queries/files'
    );
    const { caller, mockedToken } = await initTest(1);

    const plate = await addTestNameplate(caller, mockedToken, 'orphan_check');
    expect(await isFileOrphaned(plate.file.id)).toBe(false);
    expect(await getOrphanedFileIds()).not.toContain(plate.file.id);
  });
});
