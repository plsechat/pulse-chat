import { ActivityLogType, ChannelType, Permission } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type {
  TBridgeServerLink,
  TBridgeSyncReport,
  TBridgeSyncTrigger
} from '../../types';
import { db } from '../../db';
import { publishCategory, publishChannel } from '../../db/publishers';
import {
  deleteBridgeLink,
  insertBridgeLink,
  listBridgeLinksForServer,
  listBridgeServerLinks,
  getBridgeServerLink
} from '../../db/queries/bridge-links';
import { bridgeServerLinks, categories, channels } from '../../db/schema';
import { logger } from '../../logger';
import { getPluginActorUserId } from '../../plugins/actor';
import { onPluginLoaded, onPluginNotify } from '../../plugins/subscriptions';
import { enqueueActivityLog } from '../../queues/activity-log';
import { serverProcedure } from '../../utils/procedures';
import { BRIDGE_PLUGIN_ID, callBridgePlugin, isBridgePluginLoaded } from '../channels/bridge-_shared';
import {
  listRemoteGuildChannels,
  MAX_SYNC_CHANNELS,
  pluginStatus,
  requireServerLink,
  type TPluginCreatedChannel,
  type TPluginUpsertAnswer
} from './bridge-_shared';
import { setBridgeChannelCreatedHook } from './bridge-hooks';
import { normalizeChannelName, planServerBridge, type TPairingPlan } from './bridge-pairing';

/**
 * The whole-server sync: bring the per-channel bridge_links rows of a
 * server in step with its server link.
 *
 *   1. the plugin lists the remote server's text channels (and what it
 *      would not bridge, for the report);
 *   2. the planner (bridge-pairing.ts) pairs unlinked channels by name
 *      and, in mirror mode, decides what to create on which side;
 *   3. every new pair goes through the SAME path a hand-made link does
 *      (plugin `links/upsert` creates the webhook, the row stores it
 *      encrypted) with the server link's id and default direction;
 *   4. a server-linked pair whose remote channel is gone is dropped —
 *      the row and the plugin's copy; the local channel stays. Deletion
 *      is never mirrored in either direction.
 *
 * One sync runs per server at a time; a request that arrives meanwhile
 * is remembered and one follow-up run starts when the current one ends,
 * so a burst of channel creations costs two runs, not ten. Webhook
 * creation is paced by the plugin's REST budget (about one a second),
 * so a large first sync takes minutes: it runs in the background and
 * the status route reports progress; nothing here holds a request open.
 *
 * Triggers: the owner linking or re-configuring (`link`), the button
 * (`manual`), a channel created here (`channel-created`, from
 * channels.add and the plugin channels.create action), the plugin
 * signalling a change on the remote side through `ctx.server.notify`
 * (`plugin`: a remote CHANNEL_CREATE/DELETE or a gateway reconnect
 * starts a sync at once), the bridge plugin (re)loading (`load`: every
 * server link is synced so a restart catches up without waiting), the
 * status being opened while the plugin's change counter moved
 * (`status`), and the once-a-minute tick (`tick`) — the backstop that
 * reads the same counter in case a signal was lost, and reconciles
 * every link in full now and then.
 *
 * Every run's outcome is written to the server link row (last_sync_at,
 * last_error, last_report) so the status page shows the last sync
 * after a restart; only "running" is in-process state.
 */

/** Same bounds as channels.add / categories.add. */
const MAX_LOCAL_CHANNEL_NAME = 24;
const MAX_LOCAL_CATEGORY_NAME = 32;
/** A full re-pairing even when nothing asked for one: catches a missed remote event. */
const FULL_RECONCILE_EVERY_MS = 30 * 60_000;

const running = new Map<number, Promise<TBridgeSyncReport>>();
const rerun = new Map<number, TBridgeSyncTrigger>();
const lastReports = new Map<number, TBridgeSyncReport>();
/** The plugin's `syncRequested` counter per server, as last acted on. */
const seenSyncRequests = new Map<number, number>();

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A remote name made to fit a local channel/category name field. */
const fitName = (name: string, max: number, fallback: string): string => {
  const cleaned = name.replace(/\s+/g, ' ').trim();
  const bounded = Array.from(cleaned).slice(0, max).join('').trim();
  return bounded.length > 0 ? bounded : fallback;
};

