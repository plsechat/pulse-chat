import type {
  EventPayloads,
  PluginContext,
  TPluginHttpRequest,
  TPluginHttpResponse,
  TPluginMember
} from '@pulse/plugin-sdk';
import {
  GatewayClient,
  createWebSocketFactory,
  type TGatewayTimers,
  type TSocketFactory
} from './gateway';
import {
  avatarUrlOf,
  boundText,
  displayNameOf,
  mapInboundContent,
  mapInboundEmoji,
  mapOutboundContent,
  mapOutboundEmoji,
  quoteLine,
  MAX_AUTHOR_NAME
} from './mapping';
import { normalizeChannelName } from './pairing';
import { RestClient, RestError } from './rest';
import {
  BridgeStore,
  type TDirection,
  type TLink,
  type TServerLink,
  type TStateStorage
} from './store';
import type {
  TRemoteChannel,
  TRemoteGuild,
  TRemoteGuildEmoji,
  TRemoteMessage,
  TRemoteReactionEvent,
  TRemoteRole,
  TRemoteScheduledEvent,
  TRemoteUser,
  TRemoteWebhook
} from './types';

/**
 * The bridge itself: one gateway connection in, one REST client out,
 * and the two event streams mapped onto each other per linked channel.
 *
 * Loop prevention, both ways:
 *  - here → there → here: a message the bridge posts through the SDK
 *    carries `pluginId` on its `message:*` events and is skipped; a
 *    message the bridge sends through a webhook comes back on the
 *    gateway with that `webhook_id` and is skipped; the bot's own
 *    reactions and threads come back under the bot's user id.
 *  - there → here → there: a message the bridge posts here is deleted
 *    there only after its map entry is gone, so the `message:deleted`
 *    echo finds nothing to mirror; scheduled events apply inside an
 *    in-flight counter and remember the last state pushed so the echo
 *    of our own PATCH is recognised.
 *
 * The server is the record of which channels are linked (its routes
 * call the HTTP handlers below); this module keeps a copy without any
 * secret so it can resume after a restart, and resolves webhook tokens
 * through the bot when it needs one.
 *
 * Whole-server links: the server decides the pairing; this side lists
 * the remote channels (with categories and what it would not bridge),
 * creates a remote channel — and its category — when asked, and watches
 * the gateway for channel changes in a linked guild. A change over
 * there (or a reconnect, after which anything may have happened) bumps
 * a per-server counter and signals the server through
 * `ctx.server.notify('bridge:sync-requested')`, which syncs at once;
 * the counter is also reported from `status` so the server's minute
 * tick catches a signal that was lost.
 */

export const PLUGIN_ID = 'discord-bridge';
export const WEBHOOK_NAME = 'PULSE bridge';
const MAX_INBOUND_ATTACHMENTS = 10;
const MAX_OUTBOUND_ATTACHMENT_LINKS = 10;
const MEMBER_CACHE_TTL_MS = 5 * 60_000;
const MAX_RECENT_CONTENT = 2_000;
const MAX_GUILDS = 200;
const DEFAULT_EVENT_LENGTH_MS = 2 * 60 * 60_000;
const MAX_EVENT_LENGTH_MS = 24 * 60 * 60_000;
const ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const SNOWFLAKE = /^\d{1,20}$/;
/** Message types that carry a member's own words. */
const MIRRORED_MESSAGE_TYPES = new Set([0, 19]);
/** Channel types the picker offers: text and announcement. */
const LINKABLE_CHANNEL_TYPES = new Set([0, 5]);
/** Guild channel types a whole-server sync reports as left alone, in the owner's words. */
const SKIPPED_CHANNEL_TYPES = new Map<number, string>([
  [2, 'voice channel'],
  [13, 'stage channel'],
  [15, 'forum'],
  [16, 'media channel']
]);
const REMOTE_CATEGORY_TYPE = 4;
const REMOTE_TEXT_TYPE = 0;
/** Remote channel and category names are capped by the API at 100. */
const MAX_REMOTE_NAME = 100;
const MAX_REMOVE_MANY = 500;
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);
const REMOTE_EVENT_CANCELLED = 4;

type TGuildCache = {
  name: string;
  icon: string | null;
  roles: Map<string, string>;
  channels: Map<string, TRemoteChannel>;
  /** Custom emoji name → id. */
  emojis: Map<string, string>;
};

type TMemberCache = {
  at: number;
  byId: Map<number, TPluginMember>;
  roleNames: Map<number, string>;
};

type TRecentContent = { author: string; text: string };

/**
 * The message events as the server emits them today plus the fields a
 * bridge wants from them. `attachments` and `replyToId` are not on the
 * SDK payload yet; they are read optionally so they flow the day the
 * server adds them.
 */
// SDK 0.2 carries the reply target and the attachments on the event itself.
type TLocalMessageEvent = EventPayloads['message:created'];

export type TBridgeSettings = {
  botToken: () => string;
  publicUrl: () => string;
};

export type TBridgeOptions = {
  ctx: PluginContext;
  settings: TBridgeSettings;
  storage: TStateStorage;
  socketFactory?: TSocketFactory;
  timers?: TGatewayTimers;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
};

export type TLinkStatus = {
  known: boolean;
  mirroredToday: number;
  lastError: string | null;
};

export type TBridgeStatusReport = {
  configured: boolean;
  connected: boolean;
  fatal: string | null;
  lastError: string | null;
  botUser: { id: string; name: string } | null;
  links: Record<string, TLinkStatus>;
  /** Names from the gateway cache for the guild ids asked. */
  guilds: Record<string, { name: string }>;
  /** Per server id: bumped when the remote side changed; the server syncs when it moves. */
  syncRequested: Record<string, number>;
};

type TStatusQuery = {
  channelIds: number[];
  serverIds: number[];
  guildIds: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isNotFound = (error: unknown): boolean =>
  (error instanceof RestError && error.status === 404) ||
  (error instanceof Error && (error as { code?: string }).code === 'NOT_FOUND');

const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10);

const toIso = (ms: number): string => new Date(ms).toISOString();

const parseTime = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/** The webhook API refuses usernames carrying its own brand words. */
const safeWebhookName = (name: string): string => {
  const cleaned = boundText(name.replace(/discord|clyde/gi, '·'), MAX_AUTHOR_NAME, 'Member');
  return cleaned.length > 0 ? cleaned : 'Member';
};

const eventSignature = (event: {
  name: string;
  scheduled_start_time: string;
  scheduled_end_time?: string | null;
  status?: number;
}): string =>
  `${event.name}|${parseTime(event.scheduled_start_time) ?? 0}|${parseTime(event.scheduled_end_time) ?? 0}|${event.status ?? 1}`;

const json = (status: number, body: unknown): TPluginHttpResponse => ({ status, body });

export class Bridge {
  readonly store: BridgeStore;
  readonly rest: RestClient;
  readonly gateway: GatewayClient;

