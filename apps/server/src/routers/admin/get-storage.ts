import { count, desc, eq, sum } from 'drizzle-orm';
import { z } from 'zod';
import { getOrphanedFileIds } from '../../db/queries/files';
import { db } from '../../db';
import { files, users } from '../../db/schema';
import { cleanupFiles } from '../../crons/cleanup-files';
import { instanceOwnerProcedure } from '../../utils/procedures';

/**
 * Storage overview: totals, current orphan backlog (files no longer
 * referenced by anything — the 15-minute cron's work list), and the
 * heaviest uploaders. Metadata only; no file contents.
 */
const getStorageRoute = instanceOwnerProcedure.query(async () => {
  const [totals, orphanIds, topUploaders] = await Promise.all([
    db.select({ bytes: sum(files.size), value: count() }).from(files),
    getOrphanedFileIds(),
    db
      .select({
        userId: files.userId,
        userName: users.name,
        bytes: sum(files.size),
        fileCount: count()
      })
      .from(files)
      .innerJoin(users, eq(files.userId, users.id))
      .groupBy(files.userId, users.name)
      .orderBy(desc(sum(files.size)))
      .limit(10)
  ]);

  return {
    totalBytes: Number(totals[0]?.bytes ?? 0),
    fileCount: totals[0]?.value ?? 0,
    orphanCount: orphanIds.length,
    topUploaders: topUploaders.map((u) => ({
      ...u,
      bytes: Number(u.bytes ?? 0)
    }))
  };
});

/**
 * Manual trigger for the same sweep the 15-minute cron runs — lets the
 * operator reclaim space immediately after bulk deletions instead of
 * waiting out the cron interval.
 */
const runStorageCleanupRoute = instanceOwnerProcedure
  .input(z.object({}).optional())
  .mutation(async () => {
    const removed = await cleanupFiles();
    return { removed };
  });

export { getStorageRoute, runStorageCleanupRoute };