type TLocalTree = {
  channels: {
    id: number;
    name: string;
    type: string;
    e2ee: boolean;
    private: boolean;
    categoryId: number | null;
  }[];
  categories: { id: number; name: string }[];
};

const loadLocalTree = async (serverId: number): Promise<TLocalTree> => {
  const [channelRows, categoryRows] = await Promise.all([
    db
      .select({
        id: channels.id,
        name: channels.name,
        type: channels.type,
        e2ee: channels.e2ee,
        private: channels.private,
        categoryId: channels.categoryId
      })
      .from(channels)
      .where(eq(channels.serverId, serverId))
      .orderBy(asc(channels.categoryId), asc(channels.position), asc(channels.id))
      .limit(2000),
    db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.serverId, serverId))
      .orderBy(asc(categories.position), asc(categories.id))
      .limit(500)
  ]);

  return { channels: channelRows, categories: categoryRows };
};

/** The local category of that name (normalised), created when missing. */
const ensureLocalCategory = async (
  serverId: number,
  name: string | null,
  tree: TLocalTree,
  actorUserId: number
): Promise<number> => {
  const wanted = name ? normalizeChannelName(name) : '';

  if (wanted.length > 0) {
    const known = tree.categories.find((c) => normalizeChannelName(c.name) === wanted);
    if (known) return known.id;
  } else if (tree.categories[0]) {
    // The remote channel sits at the top level; ours go under the first
    // category, the same default the plugin channels.create action uses.
    return tree.categories[0].id;
  }

  const [result] = await db
    .select({ maxPos: sql<number>`COALESCE(MAX(${categories.position}), 0)` })
    .from(categories)
    .where(eq(categories.serverId, serverId));

  const categoryName = fitName(name ?? 'Bridged', MAX_LOCAL_CATEGORY_NAME, 'Bridged');
  const [created] = await db
    .insert(categories)
    .values({
      name: categoryName,
      position: (result?.maxPos ?? 0) + 1,
      serverId,
      createdAt: Date.now()
    })
    .returning();

  tree.categories.push({ id: created!.id, name: created!.name });
  await publishCategory(created!.id, 'create');
  enqueueActivityLog({
    type: ActivityLogType.CREATED_CATEGORY,
    userId: actorUserId,
    details: { categoryName, categoryId: created!.id }
  });

  return created!.id;
};

/** A plaintext text channel, created the way channels.add does it. */
const createLocalTextChannel = async (
  serverId: number,
  categoryId: number,
  name: string,
  actorUserId: number
): Promise<{ id: number; name: string }> => {
  const channelName = fitName(name, MAX_LOCAL_CHANNEL_NAME, 'channel');

  const channel = await db.transaction(async (tx) => {
    const [last] = await tx
      .select({ position: channels.position })
      .from(channels)
      .where(eq(channels.categoryId, categoryId))
      .orderBy(desc(channels.position))
      .limit(1);

    const now = Date.now();
    const [row] = await tx
      .insert(channels)
      .values({
        position: last ? last.position + 1 : 0,
        name: channelName,
        type: ChannelType.TEXT,
        fileAccessToken: randomUUIDv7(),
        fileAccessTokenUpdatedAt: now,
        categoryId,
        serverId,
        publicId: randomUUIDv7(),
        createdAt: now
      })
      .returning();

    return row!;
  });

  await publishChannel(channel.id, 'create');
  enqueueActivityLog({
    type: ActivityLogType.CREATED_CHANNEL,
    userId: actorUserId,
    details: { channelId: channel.id, channelName: channel.name, type: ChannelType.TEXT }
  });

  return { id: channel.id, name: channel.name };
};

