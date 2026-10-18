import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * What the bridge remembers between restarts, and the bounded maps it
 * keeps in memory while running.
 *
 * The SDK links a plugin's OWN posts to an external id, but a message a
 * member wrote here and the bridge mirrored outward has no such link,
 * so the local ↔ remote message map is the plugin's to keep. It is
 * bounded (oldest pair evicted first) because a busy pair of channels
 * would otherwise grow it without end; a pair that fell out of the map
 * simply stops being editable from the other side, which is the right
 * failure for history nobody touches any more.
 *
 * The persisted file lives next to the plugin (`ctx.path`) and is
 * written through a debounce so a burst of messages costs one write.
 * No secret is ever written here: webhook tokens stay in memory and
 * are re-resolved through the bot after a restart.
 */

export const STATE_FILE_NAME = 'bridge-state.json';
export const MAX_MESSAGE_LINKS = 50_000;
export const MAX_THREAD_LINKS = 5_000;
export const MAX_EVENT_LINKS = 2_000;
export const MAX_PERSONAS = 10_000;
const FLUSH_DELAY_MS = 500;

export type TDirection = 'both' | 'inbound' | 'outbound';

export type TLink = {
  channelId: number;
  serverId: number;
  remoteGuildId: string;
  remoteChannelId: string;
  webhookId: string;
  direction: TDirection;
};

export type TBridgeMode = 'mirror' | 'match';
export type TCreateMissing = 'both' | 'here' | 'there' | 'none';

/**
 * The plugin's copy of a whole-server link (the server holds the
 * record). It tells the gateway handlers which guilds are watched for
 * channel changes; the pairing itself happens on the server.
 */
export type TServerLink = {
  serverId: number;
  remoteGuildId: string;
  mode: TBridgeMode;
  createMissing: TCreateMissing;
  defaultDirection: TDirection;
};

export type TThreadLink = {
  localThreadId: number;
  remoteThreadId: string;
  /** The linked pair the thread hangs under. */
  channelId: number;
  remoteChannelId: string;
};

/** Which side a mirrored message was written on. */
export type TOrigin = 'in' | 'out';

export type TMessageLink = {
  localId: number;
  remoteId: string;
  remoteChannelId: string;
  origin: TOrigin;
};

export type TEventLink = {
  localEventId: number;
  remoteEventId: string;
  remoteGuildId: string;
  origin: TOrigin;
};

export type TPersona = {
  name: string;
  avatarUrl?: string;
};

export type TPersistedState = {
  version: 1;
  links: TLink[];
  /** Absent in files written before whole-server links existed. */
  serverLinks?: TServerLink[];
  threads: TThreadLink[];
  messages: TMessageLink[];
  events: TEventLink[];
  personas: [string, TPersona][];
};

/** Where the state is kept; injectable so tests run in memory. */
export type TStateStorage = {
  load: () => Promise<string | null>;
  save: (data: string) => Promise<void>;
};

export const createFileStorage = (dir: string): TStateStorage => {
  const file = path.join(dir, STATE_FILE_NAME);

  return {
    load: async () => {
      try {
        return await fs.readFile(file, 'utf8');
      } catch {
        return null;
      }
    },
    save: async (data) => {
      // Write-then-rename so a crash mid-write leaves the previous
      // state readable instead of a truncated file.
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, data, 'utf8');
      await fs.rename(tmp, file);
    }
  };
};

export const createMemoryStorage = (initial: string | null = null): TStateStorage => {
  let current = initial;

  return {
    load: async () => current,
    save: async (data) => {
      current = data;
    }
  };
};

