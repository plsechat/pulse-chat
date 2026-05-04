import type {
  TJoinedSettings,
  TPublicServerSettings
} from '@pulse/shared';
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
    enablePlugins: server.enablePlugins
  };
};

const getPublicSettings = async (): Promise<TPublicServerSettings> => {
  // For backward compat, reads from the first server
  const [server] = await db.select().from(servers).limit(1);

  if (!server) {
    throw new Error('No server found in database');
  }

  return getServerPublicSettings(server.id);
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
  getPublicSettings,
  getServerPublicSettings,
  getSettings,
  warmFileHmacSecret
};