/** Form one pair the way channels.bridgeLink does; false when the plugin refused. */
const formPair = async (
  link: TBridgeServerLink,
  localId: number,
  remoteChannelId: string,
  report: TBridgeSyncReport,
  localName: string
): Promise<boolean> => {
  let answer: TPluginUpsertAnswer;

  try {
    answer = await callBridgePlugin<TPluginUpsertAnswer>('links/upsert', {
      channelId: localId,
      serverId: link.serverId,
      remoteGuildId: link.remoteGuildId,
      remoteChannelId,
      direction: link.defaultDirection
    });
  } catch (error) {
    report.skipped.push({ name: localName, side: 'here', reason: errorMessage(error) });
    return false;
  }

  if (typeof answer?.webhookId !== 'string' || answer.webhookId.length === 0) {
    report.skipped.push({ name: localName, side: 'here', reason: 'the bridge plugin did not return a webhook' });
    return false;
  }

  try {
    await insertBridgeLink({
      pluginId: BRIDGE_PLUGIN_ID,
      channelId: localId,
      remoteGuildId: link.remoteGuildId,
      remoteChannelId,
      webhookId: answer.webhookId,
      webhookToken: typeof answer.webhookToken === 'string' ? answer.webhookToken : null,
      direction: link.defaultDirection,
      createdBy: link.createdBy,
      serverLinkId: link.id
    });
  } catch (error) {
    // A hand-made link won the unique index meanwhile: undo the webhook.
    await callBridgePlugin('links/remove', { channelId: localId }).catch(() => undefined);
    report.skipped.push({ name: localName, side: 'here', reason: errorMessage(error) });
    return false;
  }

  report.paired++;
  return true;
};

const applyPlan = async (
  link: TBridgeServerLink,
  plan: TPairingPlan,
  tree: TLocalTree,
  report: TBridgeSyncReport
) => {
  for (const stale of plan.stale) {
    await deleteBridgeLink(stale.id);
    await callBridgePlugin('links/remove', { channelId: stale.channelId }).catch(() => undefined);
    report.removed++;
  }

  for (const pair of plan.pair) {
    await formPair(link, pair.localId, pair.remoteId, report, pair.localName);
  }

  for (const wanted of plan.createThere) {
    let created: TPluginCreatedChannel;

    try {
      created = await callBridgePlugin<TPluginCreatedChannel>('remote/create-channel', {
        guildId: link.remoteGuildId,
        name: wanted.name,
        categoryName: wanted.categoryName
      });
    } catch (error) {
      report.skipped.push({ name: wanted.name, side: 'here', reason: `could not create it over there: ${errorMessage(error)}` });
      continue;
    }

    if (await formPair(link, wanted.localId, created.id, report, wanted.name)) report.createdThere++;
  }

  if (plan.createHere.length > 0) {
    const actorUserId = link.createdBy ?? (await getPluginActorUserId());

    for (const wanted of plan.createHere) {
      try {
        const categoryId = await ensureLocalCategory(link.serverId, wanted.categoryName, tree, actorUserId);
        const channel = await createLocalTextChannel(link.serverId, categoryId, wanted.name, actorUserId);

        if (await formPair(link, channel.id, wanted.remoteId, report, channel.name)) report.createdHere++;
      } catch (error) {
        report.skipped.push({ name: wanted.name, side: 'there', reason: `could not create it here: ${errorMessage(error)}` });
      }
    }
  }
};

/** The outcome of a run, on the link row: what bridgeStatus reads after a restart. */
const persistReport = async (linkId: number, report: TBridgeSyncReport): Promise<void> => {
  try {
    await db
      .update(bridgeServerLinks)
      .set({ lastSyncAt: report.finishedAt, lastError: report.error, lastReport: report })
      .where(eq(bridgeServerLinks.id, linkId));
  } catch (error) {
    // The link may have been removed while the run was under way; the
    // in-memory report still answers the status until the next run.
    logger.debug('[bridge] could not persist the sync report of link %d: %s', linkId, errorMessage(error));
  }
};