/** Insertion-ordered map that drops its oldest entry past `max`. */
class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    // Re-setting moves the key to the newest position so an active
    // conversation is not the first thing evicted.
    this.map.delete(key);
    this.map.set(key, value);

    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  clear(): void {
    this.map.clear();
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isDirection = (value: unknown): value is TDirection =>
  value === 'both' || value === 'inbound' || value === 'outbound';

const isLink = (value: unknown): value is TLink =>
  isRecord(value) &&
  Number.isInteger(value.channelId) &&
  Number.isInteger(value.serverId) &&
  typeof value.remoteGuildId === 'string' &&
  typeof value.remoteChannelId === 'string' &&
  typeof value.webhookId === 'string' &&
  isDirection(value.direction);

const isServerLink = (value: unknown): value is TServerLink =>
  isRecord(value) &&
  Number.isInteger(value.serverId) &&
  typeof value.remoteGuildId === 'string' &&
  (value.mode === 'mirror' || value.mode === 'match') &&
  (value.createMissing === 'both' ||
    value.createMissing === 'here' ||
    value.createMissing === 'there' ||
    value.createMissing === 'none') &&
  isDirection(value.defaultDirection);

const isThreadLink = (value: unknown): value is TThreadLink =>
  isRecord(value) &&
  Number.isInteger(value.localThreadId) &&
  typeof value.remoteThreadId === 'string' &&
  Number.isInteger(value.channelId) &&
  typeof value.remoteChannelId === 'string';

const isMessageLink = (value: unknown): value is TMessageLink =>
  isRecord(value) &&
  Number.isInteger(value.localId) &&
  typeof value.remoteId === 'string' &&
  typeof value.remoteChannelId === 'string' &&
  (value.origin === 'in' || value.origin === 'out');

const isEventLink = (value: unknown): value is TEventLink =>
  isRecord(value) &&
  Number.isInteger(value.localEventId) &&
  typeof value.remoteEventId === 'string' &&
  typeof value.remoteGuildId === 'string' &&
  (value.origin === 'in' || value.origin === 'out');

const isPersonaEntry = (value: unknown): value is [string, TPersona] =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === 'string' &&
  isRecord(value[1]) &&
  typeof value[1].name === 'string' &&
  (value[1].avatarUrl === undefined || typeof value[1].avatarUrl === 'string');

const takeValid = <T>(list: unknown, guard: (v: unknown) => v is T, max: number): T[] =>
  Array.isArray(list) ? list.filter(guard).slice(-max) : [];

/**
 * The bridge's memory. Every mutation marks the state dirty; `flush`
 * (debounced, or forced on unload) writes it through the storage.
 */
export class BridgeStore {
  readonly links = new Map<number, TLink>();
  readonly serverLinks = new Map<number, TServerLink>();
  readonly threads = new Map<number, TThreadLink>();
  private readonly threadsByRemote = new Map<string, TThreadLink>();
  private readonly messagesByLocal = new BoundedMap<number, TMessageLink>(MAX_MESSAGE_LINKS);
  private readonly messagesByRemote = new Map<string, TMessageLink>();
  private readonly eventsByLocal = new BoundedMap<number, TEventLink>(MAX_EVENT_LINKS);
  private readonly eventsByRemote = new Map<string, TEventLink>();
  readonly personas = new BoundedMap<string, TPersona>(MAX_PERSONAS);

  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: TStateStorage,
    private readonly onError: (message: string) => void = () => {}
  ) {}

  async load(): Promise<void> {
    const raw = await this.storage.load();
    if (!raw) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.onError('Stored bridge state is not valid JSON; starting empty');
      return;
    }

    if (!isRecord(parsed)) return;

    for (const link of takeValid(parsed.links, isLink, 10_000)) {
      this.links.set(link.channelId, link);
    }
    for (const link of takeValid(parsed.serverLinks, isServerLink, 1_000)) {
      this.serverLinks.set(link.serverId, link);
    }
    for (const thread of takeValid(parsed.threads, isThreadLink, MAX_THREAD_LINKS)) {
      this.setThread(thread, false);
    }
    for (const message of takeValid(parsed.messages, isMessageLink, MAX_MESSAGE_LINKS)) {
      this.setMessage(message, false);
    }
    for (const event of takeValid(parsed.events, isEventLink, MAX_EVENT_LINKS)) {
      this.setEvent(event, false);
    }
    for (const [id, persona] of takeValid(parsed.personas, isPersonaEntry, MAX_PERSONAS)) {
      this.personas.set(id, persona);
    }
  }

  // ─── links ──────────────────────────────────────────────────────────

  linkByRemoteChannel(remoteChannelId: string): TLink | undefined {
    for (const link of this.links.values()) {
      if (link.remoteChannelId === remoteChannelId) return link;
    }
    return undefined;
  }

  /** The first link into `serverId` — where that server's events go. */
  linkForServer(serverId: number): TLink | undefined {
    for (const link of this.links.values()) {
      if (link.serverId === serverId) return link;
    }
    return undefined;
  }

  linkForGuild(remoteGuildId: string): TLink | undefined {
    for (const link of this.links.values()) {
      if (link.remoteGuildId === remoteGuildId) return link;
    }
    return undefined;
  }

  setLink(link: TLink): void {
    this.links.set(link.channelId, link);
    this.markDirty();
  }

  removeLink(channelId: number): TLink | undefined {
    const link = this.links.get(channelId);
    if (!link) return undefined;

    this.links.delete(channelId);

    for (const thread of [...this.threads.values()]) {
      if (thread.channelId === channelId) this.removeThread(thread.localThreadId);
    }

    this.markDirty();
    return link;
  }

  // ─── server links ───────────────────────────────────────────────────

  serverLinkForGuild(remoteGuildId: string): TServerLink | undefined {
    for (const link of this.serverLinks.values()) {
      if (link.remoteGuildId === remoteGuildId) return link;
    }
    return undefined;
  }

  setServerLink(link: TServerLink): void {
    this.serverLinks.set(link.serverId, link);
    this.markDirty();
  }

  removeServerLink(serverId: number): TServerLink | undefined {
    const link = this.serverLinks.get(serverId);
    if (!link) return undefined;

    this.serverLinks.delete(serverId);
    this.markDirty();
    return link;
  }

  // ─── threads ────────────────────────────────────────────────────────

  threadByRemote(remoteThreadId: string): TThreadLink | undefined {
    return this.threadsByRemote.get(remoteThreadId);
  }

  setThread(thread: TThreadLink, persist = true): void {
    if (this.threads.size >= MAX_THREAD_LINKS && !this.threads.has(thread.localThreadId)) {
      const oldest = this.threads.keys().next();
      if (!oldest.done) this.removeThread(oldest.value);
    }

    this.threads.set(thread.localThreadId, thread);
    this.threadsByRemote.set(thread.remoteThreadId, thread);
    if (persist) this.markDirty();
  }

  removeThread(localThreadId: number): void {
    const thread = this.threads.get(localThreadId);
    if (!thread) return;

    this.threads.delete(localThreadId);
    this.threadsByRemote.delete(thread.remoteThreadId);
    this.markDirty();
  }

  // ─── messages ───────────────────────────────────────────────────────

  messageByLocal(localId: number): TMessageLink | undefined {
    return this.messagesByLocal.get(localId);
  }

  messageByRemote(remoteId: string): TMessageLink | undefined {
    return this.messagesByRemote.get(remoteId);
  }

  setMessage(message: TMessageLink, persist = true): void {
    const previous = this.messagesByLocal.get(message.localId);
    if (previous) this.messagesByRemote.delete(previous.remoteId);

    this.messagesByLocal.set(message.localId, message);
    this.messagesByRemote.set(message.remoteId, message);

    // The bounded side evicted something: mirror the eviction.
    if (this.messagesByRemote.size > this.messagesByLocal.size) {
      const live = new Set<number>();
      for (const entry of this.messagesByLocal.values()) live.add(entry.localId);
      for (const [remoteId, entry] of [...this.messagesByRemote.entries()]) {
        if (!live.has(entry.localId)) this.messagesByRemote.delete(remoteId);
      }
    }

    if (persist) this.markDirty();
  }

  removeMessageByLocal(localId: number): TMessageLink | undefined {
    const entry = this.messagesByLocal.get(localId);
    if (!entry) return undefined;

    this.messagesByLocal.delete(localId);
    this.messagesByRemote.delete(entry.remoteId);
    this.markDirty();
    return entry;
  }

  removeMessageByRemote(remoteId: string): TMessageLink | undefined {
    const entry = this.messagesByRemote.get(remoteId);
    if (!entry) return undefined;

    return this.removeMessageByLocal(entry.localId);
  }

  get messageCount(): number {
    return this.messagesByLocal.size;
  }

  // ─── events ─────────────────────────────────────────────────────────

  eventByLocal(localEventId: number): TEventLink | undefined {
    return this.eventsByLocal.get(localEventId);
  }

  eventByRemote(remoteEventId: string): TEventLink | undefined {
    return this.eventsByRemote.get(remoteEventId);
  }

  setEvent(event: TEventLink, persist = true): void {
    const previous = this.eventsByLocal.get(event.localEventId);
    if (previous) this.eventsByRemote.delete(previous.remoteEventId);

    this.eventsByLocal.set(event.localEventId, event);
    this.eventsByRemote.set(event.remoteEventId, event);

    if (this.eventsByRemote.size > this.eventsByLocal.size) {
      const live = new Set<number>();
      for (const entry of this.eventsByLocal.values()) live.add(entry.localEventId);
      for (const [remoteId, entry] of [...this.eventsByRemote.entries()]) {
        if (!live.has(entry.localEventId)) this.eventsByRemote.delete(remoteId);
      }
    }

    if (persist) this.markDirty();
  }

  removeEventByLocal(localEventId: number): TEventLink | undefined {
    const entry = this.eventsByLocal.get(localEventId);
    if (!entry) return undefined;

    this.eventsByLocal.delete(localEventId);
    this.eventsByRemote.delete(entry.remoteEventId);
    this.markDirty();
    return entry;
  }

  // ─── personas ───────────────────────────────────────────────────────

  rememberPersona(remoteUserId: string, persona: TPersona): void {
    const known = this.personas.get(remoteUserId);
    if (known && known.name === persona.name && known.avatarUrl === persona.avatarUrl) return;

    this.personas.set(remoteUserId, persona);
    this.markDirty();
  }

  // ─── persistence ────────────────────────────────────────────────────

  toJSON(): TPersistedState {
    return {
      version: 1,
      links: [...this.links.values()],
      serverLinks: [...this.serverLinks.values()],
      threads: [...this.threads.values()],
      messages: [...this.messagesByLocal.values()],
      events: [...this.eventsByLocal.values()],
      personas: [...this.personas.entries()]
    };
  }

  markDirty(): void {
    this.dirty = true;

    if (this.flushTimer) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, FLUSH_DELAY_MS);
    // A pending write must not keep the process alive on shutdown;
    // `flush` is called explicitly on unload.
    this.flushTimer.unref?.();
  }

  /** Write the state now (if anything changed) and wait for it. */
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    if (!this.dirty) return this.flushing;

    this.dirty = false;
    const data = JSON.stringify(this.toJSON());

    this.flushing = this.flushing
      .then(() => this.storage.save(data))
      .catch((error) => {
        this.dirty = true;
        this.onError(
          `Could not persist bridge state: ${error instanceof Error ? error.message : String(error)}`
        );
      });

    return this.flushing;
  }
}