  private readonly ctx: PluginContext;
  private readonly settings: TBridgeSettings;
  private readonly now: () => number;
  private readonly guilds = new Map<string, TGuildCache>();
  private readonly webhookTokens = new Map<string, string>();
  private readonly members = new Map<number, TMemberCache>();
  private readonly recent = new Map<number, TRecentContent>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly mirrored = new Map<number, { day: string; count: number }>();
  private readonly linkErrors = new Map<number, string>();
  private readonly pushedEvents = new Map<string, string>();
  private readonly syncRequested = new Map<number, number>();
  private inboundEventsInFlight = 0;
  private started = false;
  private activeToken = '';

  constructor(options: TBridgeOptions) {
    this.ctx = options.ctx;
    this.settings = options.settings;
    this.now = options.now ?? Date.now;
    this.store = new BridgeStore(options.storage, (message) => this.ctx.error(message));
    this.rest = new RestClient({
      fetch: (url, init) => this.ctx.fetch(url, init),
      token: () => this.settings.botToken(),
      sleep: options.sleep,
      now: options.now
    });
    this.gateway = new GatewayClient({
      token: () => this.settings.botToken(),
      socketFactory: options.socketFactory ?? createWebSocketFactory(),
      timers: options.timers,
      random: options.random,
      onDispatch: (type, data) => this.handleDispatch(type, data),
      // After a (re)connect anything may have changed over there while
      // we were not listening: every server link asks for a sync.
      onStatus: (status) => {
        if (status.connected) this.requestSyncForAllServers();
      },
      log: (...message) => this.ctx.debug(...message)
    });
  }

  // ─── lifecycle ──────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.store.load();
    this.registerHttpRoutes();
    this.registerLocalEvents();

    this.activeToken = this.settings.botToken();

    if (this.activeToken) {
      this.gateway.start();
    } else {
      this.ctx.log('No bot token configured; the bridge stays idle until one is set');
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    this.gateway.stop();
    await this.store.flush();
  }

  /** Called on a timer: a changed token takes effect without a reload. */
  checkSettings(): void {
    if (!this.started) return;

    const token = this.settings.botToken();
    if (token === this.activeToken) return;

    this.activeToken = token;

    if (!token) {
      this.gateway.stop();
      this.ctx.log('Bot token cleared; the bridge is idle');
      return;
    }

    this.ctx.log('Bot token changed; reconnecting');
    this.gateway.restart();
  }

  get configured(): boolean {
    return this.activeToken.length > 0;
  }

  // ─── HTTP (the server's channel-settings routes call these) ─────────

  private registerHttpRoutes() {
    this.ctx.http.register('channels', (request) => this.handleChannelsRoute(request));
    this.ctx.http.register('links/upsert', (request) => this.handleLinkUpsert(request));
    this.ctx.http.register('links/remove', (request) => this.handleLinkRemove(request));
    this.ctx.http.register('links/remove-many', (request) => this.handleLinkRemoveMany(request));
    this.ctx.http.register('server-links/upsert', (request) => this.handleServerLinkUpsert(request));
    this.ctx.http.register('server-links/remove', (request) => this.handleServerLinkRemove(request));
    this.ctx.http.register('remote/create-channel', (request) => this.handleRemoteCreateChannel(request));
    this.ctx.http.register('status', (request) => this.handleStatus(request));
  }

