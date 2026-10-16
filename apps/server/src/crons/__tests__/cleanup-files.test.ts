/**
 * cleanup-files cron — the file-reference checklist, the grace window,
 * bounded delete concurrency, and the instance-wide lock.
 *
 * The checklist is DERIVED FROM THE SCHEMA: every foreign key in
 * db/schema.ts that points at `files.id` must have a seeder here, and
 * a file referenced through each one must survive a sweep. Adding a
 * files FK to a new table without extending the orphan query (and this
 * map) fails this test instead of silently 404-ing and cron-deleting
 * that table's files.
 *
 * Setup is inline per test (no beforeEach) — see delete-account.test.ts.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { eq, getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { getTestDb } from '../../__tests__/mock-db';
import * as filesMutations from '../../db/mutations/files';
import * as schema from '../../db/schema';
import {
  dmChannels,
  dmMessageFiles,
  dmMessageReactions,
  dmMessages,
  emojis,
  files,
  messageFiles,
  messageReactions,
  messages,
  nameplates,
  servers,
  settings,
  users,
  webhooks
} from '../../db/schema';
import { cleanupFiles, DELETE_BATCH_SIZE, ORPHAN_GRACE_MS } from '../cleanup-files';

/** A files row old enough to be outside the grace window. */
const insertFile = async (ageMs = ORPHAN_GRACE_MS * 2): Promise<number> => {
  const suffix = randomUUIDv7();
  const [row] = await getTestDb()
    .insert(files)
    .values({
      name: `cleanup-${suffix}.bin`,
      originalName: 'cleanup.bin',
      md5: suffix,
      userId: 1,
      size: 10,
      mimeType: 'application/octet-stream',
      extension: 'bin',
      createdAt: Date.now() - ageMs
    })
    .returning({ id: files.id });
  return row!.id;
};

const seededMessageId = async () => {
  const [row] = await getTestDb()
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.channelId, 1))
    .limit(1);
  return row!.id;
};

const insertDmMessage = async () => {
  const tdb = getTestDb();
  const [dm] = await tdb
    .insert(dmChannels)
    .values({ createdAt: Date.now() })
    .returning({ id: dmChannels.id });
  const [msg] = await tdb
    .insert(dmMessages)
    .values({
      content: 'dm',
      userId: 1,
      dmChannelId: dm!.id,
      createdAt: Date.now()
    })
    .returning({ id: dmMessages.id });
  return msg!.id;
};

/**
 * One seeder per `<table>.<column>` files FK. Each attaches `fileId`
 * through that column. The test below asserts this map covers EVERY
 * files FK the schema declares — no more, no less.
 */
const REFERENCE_SEEDERS: Record<string, (fileId: number) => Promise<void>> = {
  'settings.logo_id': async (fileId) => {
    const rows = await getTestDb()
      .update(settings)
      .set({ logoId: fileId })
      .returning({ serverId: settings.serverId });
    expect(rows.length).toBeGreaterThan(0);
  },
  'servers.logo_id': async (fileId) => {
    await getTestDb()
      .update(servers)
      .set({ logoId: fileId })
      .where(eq(servers.id, 1));
  },
  'users.avatar_id': async (fileId) => {
    await getTestDb()
      .update(users)
      .set({ avatarId: fileId })
      .where(eq(users.id, 2));
  },
  'users.banner_id': async (fileId) => {
    await getTestDb()
      .update(users)
      .set({ bannerId: fileId })
      .where(eq(users.id, 3));
  },
  'message_files.file_id': async (fileId) => {
    await getTestDb().insert(messageFiles).values({
      messageId: await seededMessageId(),
      fileId,
      createdAt: Date.now()
    });
  },
  'emojis.file_id': async (fileId) => {
    await getTestDb().insert(emojis).values({
      name: `emoji-${fileId}`,
      fileId,
      userId: 1,
      serverId: 1,
      createdAt: Date.now()
    });
  },
  'nameplates.file_id': async (fileId) => {
    await getTestDb().insert(nameplates).values({
      serverId: 1,
      name: `plate-${fileId}`,
      fileId,
      createdAt: Date.now()
    });
  },
  'message_reactions.file_id': async (fileId) => {
    await getTestDb().insert(messageReactions).values({
      messageId: await seededMessageId(),
      userId: 1,
      emoji: `custom-${fileId}`,
      fileId,
      createdAt: Date.now()
    });
  },
  'dm_channels.icon_file_id': async (fileId) => {
    await getTestDb()
      .insert(dmChannels)
      .values({ iconFileId: fileId, isGroup: true, createdAt: Date.now() });
  },
  'dm_message_files.file_id': async (fileId) => {
    await getTestDb().insert(dmMessageFiles).values({
      dmMessageId: await insertDmMessage(),
      fileId,
      createdAt: Date.now()
    });
  },
  'dm_message_reactions.file_id': async (fileId) => {
    await getTestDb().insert(dmMessageReactions).values({
      dmMessageId: await insertDmMessage(),
      userId: 1,
      emoji: `custom-${fileId}`,
      fileId,
      createdAt: Date.now()
    });
  },
  'webhooks.avatar_file_id': async (fileId) => {
    await getTestDb().insert(webhooks).values({
      name: `hook-${fileId}`,
      channelId: 1,
      token: `token-${randomUUIDv7()}`,
      avatarFileId: fileId,
      createdBy: 1,
      serverId: 1,
      createdAt: Date.now()
    });
  }
};

