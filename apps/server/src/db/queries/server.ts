import type { TJoinedSettings, TPublicServerSettings } from '../../types';
import { eq } from 'drizzle-orm';
import { db } from '..';
import { files, servers, settings } from '../schema';

const getSettings = async (): Promise<TJoinedSettings> => {
  const [serverSettings] = await db.select().from(settings).limit(1);

  if (!serverSettings) {
    throw new Error('Server settings not found in database');
  }

  const logo = serverSettings.logoId
    ? (
        await db
          .select()
          .from(files)
          .where(eq(files.id, serverSettings.logoId))
          .limit(1)
      )[0]
    : undefined;

  return {
    ...serverSettings,
    logo: logo ?? null
  };
};

/**
 * Instance-wide limits that live on the BOOTSTRAP server row (lowest id):
 * uploads are instance-global (one files table, one disk) and plugins
 * load at the instance level, so the first server's row is the single
 * source of truth for both. The `settings` table still carries the same
 * columns but nothing writes them — reading them there applied the
 * seeded defaults forever, whatever the owner set in the UI.
 */
const getInstanceServerSettings = async () => {
  const [server] = await db
    .select({
      storageUploadEnabled: servers.storageUploadEnabled,
      storageQuota: servers.storageQuota,
      storageUploadMaxFileSize: servers.storageUploadMaxFileSize,
      storageSpaceQuotaByUser: servers.storageSpaceQuotaByUser,
      storageOverflowAction: servers.storageOverflowAction,
      enablePlugins: servers.enablePlugins
    })
    .from(servers)
    .orderBy(servers.id)
    .limit(1);

  if (!server) {
    throw new Error('Bootstrap server not found in database');
  }

  return server;
};

const getServerPublicSettings = async (
  serverId: number
): Promise<TPublicServerSettings> => {
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  if (!server) {
    throw new Error(`Server ${serverId} not found`);
  }

  // Include the logo so clients can live-update the server rail when a
  // SERVER_SETTINGS_UPDATE arrives (logo changes were invisible until a
  // full refresh otherwise).
  const logo = server.logoId
    ? (
        await db
          .select()
          .from(files)
          .where(eq(files.id, server.logoId))
          .limit(1)
      )[0]
    : undefined;

  return {
    id: server.id,
    description: server.description ?? '',
    name: server.name,
    publicId: server.publicId,
    storageUploadEnabled: server.storageUploadEnabled,
    storageQuota: server.storageQuota,
    storageUploadMaxFileSize: server.storageUploadMaxFileSize,
    storageSpaceQuotaByUser: server.storageSpaceQuotaByUser,
    storageOverflowAction: server.storageOverflowAction,
    enablePlugins: server.enablePlugins,
    enableEvents: server.enableEvents,
    logo: logo ?? null
  };
};

/**
 * The per-community Planner switch (`servers.enable_events`). Off hides
 * the planner and makes every events surface refuse; the rows stay so
 * switching it back on brings them back unchanged. An unknown server
 * reads as off, so a stale id can never reach an events route.
 */
const isEventsEnabled = async (serverId: number): Promise<boolean> => {
  const [server] = await db
    .select({ enableEvents: servers.enableEvents })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  return server?.enableEvents === true;
};

// Per-instance HMAC secret used by files-crypto to mint short-lived file
// access tokens. Stored in `servers.secret_token` for historical reasons —
// pre-Phase-3 the column also doubled as the owner-claim challenge, but
// that role is gone (see commit 1e989da). The DB column rename to
// `file_hmac_secret` is a separate migration; the symbol-level renames
// here clarify what the value is for now that the dual purpose is gone.
let cachedFileHmacSecret: string;

const getFileHmacSecretSync = (): string => {
  if (!cachedFileHmacSecret) {
    throw new Error('File HMAC secret has not been initialized yet');
  }

  return cachedFileHmacSecret;
};

const warmFileHmacSecret = async (): Promise<string> => {
  if (cachedFileHmacSecret) return cachedFileHmacSecret;

  const [server] = await db.select().from(servers).limit(1);

  if (!server?.secretToken) {
    throw new Error('File HMAC secret not found in database');
  }

  cachedFileHmacSecret = server.secretToken;

  return cachedFileHmacSecret;
};

export {
  getFileHmacSecretSync,
  getInstanceServerSettings,
  getServerPublicSettings,
  getSettings,
  isEventsEnabled,
  warmFileHmacSecret
};