  private async handleChannelsRoute(request: TPluginHttpRequest): Promise<TPluginHttpResponse> {
    if (!this.configured) return json(409, { error: 'No bot token is configured' });

    const body = isRecord(request.body) ? request.body : {};
    const guildId = typeof body.guildId === 'string' ? body.guildId : undefined;

    if (guildId !== undefined && !SNOWFLAKE.test(guildId)) {
      return json(400, { error: 'Invalid guild id' });
    }

    try {
      const guilds = (
        await this.rest.get<TRemoteGuild[]>('/users/@me/guilds', { query: { limit: 200 } })
      ).map((guild) => ({
        id: guild.id,
        name: boundText(guild.name, 100, 'Unnamed'),
        iconUrl:
          guild.icon && /^[a-z0-9_]+$/i.test(guild.icon)
            ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64`
            : null
      }));

      if (!guildId) return json(200, { guilds, channels: [] });

      const channels = await this.rest.get<TRemoteChannel[]>(`/guilds/${guildId}/channels`);
      const categories = new Map(
        channels
          .filter((c) => c.type === REMOTE_CATEGORY_TYPE)
          .map((c) => [c.id, boundText(c.name, MAX_REMOTE_NAME)])
      );
      const linkable = channels
        .filter((c) => LINKABLE_CHANNEL_TYPES.has(c.type))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((c) => ({
          id: c.id,
          guildId,
          name: boundText(c.name, MAX_REMOTE_NAME, 'unnamed'),
          parentId: c.parent_id ?? null,
          parentName: c.parent_id ? (categories.get(c.parent_id) ?? null) : null,
          position: c.position ?? 0
        }));
      const skipped = channels
        .filter((c) => SKIPPED_CHANNEL_TYPES.has(c.type))
        .map((c) => ({
          id: c.id,
          name: boundText(c.name, MAX_REMOTE_NAME, 'unnamed'),
          reason: SKIPPED_CHANNEL_TYPES.get(c.type)!
        }));

      return json(200, {
        guilds,
        channels: linkable,
        categories: [...categories.entries()].map(([id, name]) => ({ id, name })),
        skipped
      });
    } catch (error) {
      return json(502, { error: `Could not list the remote channels: ${errorMessage(error)}` });
    }
  }

  private async handleLinkUpsert(request: TPluginHttpRequest): Promise<TPluginHttpResponse> {
    const body = isRecord(request.body) ? request.body : {};
    const { channelId, serverId, remoteGuildId, remoteChannelId, direction } = body;

    if (
      !Number.isInteger(channelId) ||
      (channelId as number) <= 0 ||
      !Number.isInteger(serverId) ||
      (serverId as number) <= 0 ||
      typeof remoteGuildId !== 'string' ||
      !SNOWFLAKE.test(remoteGuildId) ||
      typeof remoteChannelId !== 'string' ||
      !SNOWFLAKE.test(remoteChannelId) ||
      (direction !== 'both' && direction !== 'inbound' && direction !== 'outbound')
    ) {
      return json(400, { error: 'Invalid link' });
    }

    const elsewhere = this.store.linkByRemoteChannel(remoteChannelId);
    if (elsewhere && elsewhere.channelId !== channelId) {
      return json(409, { error: 'That remote channel is already bridged to another channel' });
    }

    let webhookId = typeof body.webhookId === 'string' ? body.webhookId : undefined;
    let webhookToken = typeof body.webhookToken === 'string' ? body.webhookToken : undefined;

    if (webhookId === undefined) {
      if (!this.configured) return json(409, { error: 'No bot token is configured' });

      try {
        const webhook = await this.rest.post<TRemoteWebhook>(
          `/channels/${remoteChannelId}/webhooks`,
          { body: { name: WEBHOOK_NAME }, reason: 'Channel bridge' }
        );
        webhookId = webhook.id;
        webhookToken = webhook.token;
      } catch (error) {
        return json(502, { error: `Could not create the webhook: ${errorMessage(error)}` });
      }
    }

    if (webhookToken) this.webhookTokens.set(webhookId, webhookToken);

    this.store.setLink({
      channelId: channelId as number,
      serverId: serverId as number,
      remoteGuildId,
      remoteChannelId,
      webhookId,
      direction: direction as TDirection
    });
    this.linkErrors.delete(channelId as number);

    return json(200, { webhookId, webhookToken: webhookToken ?? null });
  }

  private async handleLinkRemove(request: TPluginHttpRequest): Promise<TPluginHttpResponse> {
    const body = isRecord(request.body) ? request.body : {};
    const channelId = body.channelId;

    if (!Number.isInteger(channelId) || (channelId as number) <= 0) {
      return json(400, { error: 'Invalid channel id' });
    }

    const link = this.store.removeLink(channelId as number);
    this.linkErrors.delete(channelId as number);
    this.mirrored.delete(channelId as number);

    if (!link) return json(200, { removed: false });

    this.webhookTokens.delete(link.webhookId);

    if (this.configured) {
      try {
        await this.rest.delete(`/webhooks/${link.webhookId}`, { reason: 'Channel bridge removed' });
      } catch (error) {
        // The link is gone either way; a webhook left behind is inert.
        this.ctx.debug(`Could not delete webhook ${link.webhookId}: ${errorMessage(error)}`);
      }
    }

    return json(200, { removed: true });
  }

  private async handleLinkRemoveMany(request: TPluginHttpRequest): Promise<TPluginHttpResponse> {
    const body = isRecord(request.body) ? request.body : {};
    const channelIds = Array.isArray(body.channelIds)
      ? body.channelIds
          .filter((id): id is number => Number.isInteger(id) && (id as number) > 0)
          .slice(0, MAX_REMOVE_MANY)
      : null;

    if (!channelIds) return json(400, { error: 'Invalid channel ids' });

    const webhookIds: string[] = [];

    for (const channelId of channelIds) {
      const link = this.store.removeLink(channelId);
      this.linkErrors.delete(channelId);
      this.mirrored.delete(channelId);
      if (!link) continue;

      this.webhookTokens.delete(link.webhookId);
      webhookIds.push(link.webhookId);
    }

    // The links are gone now; the webhooks go one by one under the REST
    // budget, so a server with hundreds of pairs does not hold the
    // owner's request open for minutes. A webhook left behind is inert.
    if (this.configured && webhookIds.length > 0) {
      void this.chain('webhook-cleanup', async () => {
        for (const webhookId of webhookIds) {
          try {
            await this.rest.delete(`/webhooks/${webhookId}`, { reason: 'Server bridge removed' });
          } catch (error) {
            this.ctx.debug(`Could not delete webhook ${webhookId}: ${errorMessage(error)}`);
          }
        }
      });
    }

    return json(200, { removed: webhookIds.length });
  }

  private handleServerLinkUpsert(request: TPluginHttpRequest): TPluginHttpResponse {
    const body = isRecord(request.body) ? request.body : {};
    const { serverId, remoteGuildId, mode, createMissing, defaultDirection } = body;

    if (
      !Number.isInteger(serverId) ||
      (serverId as number) <= 0 ||
      typeof remoteGuildId !== 'string' ||
      !SNOWFLAKE.test(remoteGuildId) ||
      (mode !== 'mirror' && mode !== 'match') ||
      (createMissing !== 'both' &&
        createMissing !== 'here' &&
        createMissing !== 'there' &&
        createMissing !== 'none') ||
      (defaultDirection !== 'both' && defaultDirection !== 'inbound' && defaultDirection !== 'outbound')
    ) {
      return json(400, { error: 'Invalid server link' });
    }

    this.store.setServerLink({
      serverId: serverId as number,
      remoteGuildId,
      mode,
      createMissing,
      defaultDirection
    });

    return json(200, { ok: true });
  }

  private handleServerLinkRemove(request: TPluginHttpRequest): TPluginHttpResponse {
    const body = isRecord(request.body) ? request.body : {};
    const serverId = body.serverId;

    if (!Number.isInteger(serverId) || (serverId as number) <= 0) {
      return json(400, { error: 'Invalid server id' });
    }

    const removed = this.store.removeServerLink(serverId as number);
    this.syncRequested.delete(serverId as number);

    return json(200, { removed: removed !== undefined });
  }

  /**
   * Create a text channel over there for a whole-server mirror, under a
   * category of the given name — found by normalised name among the
   * guild's categories, created when there is none. The fresh listing
   * (not the gateway cache) is what decides, so two syncs in a row do
   * not make two categories.
   */
  private async handleRemoteCreateChannel(request: TPluginHttpRequest): Promise<TPluginHttpResponse> {
    if (!this.configured) return json(409, { error: 'No bot token is configured' });

    const body = isRecord(request.body) ? request.body : {};
    const guildId = body.guildId;
    const name = boundText(typeof body.name === 'string' ? body.name : '', MAX_REMOTE_NAME);
    const categoryName =
      typeof body.categoryName === 'string' ? boundText(body.categoryName, MAX_REMOTE_NAME) : '';

    if (typeof guildId !== 'string' || !SNOWFLAKE.test(guildId) || name.length === 0) {
      return json(400, { error: 'Invalid channel' });
    }

    try {
      let parent: { id: string; name: string } | null = null;

      if (categoryName.length > 0) {
        const wanted = normalizeChannelName(categoryName);
        const channels = await this.rest.get<TRemoteChannel[]>(`/guilds/${guildId}/channels`);
        const known = channels.find(
          (c) => c.type === REMOTE_CATEGORY_TYPE && normalizeChannelName(c.name ?? '') === wanted
        );

        if (known) {
          parent = { id: known.id, name: boundText(known.name, MAX_REMOTE_NAME) };
        } else {
          const created = await this.rest.post<TRemoteChannel>(`/guilds/${guildId}/channels`, {
            body: { name: categoryName, type: REMOTE_CATEGORY_TYPE },
            reason: 'Server bridge: category mirrored'
          });
          parent = { id: created.id, name: boundText(created.name, MAX_REMOTE_NAME, categoryName) };
          this.cacheChannel({ ...created, guild_id: guildId });
        }
      }

      const created = await this.rest.post<TRemoteChannel>(`/guilds/${guildId}/channels`, {
        body: { name, type: REMOTE_TEXT_TYPE, parent_id: parent?.id },
        reason: 'Server bridge: channel mirrored'
      });
      this.cacheChannel({ ...created, guild_id: guildId });

      return json(200, {
        id: created.id,
        name: boundText(created.name, MAX_REMOTE_NAME, name),
        parentId: parent?.id ?? null,
        parentName: parent?.name ?? null
      });
    } catch (error) {
      return json(502, { error: `Could not create the remote channel: ${errorMessage(error)}` });
    }
  }

  private handleStatus(request: TPluginHttpRequest): TPluginHttpResponse {
    const body = isRecord(request.body) ? request.body : {};
    const ints = (value: unknown) =>
      Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id)).slice(0, 500) : [];
    const snowflakes = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((id): id is string => typeof id === 'string' && SNOWFLAKE.test(id)).slice(0, 100)
        : [];

    return json(
      200,
      this.statusReport({
        channelIds: ints(body.channelIds),
        serverIds: ints(body.serverIds),
        guildIds: snowflakes(body.guildIds)
      })
    );
  }

  statusReport(query: number[] | TStatusQuery): TBridgeStatusReport {
    const asked: TStatusQuery = Array.isArray(query)
      ? { channelIds: query, serverIds: [], guildIds: [] }
      : query;
    const { status } = this.gateway;
    const links: Record<string, TLinkStatus> = {};
    const today = dayOf(this.now());
    const serverIds = new Set(asked.serverIds);
    const channelIds = new Set(asked.channelIds);

    // A server's links are every link into it (whole-server status).
    for (const link of this.store.links.values()) {
      if (serverIds.has(link.serverId)) channelIds.add(link.channelId);
    }

    for (const channelId of channelIds) {
      const counter = this.mirrored.get(channelId);
      links[String(channelId)] = {
        known: this.store.links.has(channelId),
        mirroredToday: counter && counter.day === today ? counter.count : 0,
        lastError: this.linkErrors.get(channelId) ?? null
      };
    }

    const guilds: Record<string, { name: string }> = {};
    for (const guildId of asked.guildIds) {
      const cached = this.guilds.get(guildId);
      if (cached && cached.name.length > 0) guilds[guildId] = { name: cached.name };
    }

    const syncRequested: Record<string, number> = {};
    for (const serverId of asked.serverIds) {
      syncRequested[String(serverId)] = this.syncRequested.get(serverId) ?? 0;
    }

    return {
      configured: this.configured,
      connected: status.connected,
      fatal: status.fatal,
      lastError: status.lastError,
      botUser:
        status.botUserId && status.botUsername
          ? { id: status.botUserId, name: status.botUsername }
          : null,
      links,
      guilds,
      syncRequested
    };
  }

  // ─── whole-server links: asking the server for a sync ───────────────

  /** Something changed over there for this server: tell the server now; the counter is the tick's backstop. */
  private requestSync(serverId: number) {
    const requested = (this.syncRequested.get(serverId) ?? 0) + 1;
    this.syncRequested.set(serverId, requested);

    try {
      this.ctx.server.notify('bridge:sync-requested', { serverId, requested });
    } catch (error) {
      this.ctx.debug(
        `Could not signal the server for a sync of server ${serverId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private requestSyncForGuild(remoteGuildId: string) {
    const link = this.store.serverLinkForGuild(remoteGuildId);
    if (link) this.requestSync(link.serverId);
  }

  private requestSyncForAllServers() {
    for (const link of this.store.serverLinks.values()) this.requestSync(link.serverId);
  }

  /** Tests: the counter the server reads for a server. */
  syncRequestsFor(serverId: number): number {
    return this.syncRequested.get(serverId) ?? 0;
  }

  // ─── helpers ────────────────────────────────────────────────────────

  /** Serialise work per key so an edit never runs before its create. */
  private chain(key: string, work: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(work, work).catch((error) => {
      this.ctx.error(`${key}: ${errorMessage(error)}`);
    });

    this.chains.set(key, next);
    void next.then(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });

    return next;
  }

  /** Every chained piece of work has settled (tests wait on this). */
  async idle(): Promise<void> {
    while (this.chains.size > 0) {
      await Promise.all([...this.chains.values()]);
    }
  }

  private countMirrored(channelId: number) {
    const today = dayOf(this.now());
    const counter = this.mirrored.get(channelId);

    if (counter && counter.day === today) counter.count++;
    else this.mirrored.set(channelId, { day: today, count: 1 });
  }

  private noteLinkError(channelId: number, error: unknown) {
    const message = errorMessage(error);
    this.linkErrors.set(channelId, message);
    this.ctx.error(`Channel ${channelId}: ${message}`);
  }

  private isOurWebhook(webhookId: string | undefined): boolean {
    if (!webhookId) return false;
    for (const link of this.store.links.values()) {
      if (link.webhookId === webhookId) return true;
    }
    return false;
  }

  private isBot(userId: string | undefined): boolean {
    return userId !== undefined && userId === this.gateway.status.botUserId;
  }

  /** The local channel a remote channel or thread maps to. */
  private localTarget(remoteChannelId: string): { link: TLink; localChannelId: number } | undefined {
    const link = this.store.linkByRemoteChannel(remoteChannelId);
    if (link) return { link, localChannelId: link.channelId };

    const thread = this.store.threadByRemote(remoteChannelId);
    if (!thread) return undefined;

    const parent = this.store.links.get(thread.channelId);
    return parent ? { link: parent, localChannelId: thread.localThreadId } : undefined;
  }

  /** The remote channel (and thread) a local channel maps to. */
  private remoteTarget(localChannelId: number): { link: TLink; threadId?: string } | undefined {
    const link = this.store.links.get(localChannelId);
    if (link) return { link };

    const thread = this.store.threads.get(localChannelId);
    if (!thread) return undefined;

    const parent = this.store.links.get(thread.channelId);
    return parent ? { link: parent, threadId: thread.remoteThreadId } : undefined;
  }

  private async webhookToken(link: TLink): Promise<string> {
    const known = this.webhookTokens.get(link.webhookId);
    if (known) return known;

    // After a restart the token is gone from memory; the bot that
    // created the webhook may read it back.
    const webhook = await this.rest.get<TRemoteWebhook>(`/webhooks/${link.webhookId}`);
    if (!webhook.token) throw new Error('The webhook token is not readable by the bot');

    this.webhookTokens.set(link.webhookId, webhook.token);
    return webhook.token;
  }

  private async memberCache(serverId: number): Promise<TMemberCache> {
    const cached = this.members.get(serverId);
    if (cached && this.now() - cached.at < MEMBER_CACHE_TTL_MS) return cached;

    const list = await this.ctx.actions.members.list(serverId);
    const byId = new Map<number, TPluginMember>();
    const roleNames = new Map<number, string>();

    for (const member of list) {
      byId.set(member.id, member);
      for (const role of member.roles) roleNames.set(role.id, role.name);
    }

    const fresh = { at: this.now(), byId, roleNames };
    this.members.set(serverId, fresh);
    return fresh;
  }

  private guild(guildId: string): TGuildCache {
    let guild = this.guilds.get(guildId);

    if (!guild) {
      if (this.guilds.size >= MAX_GUILDS) {
        const oldest = this.guilds.keys().next();
        if (!oldest.done) this.guilds.delete(oldest.value);
      }
      guild = { name: '', icon: null, roles: new Map(), channels: new Map(), emojis: new Map() };
      this.guilds.set(guildId, guild);
    }

    return guild;
  }

  private rememberContent(localId: number, author: string, text: string) {
    this.recent.delete(localId);
    this.recent.set(localId, { author, text });

    while (this.recent.size > MAX_RECENT_CONTENT) {
      const oldest = this.recent.keys().next();
      if (oldest.done) break;
      this.recent.delete(oldest.value);
    }
  }

  private absoluteUrl(url: string | undefined): string | undefined {
    if (!url) return undefined;
    if (/^https?:\/\//i.test(url)) return url;

    const base = this.settings.publicUrl().trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) return undefined;

    return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  // ─── remote → here ──────────────────────────────────────────────────

  async handleDispatch(type: string, data: unknown): Promise<void> {
    switch (type) {
      case 'GUILD_CREATE':
      case 'GUILD_UPDATE':
        return this.cacheGuild(data as TRemoteGuild);
      case 'GUILD_DELETE':
        if (isRecord(data) && typeof data.id === 'string') this.guilds.delete(data.id);
        return;
      case 'CHANNEL_CREATE':
        return this.onRemoteChannelCreate(data as TRemoteChannel);
      case 'CHANNEL_UPDATE':
        // A rename keeps the pair: links are by id. Only the cache moves.
        return this.cacheChannel(data as TRemoteChannel);
      case 'CHANNEL_DELETE':
        return this.onRemoteChannelDelete(data as TRemoteChannel);
      case 'GUILD_ROLE_CREATE':
      case 'GUILD_ROLE_UPDATE': {
        const payload = data as { guild_id: string; role: TRemoteRole };
        if (payload?.role) this.guild(payload.guild_id).roles.set(payload.role.id, payload.role.name);
        return;
      }
      case 'GUILD_ROLE_DELETE': {
        const payload = data as { guild_id: string; role_id: string };
        this.guilds.get(payload.guild_id)?.roles.delete(payload.role_id);
        return;
      }
      case 'GUILD_EMOJIS_UPDATE': {
        const payload = data as { guild_id: string; emojis: TRemoteGuildEmoji[] };
        this.cacheEmojis(this.guild(payload.guild_id), payload.emojis ?? []);
        return;
      }
      case 'MESSAGE_CREATE':
        return this.onRemoteMessageCreate(data as TRemoteMessage);
      case 'MESSAGE_UPDATE':
        return this.onRemoteMessageUpdate(data as TRemoteMessage);
      case 'MESSAGE_DELETE': {
        const payload = data as { id: string; channel_id: string };
        return this.onRemoteMessageDelete(payload.id);
      }
      case 'MESSAGE_DELETE_BULK': {
        const payload = data as { ids: string[]; channel_id: string };
        for (const id of (payload.ids ?? []).slice(0, 100)) await this.onRemoteMessageDelete(id);
        return;
      }
      case 'MESSAGE_REACTION_ADD':
        return this.onRemoteReaction(data as TRemoteReactionEvent, true);
      case 'MESSAGE_REACTION_REMOVE':
        return this.onRemoteReaction(data as TRemoteReactionEvent, false);
      case 'THREAD_CREATE':
        return this.onRemoteThreadCreate(data as TRemoteChannel & { owner_id?: string });
      case 'GUILD_SCHEDULED_EVENT_CREATE':
        return this.onRemoteEventCreate(data as TRemoteScheduledEvent);
      case 'GUILD_SCHEDULED_EVENT_UPDATE':
        return this.onRemoteEventUpdate(data as TRemoteScheduledEvent);
      case 'GUILD_SCHEDULED_EVENT_DELETE':
        return this.onRemoteEventDelete(data as TRemoteScheduledEvent);
      default:
        return;
    }
  }

  private cacheGuild(guild: TRemoteGuild) {
    if (!guild?.id) return;

    const cache = this.guild(guild.id);
    cache.name = boundText(guild.name, 100);
    cache.icon = guild.icon ?? null;

    for (const role of (guild.roles ?? []).slice(0, 250)) cache.roles.set(role.id, role.name);
    for (const channel of (guild.channels ?? []).slice(0, 500)) cache.channels.set(channel.id, channel);
    if (guild.emojis) this.cacheEmojis(cache, guild.emojis);
  }

  private cacheEmojis(cache: TGuildCache, emojis: TRemoteGuildEmoji[]) {
    cache.emojis.clear();
    for (const emoji of emojis.slice(0, 250)) {
      if (emoji.id && emoji.name) cache.emojis.set(emoji.name, emoji.id);
    }
  }

  private cacheChannel(channel: TRemoteChannel) {
    if (!channel?.id || !channel.guild_id) return;
    this.guild(channel.guild_id).channels.set(channel.id, channel);
  }

  private onRemoteChannelCreate(channel: TRemoteChannel) {
    this.cacheChannel(channel);

    // A new text channel in a guild linked as a whole: the server pairs
    // it (by name, or by creating its twin here) on its next sync.
    if (channel?.guild_id && LINKABLE_CHANNEL_TYPES.has(channel.type)) {
      this.requestSyncForGuild(channel.guild_id);
    }
  }

  private onRemoteChannelDelete(channel: TRemoteChannel) {
    if (!channel?.id) return;
    if (channel.guild_id) this.guilds.get(channel.guild_id)?.channels.delete(channel.id);

    const thread = this.store.threadByRemote(channel.id);
    if (thread) this.store.removeThread(thread.localThreadId);

    // A linked remote channel is gone: the pair ends here (nothing is
    // deleted on our side — deletion is never mirrored) and the server
    // drops its row on the next sync.
    const link = this.store.linkByRemoteChannel(channel.id);
    if (link) {
      this.store.removeLink(link.channelId);
      this.webhookTokens.delete(link.webhookId);
      this.linkErrors.delete(link.channelId);
      this.requestSync(link.serverId);
      this.ctx.log(`Remote channel ${channel.id} was deleted; channel ${link.channelId} is no longer bridged`);
    } else if (channel.guild_id && LINKABLE_CHANNEL_TYPES.has(channel.type)) {
      this.requestSyncForGuild(channel.guild_id);
    }
  }

  private inboundLookup(guildId: string) {
    const guild = this.guilds.get(guildId);
    return {
      roleName: (id: string) => guild?.roles.get(id),
      channelName: (id: string) => guild?.channels.get(id)?.name
    };
  }

  private isAttachmentUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && ATTACHMENT_HOSTS.has(parsed.hostname);
    } catch {
      return false;
    }
  }

  private async onRemoteMessageCreate(message: TRemoteMessage) {
    if (!message?.id || !message.author) return;
    if (this.isOurWebhook(message.webhook_id) || this.isBot(message.author.id)) return;
    if (!MIRRORED_MESSAGE_TYPES.has(message.type ?? 0)) return;

    const target = this.localTarget(message.channel_id);
    if (!target || target.link.direction === 'outbound') return;

    const { link, localChannelId } = target;
    const author = message.author;

    await this.chain(`remote:${message.id}`, async () => {
      let content = mapInboundContent(message, this.inboundLookup(link.remoteGuildId));
      const attachments: { fileId: number }[] = [];
      const unsaved: string[] = [];

      for (const attachment of (message.attachments ?? []).slice(0, MAX_INBOUND_ATTACHMENTS)) {
        const name = boundText(attachment.filename, 120, 'attachment');

        if (!this.isAttachmentUrl(attachment.url)) {
          unsaved.push(name);
          continue;
        }

        try {
          const file = await this.ctx.actions.files.upload({
            url: attachment.url,
            filename: name,
            mime: attachment.content_type
          });
          attachments.push({ fileId: file.id });
        } catch (error) {
          this.ctx.debug(`Attachment ${name} not re-hosted: ${errorMessage(error)}`);
          unsaved.push(name);
        }
      }

      if (unsaved.length > 0) {
        const lines = unsaved.map((name) => `[attachment: ${name}]`).join('\n');
        content = content.length > 0 ? `${content}\n${lines}` : lines;
      }

      if (content.length === 0 && attachments.length === 0) return;

      const persona = {
        name: displayNameOf(author, message.member),
        avatarUrl: avatarUrlOf(author, message.member, link.remoteGuildId)
      };
      this.store.rememberPersona(author.id, persona);

      const repliedTo = message.message_reference?.message_id
        ? this.store.messageByRemote(message.message_reference.message_id)
        : undefined;

      try {
        const { messageId } = await this.ctx.actions.messages.post({
          channelId: localChannelId,
          content,
          author: persona,
          externalId: message.id,
          attachments: attachments.length > 0 ? attachments : undefined,
          replyToId: repliedTo?.localId
        });

        this.store.setMessage({
          localId: messageId,
          remoteId: message.id,
          remoteChannelId: message.channel_id,
          origin: 'in'
        });
        this.rememberContent(messageId, persona.name, content);
        this.countMirrored(link.channelId);
        this.linkErrors.delete(link.channelId);
      } catch (error) {
        if (isNotFound(error)) {
          // The local channel is gone: the server dropped the row by
          // cascade, so the copy here is stale.
          this.store.removeLink(link.channelId);
          this.ctx.log(`Channel ${link.channelId} no longer exists; link dropped`);
          return;
        }
        this.noteLinkError(link.channelId, error);
      }
    });
  }

  private async onRemoteMessageUpdate(message: TRemoteMessage) {
    // Embed-only updates carry no content; nothing to mirror.
    if (!message?.id || typeof message.content !== 'string') return;
    if (this.isOurWebhook(message.webhook_id) || this.isBot(message.author?.id)) return;

    const target = this.localTarget(message.channel_id);
    if (!target || target.link.direction === 'outbound') return;

    // Lookups happen inside the chain: the create this edit follows may
    // still be in flight.
    await this.chain(`remote:${message.id}`, async () => {
      const entry = this.store.messageByRemote(message.id);
      if (!entry || entry.origin !== 'in') return;

      const content = mapInboundContent(message, this.inboundLookup(target.link.remoteGuildId));
      if (content.length === 0) return;

      await this.ctx.actions.messages.edit({ externalId: message.id, content });

      const known = this.recent.get(entry.localId);
      if (known) this.rememberContent(entry.localId, known.author, content);
    });
  }

  private async onRemoteMessageDelete(remoteId: string) {
    if (!remoteId) return;

    await this.chain(`remote:${remoteId}`, async () => {
      // Drop the map entry first: the `message:deleted` echo then finds
      // nothing to send back.
      const entry = this.store.removeMessageByRemote(remoteId);
      if (!entry) return;

      this.recent.delete(entry.localId);

      try {
        await this.ctx.actions.messages.delete(
          entry.origin === 'in' ? { externalId: remoteId } : { messageId: entry.localId }
        );
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    });
  }

  private async onRemoteReaction(event: TRemoteReactionEvent, added: boolean) {
    if (!event?.message_id || this.isBot(event.user_id)) return;

    const target = this.localTarget(event.channel_id);
    if (!target || target.link.direction === 'outbound') return;

    const emoji = mapInboundEmoji(event.emoji);
    if (!emoji) return;

    await this.chain(`remote:${event.message_id}`, async () => {
      const entry = this.store.messageByRemote(event.message_id);
      if (!entry) return;

      try {
        await this.ctx.actions.messages.react({ messageId: entry.localId, emoji, remove: !added });
      } catch (error) {
        // A custom emoji that only exists over there is not an error
        // worth surfacing on the status card.
        this.ctx.debug(`Reaction ${emoji} not mirrored: ${errorMessage(error)}`);
      }
    });
  }

  private async onRemoteThreadCreate(thread: TRemoteChannel & { owner_id?: string }) {
    if (!thread?.id || !thread.parent_id || !THREAD_CHANNEL_TYPES.has(thread.type)) return;
    if (thread.newly_created !== true || this.isBot(thread.owner_id)) return;
    if (this.store.threadByRemote(thread.id)) return;

    const link = this.store.linkByRemoteChannel(thread.parent_id);
    if (!link || link.direction === 'outbound') return;

    const name = boundText(thread.name, 100, 'Thread');

    await this.chain(`remote:${thread.id}`, async () => {
      // A thread started from a message shares that message's id, and
      // that message's post may still be in flight on this same chain.
      const starter = this.store.messageByRemote(thread.id);

      try {
        const created = await this.ctx.actions.channels.createThread({
          channelId: link.channelId,
          parentMessageId: starter?.localId,
          name
        });

        this.store.setThread({
          localThreadId: created.id,
          remoteThreadId: thread.id,
          channelId: link.channelId,
          remoteChannelId: link.remoteChannelId
        });
      } catch (error) {
        this.noteLinkError(link.channelId, error);
      }
    });
  }

  private async onRemoteEventCreate(event: TRemoteScheduledEvent) {
    if (!event?.id || this.isBot(event.creator_id ?? undefined)) return;
    if (this.store.eventByRemote(event.id)) return;

    const link = this.store.linkForGuild(event.guild_id);
    if (!link || link.direction === 'outbound') return;

    const startsAt = parseTime(event.scheduled_start_time);
    if (startsAt === null) return;

    const endsAt = Math.min(
      parseTime(event.scheduled_end_time) ?? startsAt + DEFAULT_EVENT_LENGTH_MS,
      startsAt + MAX_EVENT_LENGTH_MS
    );
    const location = event.entity_metadata?.location
      ? `\nWhere: ${boundText(event.entity_metadata.location, 200)}`
      : '';

    await this.chain(`remote-event:${event.id}`, async () => {
      this.inboundEventsInFlight++;
      try {
        const created = await this.ctx.actions.events.create({
          serverId: link.serverId,
          title: boundText(event.name, 120, 'Event'),
          description: boundText(`${event.description ?? ''}${location}`, 2000) || undefined,
          startsAt,
          endsAt: endsAt > startsAt ? endsAt : startsAt + DEFAULT_EVENT_LENGTH_MS,
          hostId: null,
          roles: [{ key: 'going', label: 'Going', cap: null, color: null }]
        });

        this.store.setEvent({
          localEventId: created.id,
          remoteEventId: event.id,
          remoteGuildId: event.guild_id,
          origin: 'in'
        });
        this.pushedEvents.set(event.id, eventSignature(event));
      } catch (error) {
        this.noteLinkError(link.channelId, error);
      } finally {
        this.inboundEventsInFlight--;
      }
    });
  }

  private async onRemoteEventUpdate(event: TRemoteScheduledEvent) {
    if (!event?.id) return;

    const entry = this.store.eventByRemote(event.id);
    if (!entry) return;

    // The echo of our own PATCH comes back as an update: same state as
    // we pushed, nothing to apply.
    const signature = eventSignature(event);
    if (this.pushedEvents.get(event.id) === signature) return;
    this.pushedEvents.set(event.id, signature);

    if (event.status === REMOTE_EVENT_CANCELLED) return this.onRemoteEventDelete(event);

    const startsAt = parseTime(event.scheduled_start_time);
    if (startsAt === null) return;

    const endsAt = Math.min(
      parseTime(event.scheduled_end_time) ?? startsAt + DEFAULT_EVENT_LENGTH_MS,
      startsAt + MAX_EVENT_LENGTH_MS
    );

    await this.chain(`remote-event:${event.id}`, async () => {
      this.inboundEventsInFlight++;
      try {
        await this.ctx.actions.events.update(entry.localEventId, {
          title: boundText(event.name, 120, 'Event'),
          startsAt,
          endsAt: endsAt > startsAt ? endsAt : startsAt + DEFAULT_EVENT_LENGTH_MS
        });
      } catch (error) {
        if (!isNotFound(error)) throw error;
        this.store.removeEventByLocal(entry.localEventId);
      } finally {
        this.inboundEventsInFlight--;
      }
    });
  }

  private async onRemoteEventDelete(event: TRemoteScheduledEvent) {
    if (!event?.id) return;

    const entry = this.store.eventByRemote(event.id);
    if (!entry) return;

    this.store.removeEventByLocal(entry.localEventId);
    this.pushedEvents.delete(event.id);

    await this.chain(`remote-event:${event.id}`, async () => {
      this.inboundEventsInFlight++;
      try {
        await this.ctx.actions.events.cancel(entry.localEventId);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      } finally {
        this.inboundEventsInFlight--;
      }
    });
  }

  // ─── here → remote ──────────────────────────────────────────────────

  private registerLocalEvents() {
    this.ctx.events.on('message:created', (payload) => this.onLocalMessageCreated(payload));
    this.ctx.events.on('message:updated', (payload) => this.onLocalMessageUpdated(payload));
    this.ctx.events.on('message:deleted', (payload) => this.onLocalMessageDeleted(payload));
    this.ctx.events.on('message:reaction', (payload) => this.onLocalReaction(payload));
    this.ctx.events.on('thread:created', (payload) => this.onLocalThreadCreated(payload));
    this.ctx.events.on('event:created', (payload) => this.onLocalEventCreated(payload));
    this.ctx.events.on('event:updated', (payload) => this.onLocalEventUpdated(payload));
    this.ctx.events.on('event:cancelled', (payload) => this.onLocalEventCancelled(payload));

    // Names and avatars change with membership; drop the cache rather
    // than mirror a stale persona for up to five minutes.
    const forget = ({ serverId }: { serverId: number }) => {
      this.members.delete(serverId);
    };
    this.ctx.events.on('member:joined', forget);
    this.ctx.events.on('member:left', forget);
    this.ctx.events.on('member:roles_changed', forget);
  }

  private async webhookPersona(serverId: number, userId: number) {
    const cache = await this.memberCache(serverId);
    const member = cache.byId.get(userId);
    const name = member?.nickname || member?.name || 'Member';

    return {
      username: safeWebhookName(name),
      avatar_url: this.absoluteUrl(member?.avatarUrl),
      displayName: boundText(name, MAX_AUTHOR_NAME, 'Member'),
      lookup: {
        userName: (id: number) => {
          const m = cache.byId.get(id);
          return m ? m.nickname || m.name : undefined;
        },
        roleName: (id: number) => cache.roleNames.get(id)
      }
    };
  }

  private async onLocalMessageCreated(payload: TLocalMessageEvent) {
    if (payload.pluginId === PLUGIN_ID) return;

    const target = this.remoteTarget(payload.channelId);
    if (!target || target.link.direction === 'inbound') return;

    const { link, threadId } = target;

    await this.chain(`local:${payload.messageId}`, async () => {
      try {
        const persona = await this.webhookPersona(link.serverId, payload.userId);
        let content = mapOutboundContent(payload.content ?? '', persona.lookup);

        if (payload.replyToId != null) {
          const quoted = this.recent.get(payload.replyToId);
          if (quoted) content = `${quoteLine(quoted.author, quoted.text)}\n${content}`;
        }

        const links = (payload.attachments ?? [])
          .slice(0, MAX_OUTBOUND_ATTACHMENT_LINKS)
          .map((attachment) => this.absoluteUrl(attachment.url))
          .filter((url): url is string => url !== undefined);

        if (links.length > 0) {
          content = content.length > 0 ? `${content}\n${links.join('\n')}` : links.join('\n');
        }

        if (content.trim().length === 0) return;

        const token = await this.webhookToken(link);
        const sent = await this.rest.post<TRemoteMessage>(
          `/webhooks/${link.webhookId}/${token}`,
          {
            auth: false,
            query: { wait: true, thread_id: threadId },
            body: {
              content,
              username: persona.username,
              avatar_url: persona.avatar_url,
              allowed_mentions: { parse: [] }
            }
          }
        );

        this.store.setMessage({
          localId: payload.messageId,
          remoteId: sent.id,
          remoteChannelId: sent.channel_id,
          origin: 'out'
        });
        this.rememberContent(payload.messageId, persona.displayName, content);
        this.countMirrored(link.channelId);
        this.linkErrors.delete(link.channelId);
      } catch (error) {
        this.noteLinkError(link.channelId, error);
      }
    });
  }

  private async onLocalMessageUpdated(payload: EventPayloads['message:updated']) {
    if (payload.pluginId === PLUGIN_ID) return;

    const target = this.remoteTarget(payload.channelId);
    if (!target || target.link.direction === 'inbound') return;

    await this.chain(`local:${payload.messageId}`, async () => {
      const entry = this.store.messageByLocal(payload.messageId);
      // Only a message written here can be edited over there: the
      // webhook owns it. An inbound copy edited here stays local.
      if (!entry || entry.origin !== 'out') return;

      try {
        const persona = await this.webhookPersona(target.link.serverId, payload.userId);
        const content = mapOutboundContent(payload.content ?? '', persona.lookup);
        if (content.length === 0) return;

        const token = await this.webhookToken(target.link);
        await this.rest.patch(
          `/webhooks/${target.link.webhookId}/${token}/messages/${entry.remoteId}`,
          { auth: false, query: { thread_id: target.threadId }, body: { content } }
        );

        const known = this.recent.get(payload.messageId);
        if (known) this.rememberContent(payload.messageId, known.author, content);
      } catch (error) {
        if (isNotFound(error)) {
          this.store.removeMessageByLocal(payload.messageId);
          return;
        }
        this.noteLinkError(target.link.channelId, error);
      }
    });
  }

  private async onLocalMessageDeleted(payload: EventPayloads['message:deleted']) {
    const target = this.remoteTarget(payload.channelId);
    if (!target) return;

    await this.chain(`local:${payload.messageId}`, async () => {
      const entry = this.store.removeMessageByLocal(payload.messageId);
      if (!entry) return;

      this.recent.delete(payload.messageId);

      try {
        if (entry.origin === 'out') {
          const token = await this.webhookToken(target.link);
          await this.rest.delete(
            `/webhooks/${target.link.webhookId}/${token}/messages/${entry.remoteId}`,
            { auth: false, query: { thread_id: target.threadId } }
          );
        } else {
          // A moderator removed the copy here: take the original down
          // too, with the bot (it needs manage-messages over there).
          await this.rest.delete(`/channels/${entry.remoteChannelId}/messages/${entry.remoteId}`, {
            reason: 'Removed on the bridged side'
          });
        }
      } catch (error) {
        if (!isNotFound(error)) this.noteLinkError(target.link.channelId, error);
      }
    });
  }

  private async onLocalReaction(payload: EventPayloads['message:reaction']) {
    if (payload.pluginId === PLUGIN_ID) return;

    const target = this.remoteTarget(payload.channelId);
    if (!target || target.link.direction === 'inbound') return;

    const guild = this.guilds.get(target.link.remoteGuildId);
    const emoji = mapOutboundEmoji(payload.emoji, (name) => guild?.emojis.get(name));
    if (!emoji) return;

    await this.chain(`local:${payload.messageId}`, async () => {
      const entry = this.store.messageByLocal(payload.messageId);
      if (!entry) return;

      const path = `/channels/${entry.remoteChannelId}/messages/${entry.remoteId}/reactions/${emoji}/@me`;
      try {
        if (payload.added) await this.rest.put(path);
        else await this.rest.delete(path);
      } catch (error) {
        if (!isNotFound(error)) this.ctx.debug(`Reaction not mirrored: ${errorMessage(error)}`);
      }
    });
  }

  private async onLocalThreadCreated(payload: EventPayloads['thread:created']) {
    if (payload.pluginId === PLUGIN_ID) return;
    if (this.store.threads.has(payload.threadId)) return;

    const link = this.store.links.get(payload.parentChannelId);
    if (!link || link.direction === 'inbound') return;

    const name = boundText(payload.name, 100, 'Thread');
    const chainKey =
      payload.parentMessageId !== undefined
        ? `local:${payload.parentMessageId}`
        : `local-thread:${payload.threadId}`;

    await this.chain(chainKey, async () => {
      const starter =
        payload.parentMessageId !== undefined
          ? this.store.messageByLocal(payload.parentMessageId)
          : undefined;

      try {
        const created = starter
          ? await this.rest.post<TRemoteChannel>(
              `/channels/${starter.remoteChannelId}/messages/${starter.remoteId}/threads`,
              { body: { name, auto_archive_duration: 1440 } }
            )
          : await this.rest.post<TRemoteChannel>(`/channels/${link.remoteChannelId}/threads`, {
              body: { name, type: 11, auto_archive_duration: 1440 }
            });

        this.store.setThread({
          localThreadId: payload.threadId,
          remoteThreadId: created.id,
          channelId: link.channelId,
          remoteChannelId: link.remoteChannelId
        });
      } catch (error) {
        this.noteLinkError(link.channelId, error);
      }
    });
  }

  private async onLocalEventCreated(payload: EventPayloads['event:created']) {
    if (this.inboundEventsInFlight > 0 || this.store.eventByLocal(payload.eventId)) return;

    const link = this.store.linkForServer(payload.serverId);
    if (!link || link.direction === 'inbound') return;

    await this.chain(`local-event:${payload.eventId}`, async () => {
      try {
        const created = await this.rest.post<TRemoteScheduledEvent>(
          `/guilds/${link.remoteGuildId}/scheduled-events`,
          {
            body: {
              name: boundText(payload.title, 100, 'Event'),
              privacy_level: 2,
              scheduled_start_time: toIso(payload.startsAt),
              scheduled_end_time: toIso(payload.endsAt),
              entity_type: 3,
              entity_metadata: { location: 'PULSE' }
            }
          }
        );

        this.store.setEvent({
          localEventId: payload.eventId,
          remoteEventId: created.id,
          remoteGuildId: link.remoteGuildId,
          origin: 'out'
        });
        this.pushedEvents.set(created.id, eventSignature(created));
      } catch (error) {
        this.noteLinkError(link.channelId, error);
      }
    });
  }

  private async onLocalEventUpdated(payload: EventPayloads['event:updated']) {
    if (this.inboundEventsInFlight > 0) return;

    const entry = this.store.eventByLocal(payload.eventId);
    if (!entry) return;

    const link = this.store.linkForGuild(entry.remoteGuildId);
    if (!link || link.direction === 'inbound') return;

    if (payload.status === 'cancelled') return this.onLocalEventCancelled(payload);
    if (payload.status !== 'scheduled') return;

    await this.chain(`local-event:${payload.eventId}`, async () => {
      try {
        const body = {
          name: boundText(payload.title, 100, 'Event'),
          scheduled_start_time: toIso(payload.startsAt),
          scheduled_end_time: toIso(payload.endsAt)
        };
        const updated = await this.rest.patch<TRemoteScheduledEvent>(
          `/guilds/${entry.remoteGuildId}/scheduled-events/${entry.remoteEventId}`,
          { body }
        );
        this.pushedEvents.set(entry.remoteEventId, eventSignature(updated));
      } catch (error) {
        if (isNotFound(error)) {
          this.store.removeEventByLocal(payload.eventId);
          return;
        }
        this.noteLinkError(link.channelId, error);
      }
    });
  }

  private async onLocalEventCancelled(payload: EventPayloads['event:cancelled']) {
    if (this.inboundEventsInFlight > 0) return;

    const entry = this.store.removeEventByLocal(payload.eventId);
    if (!entry) return;

    this.pushedEvents.delete(entry.remoteEventId);

    const link = this.store.linkForGuild(entry.remoteGuildId);
    if (!link || link.direction === 'inbound') return;

    await this.chain(`local-event:${payload.eventId}`, async () => {
      try {
        await this.rest.delete(
          `/guilds/${entry.remoteGuildId}/scheduled-events/${entry.remoteEventId}`
        );
      } catch (error) {
        if (!isNotFound(error)) this.noteLinkError(link.channelId, error);
      }
    });
  }
}

export type { TRemoteUser, TServerLink };