const runSync = async (serverId: number, trigger: TBridgeSyncTrigger): Promise<TBridgeSyncReport> => {
  const report: TBridgeSyncReport = {
    trigger,
    startedAt: Date.now(),
    finishedAt: null,
    paired: 0,
    createdHere: 0,
    createdThere: 0,
    removed: 0,
    skipped: [],
    error: null
  };
  let link: TBridgeServerLink | undefined;

  try {
    link = await getBridgeServerLink(BRIDGE_PLUGIN_ID, serverId);

    if (!link) {
      report.error = 'This server is not linked to a remote server';
      return report;
    }

    if (!isBridgePluginLoaded()) {
      report.error = 'The bridge plugin is not running';
      return report;
    }

    const [listing, tree, existing] = await Promise.all([
      listRemoteGuildChannels(link.remoteGuildId),
      loadLocalTree(serverId),
      listBridgeLinksForServer(BRIDGE_PLUGIN_ID, serverId)
    ]);

    const categoryNames = new Map(tree.categories.map((c) => [c.id, c.name]));
    const plan = planServerBridge({
      local: tree.channels.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        e2ee: c.e2ee,
        private: c.private,
        categoryName: c.categoryId !== null ? (categoryNames.get(c.categoryId) ?? null) : null
      })),
      remote: listing.channels.map((c) => ({
        id: c.id,
        name: c.name,
        parentName: c.parentName,
        position: c.position
      })),
      existing: existing.map((row) => ({
        id: row.id,
        channelId: row.channelId,
        remoteChannelId: row.remoteChannelId,
        excluded: row.excluded,
        serverLinkId: row.serverLinkId,
        live: row.webhookId !== null
      })),
      mode: link.mode,
      createMissing: link.createMissing,
      remoteSkipped: (listing.skipped ?? []).map((s) => ({ name: s.name, reason: s.reason })),
      limit: MAX_SYNC_CHANNELS
    });

    report.skipped.push(...plan.skipped);
    await applyPlan(link, plan, tree, report);
  } catch (error) {
    report.error = errorMessage(error);
    logger.warn('[bridge] sync of server %d failed: %s', serverId, report.error);
  } finally {
    report.finishedAt = Date.now();
    report.skipped = report.skipped.slice(0, 100);

    // A server without a link has nothing to report against (a request
    // from the plugin for a server unlinked meanwhile, or made up):
    // nothing is remembered for it, not even the counter it came with.
    if (link) {
      lastReports.set(serverId, report);
      await persistReport(link.id, report);
    } else {
      seenSyncRequests.delete(serverId);
    }
  }

  return report;
};

/**
 * Run a sync for the server, or queue one behind the run in progress.
 * Resolves with the report of the run that covers this request.
 */
const syncServerBridge = (serverId: number, trigger: TBridgeSyncTrigger): Promise<TBridgeSyncReport> => {
  const current = running.get(serverId);

  if (current) {
    rerun.set(serverId, trigger);
    return current.then(() => running.get(serverId) ?? current);
  }

  const run = runSync(serverId, trigger).finally(() => {
    running.delete(serverId);
    const again = rerun.get(serverId);

    if (again !== undefined) {
      rerun.delete(serverId);
      void syncServerBridge(serverId, again);
    }
  });

  running.set(serverId, run);
  return run;
};

/**
 * The channel-create hook: cheap when the server has no link (one
 * indexed SELECT, awaited by the caller), a detached sync otherwise.
 */
const requestServerBridgeSync = async (serverId: number): Promise<void> => {
  if (!isBridgePluginLoaded()) return;

  const link = await getBridgeServerLink(BRIDGE_PLUGIN_ID, serverId);
  if (!link) return;

  void syncServerBridge(serverId, 'channel-created');
};

setBridgeChannelCreatedHook(requestServerBridgeSync);

/**
 * What the status shows: whether a run is under way (in-process only)
 * and the last report — the one in memory, or the one the link row
 * carries from before a restart.
 */
const getServerBridgeSyncState = (
  serverId: number,
  persisted: TBridgeSyncReport | null | undefined
) => ({
  running: running.has(serverId),
  last: lastReports.get(serverId) ?? persisted ?? null
});

/**
 * Act on the plugin's "the remote side changed" counter for a server:
 * a value we have not seen starts a sync. Returns whether one started.
 */
const noteSyncRequest = (serverId: number, requested: number | undefined, trigger: TBridgeSyncTrigger): boolean => {
  if (requested === undefined) return false;
  // The plugin starts every counter at 0: nothing has been asked yet.
  if ((seenSyncRequests.get(serverId) ?? 0) === requested) return false;

  seenSyncRequests.set(serverId, requested);
  void syncServerBridge(serverId, trigger);
  return true;
};

/**
 * The plugin's signal, delivered in-process the moment it calls
 * `ctx.server.notify('bridge:sync-requested', { serverId, requested })`:
 * the counter is recorded as seen (so the tick does not sync the same
 * change again) and a run starts at once — synchronously, so a caller
 * that then waits for the runs in flight sees this one. A signal
 * without a counter still starts a run. A server that is not linked
 * costs the run's first lookup and nothing more: no report is kept and
 * its counter is forgotten (runSync), so the plugin cannot grow the
 * server's memory with ids it made up.
 */
