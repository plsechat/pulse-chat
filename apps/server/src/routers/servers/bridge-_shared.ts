import { z } from 'zod';
import type { TBridgeRemoteGuild, TBridgeServerLink } from '../../types';
import { getBridgeServerLink } from '../../db/queries/bridge-links';
import { invariant } from '../../utils/invariant';
import { BRIDGE_PLUGIN_ID, callBridgePlugin } from '../channels/bridge-_shared';

/**
 * Shared pieces of the whole-server bridge routes (servers.bridge*).
 *
 * The per-channel routes own the hand-off to the plugin
 * (channels/bridge-_shared.ts); these build on it. The contracts below
 * are the plugin's HTTP routes as the sync and the status call them —
 * typed here, on the caller's side, because the plugin is a separate
 * package that only knows the SDK.
 */

const modeSchema = z.enum(['match', 'mirror']);
const createMissingSchema = z.enum(['both', 'here', 'there', 'none']);

/** Per sync: local channels considered, remote channels listed. */
const MAX_SYNC_CHANNELS = 500;

type TPluginRemoteChannel = {
  id: string;
  guildId: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
  position: number;
};

type TPluginRemoteListing = {
  guilds: TBridgeRemoteGuild[];
  channels: TPluginRemoteChannel[];
  categories?: { id: string; name: string }[];
  skipped?: { id: string; name: string; reason: string }[];
};

type TPluginCreatedChannel = {
  id: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
};

type TPluginUpsertAnswer = { webhookId: string; webhookToken: string | null };

type TPluginLinkStatus = { known: boolean; mirroredToday: number; lastError: string | null };

type TPluginStatus = {
  configured: boolean;
  connected: boolean;
  fatal: string | null;
  lastError: string | null;
  botUser: { id: string; name: string } | null;
  links: Record<string, TPluginLinkStatus>;
  /** Guild names from the plugin's gateway cache, for the ids asked. */
  guilds?: Record<string, { name: string }>;
  /** Per server id: a counter the plugin bumps when the remote side changed. */
  syncRequested?: Record<string, number>;
};

/** The remote listing of one guild, bounded the way the sync consumes it. */
const listRemoteGuildChannels = async (remoteGuildId: string): Promise<TPluginRemoteListing> => {
  const listing = await callBridgePlugin<TPluginRemoteListing>('channels', { guildId: remoteGuildId });

  return {
    guilds: Array.isArray(listing?.guilds) ? listing.guilds.slice(0, 200) : [],
    channels: Array.isArray(listing?.channels) ? listing.channels.slice(0, MAX_SYNC_CHANNELS) : [],
    categories: Array.isArray(listing?.categories) ? listing.categories.slice(0, MAX_SYNC_CHANNELS) : [],
    skipped: Array.isArray(listing?.skipped) ? listing.skipped.slice(0, MAX_SYNC_CHANNELS) : []
  };
};

/** The guilds the bot sits in (one REST call through the plugin). */
const listRemoteGuilds = async (): Promise<TBridgeRemoteGuild[]> => {
  const listing = await callBridgePlugin<TPluginRemoteListing>('channels', {});

  return Array.isArray(listing?.guilds) ? listing.guilds.slice(0, 200) : [];
};

const pluginStatus = (body: {
  channelIds?: number[];
  serverIds?: number[];
  guildIds?: string[];
}): Promise<TPluginStatus> => callBridgePlugin<TPluginStatus>('status', body);

/** Hand the plugin its copy of a server link (no secret involved). */
const pushServerLinkToPlugin = (link: TBridgeServerLink): Promise<unknown> =>
  callBridgePlugin('server-links/upsert', {
    serverId: link.serverId,
    remoteGuildId: link.remoteGuildId,
    mode: link.mode,
    createMissing: link.createMissing,
    defaultDirection: link.defaultDirection
  });

/** The active server's link, or NOT_FOUND in the owner's words. */
const requireServerLink = async (activeServerId: number): Promise<TBridgeServerLink> => {
  const link = await getBridgeServerLink(BRIDGE_PLUGIN_ID, activeServerId);

  invariant(link, {
    code: 'NOT_FOUND',
    message: 'This server is not linked to a remote server'
  });

  return link;
};

export {
  createMissingSchema,
  listRemoteGuildChannels,
  listRemoteGuilds,
  MAX_SYNC_CHANNELS,
  modeSchema,
  pluginStatus,
  pushServerLinkToPlugin,
  requireServerLink
};
export type {
  TPluginCreatedChannel,
  TPluginRemoteChannel,
  TPluginRemoteListing,
  TPluginStatus,
  TPluginUpsertAnswer
};
