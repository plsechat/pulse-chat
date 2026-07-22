import { count, isNotNull, sql, sum } from 'drizzle-orm';
import { db } from '../../db';
import {
  channels,
  federationInstances,
  files,
  messages,
  servers,
  users
} from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { SERVER_VERSION } from '../../utils/env';
import { instanceOwnerProcedure } from '../../utils/procedures';
import { getWsStats } from '../../utils/ws-stats';

/**
 * Runtime health for the admin panel: versions, uptime, process
 * memory, live connection/voice occupancy, federation peers, and
 * database/content totals. Everything here is existence-and-resources
 * metadata — no content. Counts are exact (an admin page visited by
 * one operator, not a hot path).
 */
const getHealthRoute = instanceOwnerProcedure.query(async () => {
  const [dbSizeRows, totals, fileTotals, peers] = await Promise.all([
    db.execute(
      sql`select pg_database_size(current_database())::bigint as size`
    ),
    Promise.all([
      db.select({ value: count() }).from(users),
      db
        .select({ value: count() })
        .from(users)
        .where(isNotNull(users.deletedAt)),
      db.select({ value: count() }).from(servers),
      db.select({ value: count() }).from(channels),
      db.select({ value: count() }).from(messages)
    ]),
    db
      .select({ bytes: sum(files.size), value: count() })
      .from(files),
    db
      .select({
        domain: federationInstances.domain,
        name: federationInstances.name,
        status: federationInstances.status,
        direction: federationInstances.direction,
        lastSeenAt: federationInstances.lastSeenAt
      })
      .from(federationInstances)
  ]);

  const [userCount, deletedCount, serverCount, channelCount, messageCount] =
    totals;
  const memory = process.memoryUsage();
  const dbSize = (dbSizeRows as unknown as { size: string | number }[])[0];

  return {
    version: SERVER_VERSION,
    bunVersion: Bun.version,
    uptimeMs: Math.floor(process.uptime() * 1000),
    memory: { rss: memory.rss, heapUsed: memory.heapUsed },
    connections: getWsStats(),
    voice: VoiceRuntime.getStats(),
    federation: peers,
    database: {
      sizeBytes: Number(dbSize?.size ?? 0),
      users: userCount[0]?.value ?? 0,
      deletedUsers: deletedCount[0]?.value ?? 0,
      servers: serverCount[0]?.value ?? 0,
      channels: channelCount[0]?.value ?? 0,
      messages: messageCount[0]?.value ?? 0
    },
    storage: {
      totalBytes: Number(fileTotals[0]?.bytes ?? 0),
      fileCount: fileTotals[0]?.value ?? 0
    }
  };
});

export { getHealthRoute };