const syncRequestSchema = z.object({
  serverId: z.number().int().positive(),
  requested: z.number().int().nonnegative().optional()
});

const onPluginSyncRequested = (payload: unknown): void => {
  const parsed = syncRequestSchema.safeParse(payload);

  if (!parsed.success) {
    logger.debug('[bridge] ignored a malformed sync request from the plugin');
    return;
  }

  const { serverId, requested } = parsed.data;

  if (requested !== undefined) {
    noteSyncRequest(serverId, requested, 'plugin');
    return;
  }

  void syncServerBridge(serverId, 'plugin');
};

// Subscribed through the import-free registry: this module evaluates
// inside the routers' import cycle with plugins/index.ts (see
// plugins/subscriptions.ts), where the manager itself is not readable.
onPluginNotify(BRIDGE_PLUGIN_ID, 'bridge:sync-requested', onPluginSyncRequested);

/**
 * The bridge plugin just (re)loaded — boot, or the owner toggled it on:
 * every server link gets a run, so the channels created on either side
 * while it was away are paired without waiting for the tick. Awaited
 * by the loader as far as starting the runs; the runs themselves are
 * detached as always.
 */
const onBridgePluginLoaded = async (pluginId: string): Promise<void> => {
  if (pluginId !== BRIDGE_PLUGIN_ID) return;

  const links = await listBridgeServerLinks(BRIDGE_PLUGIN_ID);

  for (const link of links) {
    void syncServerBridge(link.serverId, 'load');
  }
};

onPluginLoaded(onBridgePluginLoaded);

/**
 * The once-a-minute tick. Nothing to do without the plugin or without
 * server links (one SELECT). Otherwise one in-process status call tells
 * us which servers the plugin wants re-synced (the backstop for a
 * signal that was lost); every link also gets a full reconcile every
 * FULL_RECONCILE_EVERY_MS, counted from the last run — the one in
 * memory or, after a restart, the one on the row — and one straight
 * away for a link that has never been synced.
 */
const bridgeSyncTick = async (now: number = Date.now()): Promise<void> => {
  if (!isBridgePluginLoaded()) return;

  const links = await listBridgeServerLinks(BRIDGE_PLUGIN_ID);
  if (links.length === 0) return;

  let status: Awaited<ReturnType<typeof pluginStatus>> | undefined;

  try {
    status = await pluginStatus({ serverIds: links.map((l) => l.serverId) });
  } catch (error) {
    logger.debug('[bridge] tick could not read the plugin status: %s', errorMessage(error));
  }

  for (const link of links) {
    if (running.has(link.serverId)) continue;

    if (noteSyncRequest(link.serverId, status?.syncRequested?.[String(link.serverId)], 'tick')) continue;

    const last = lastReports.get(link.serverId);
    const lastFinishedAt = last ? last.finishedAt : link.lastSyncAt;
    const due = lastFinishedAt === null || now - lastFinishedAt >= FULL_RECONCILE_EVERY_MS;

    if (due) void syncServerBridge(link.serverId, 'tick');
  }
};

/** Tests: wait for every detached run (and its queued follow-up) to settle. */
const awaitServerBridgeSyncs = async (): Promise<void> => {
  while (running.size > 0) {
    await Promise.allSettled([...running.values()]);
  }
};

/** Tests: forget reports and seen counters between cases. */
const resetServerBridgeSyncState = (): void => {
  lastReports.clear();
  seenSyncRequests.clear();
  rerun.clear();
};

/** "Sync channels now": starts a run (or queues one) and returns at once; the status route shows progress. */
const bridgeSyncRoute = serverProcedure(Permission.MANAGE_SETTINGS).mutation(async ({ ctx }) => {
  await requireServerLink(ctx.activeServerId);
  void syncServerBridge(ctx.activeServerId, 'manual');

  return { started: true };
});

export {
  awaitServerBridgeSyncs,
  bridgeSyncRoute,
  bridgeSyncTick,
  getServerBridgeSyncState,
  noteSyncRequest,
  requestServerBridgeSync,
  resetServerBridgeSyncState,
  syncServerBridge
};