/** Every `<table>.<column>` in the schema whose FK targets files.id. */
const schemaFileReferences = (): string[] => {
  const refs: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const { name, foreignKeys } = getTableConfig(value);
    for (const fk of foreignKeys) {
      const { columns, foreignTable } = fk.reference();
      if (getTableName(foreignTable) !== 'files') continue;
      for (const column of columns) refs.push(`${name}.${column.name}`);
    }
  }
  return refs.sort();
};

const fileExists = async (fileId: number) => {
  const [row] = await getTestDb()
    .select({ id: files.id })
    .from(files)
    .where(eq(files.id, fileId));
  return !!row;
};

describe('cleanupFiles', () => {
  test('the seeder map covers every files FK the schema declares', () => {
    expect(schemaFileReferences()).toEqual(Object.keys(REFERENCE_SEEDERS).sort());
  });

  test('a file referenced through each FK survives; an old orphan is deleted', async () => {
    const referenced = new Map<string, number>();
    for (const [ref, seed] of Object.entries(REFERENCE_SEEDERS)) {
      const fileId = await insertFile();
      await seed(fileId);
      referenced.set(ref, fileId);
    }
    const orphan = await insertFile();

    const removed = await cleanupFiles();

    expect(removed).toBe(1);
    expect(await fileExists(orphan)).toBe(false);
    for (const [ref, fileId] of referenced) {
      expect([ref, await fileExists(fileId)]).toEqual([ref, true]);
    }
  });

  test('an orphan younger than the grace window is left alone', async () => {
    const fresh = await insertFile(0);
    const old = await insertFile();

    expect(await cleanupFiles()).toBe(1);
    expect(await fileExists(fresh)).toBe(true);
    expect(await fileExists(old)).toBe(false);
  });

  test('deletes run in bounded batches', async () => {
    const total = DELETE_BATCH_SIZE * 4;
    for (let i = 0; i < total; i++) await insertFile();

    let inFlight = 0;
    let maxInFlight = 0;
    const removeSpy = spyOn(filesMutations, 'removeFile').mockImplementation(
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(5);
        inFlight--;
        return undefined;
      }
    );

    try {
      expect(await cleanupFiles()).toBe(total);
      expect(removeSpy).toHaveBeenCalledTimes(total);
      expect(maxInFlight).toBe(DELETE_BATCH_SIZE);
    } finally {
      removeSpy.mockRestore();
    }
  });

  test('a second sweep while one runs returns 0 and does nothing', async () => {
    const total = DELETE_BATCH_SIZE * 2;
    for (let i = 0; i < total; i++) await insertFile();

    const removeSpy = spyOn(filesMutations, 'removeFile').mockImplementation(
      async () => {
        await Bun.sleep(40);
        return undefined;
      }
    );

    try {
      const first = cleanupFiles();
      // Wait until the first sweep is provably past the lock and inside
      // the delete loop before contending for it.
      for (let i = 0; i < 100 && removeSpy.mock.calls.length === 0; i++) {
        await Bun.sleep(5);
      }
      expect(removeSpy.mock.calls.length).toBeGreaterThan(0);

      expect(await cleanupFiles()).toBe(0);
      expect(await first).toBe(total);
      expect(removeSpy).toHaveBeenCalledTimes(total);

      // The lock went with the holder's transaction: the next sweep
      // acquires it and processes the (spy-preserved) orphans again.
      expect(await cleanupFiles()).toBe(total);
    } finally {
      removeSpy.mockRestore();
    }
  });
});
