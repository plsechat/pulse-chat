import type { AppData, Producer, Router } from "mediasoup/types";
import type {
  CommandDefinition,
  TInvokerContext,
  TPluginCapability,
  TPluginSettingDefinition,
} from "@pulse/shared";
import pkg from "../package.json" with { type: "json" };

export type { TInvokerContext, TPluginCapability };

/**
 * Version of this SDK. A plugin declares the range it was written against
 * in its package.json as `pulse.sdk` (a semver range); the server refuses
 * to load a plugin whose range this version does not satisfy. Every 0.x
 * minor is a strict superset of the previous one, so a range that admits
 * an older 0.x minor (for example `^0.1` on a 0.2 server) still loads.
 */
export const PLUGIN_SDK_VERSION: string = pkg.version;

export type TCreateStreamOptions = {
  channelId: number;
  title: string;
  key: string;
  avatarUrl?: string;
  producers: {
    audio?: Producer;
    video?: Producer;
  };
};

export type TExternalStreamHandle = {
  streamId: number;
  remove: () => void;
  update: (options: {
    title?: string;
    avatarUrl?: string;
    producers?: {
      audio?: Producer;
      video?: Producer;
    };
  }) => void;
};

export type ServerEvent =
  | "user:connected"
  | "member:joined"
  | "member:left"
  | "member:roles_changed"
  /** @deprecated alias of `user:connected`; removed in v0.5.0 */
  | "user:joined"
  /** @deprecated alias of `member:left`; removed in v0.5.0 */
  | "user:left"
  | "message:created"
  | "message:updated"
  | "message:deleted"
  | "message:reaction"
  | "thread:created"
  | "event:created"
  | "event:updated"
  | "event:cancelled"
  | "event:started"
  | "event:ended"
  | "voice:runtime_initialized"
  | "voice:runtime_closed";

/**
 * Lifecycle of a scheduled event as the server reports it. `startsAt` /
 * `endsAt` are epoch milliseconds.
 */
export type TPluginEventStatus = "scheduled" | "live" | "done" | "cancelled";

export type TPluginEventPayload = {
  eventId: number;
  serverId: number;
  title: string;
  startsAt: number;
  endsAt: number;
  status: TPluginEventStatus;
};

export interface EventPayloads {
  /** A member's client session connected to (bootstrapped) `serverId`. */
  "user:connected": {
    userId: number;
    username: string;
    serverId: number;
  };
  /** A user became a member of `serverId` (invite, discover or federated join). */
  "member:joined": {
    userId: number;
    username: string;
    serverId: number;
  };
  /** A user stopped being a member of `serverId` (left, kicked or banned). */
  "member:left": {
    userId: number;
    username: string;
    serverId: number;
  };
  /**
   * A member's role set in `serverId` changed (role granted or removed,
   * a role deleted out from under them, ownership transferred). `roleIds`
   * is the full set they hold in that server afterwards.
   */
  "member:roles_changed": {
    userId: number;
    serverId: number;
    roleIds: number[];
  };
  /**
   * @deprecated Same payload and timing as `user:connected`; emitted
   * alongside it for one release (v0.4.0) and removed in v0.5.0.
   */
  "user:joined": {
    userId: number;
    username: string;
    serverId: number;
  };
  /**
   * @deprecated Same payload and timing as `member:left`; emitted
   * alongside it for one release (v0.4.0) and removed in v0.5.0.
   */
  "user:left": {
    userId: number;
    username: string;
    serverId: number;
  };
  /**
   * A plaintext channel message was sent. `pluginId` is set when a
   * plugin posted it through `actions.messages.post` (the author row is
   * then the instance owner) — a bridge uses it to skip its own echoes.
   */
  "message:created": {
    messageId: number;
    channelId: number;
    userId: number;
    content: string;
    pluginId?: string;
    /** The message this one replies to, when it is a reply. */
    replyToId?: number | null;
    /** Files attached by the author, served at `url` (relative to the instance). */
    attachments?: { name: string; url: string; size: number }[];
  };
  /** A plaintext channel message was edited; `pluginId` as on `message:created`. */
  "message:updated": {
    messageId: number;
    channelId: number;
    userId: number;
    content: string;
    pluginId?: string;
      replyToId?: number | null;
  };
  "message:deleted": {
    messageId: number;
    channelId: number;
  };
  /**
   * A reaction was added (`added: true`) or removed from a channel
   * message, by a user or by a plugin (`pluginId` set; `userId` is then
   * the instance owner the reaction is stored under).
   */
  "message:reaction": {
    messageId: number;
    channelId: number;
    userId: number;
    emoji: string;
    added: boolean;
    pluginId?: string;
  };
  /**
   * A thread was opened under `parentChannelId` (a text channel or a
   * forum). `parentMessageId` is the message the thread hangs off when
   * it was started from one; `pluginId` when a plugin created it.
   */
  "thread:created": {
    threadId: number;
    parentChannelId: number;
    serverId: number;
    name: string;
    creatorId: number;
    parentMessageId?: number;
    pluginId?: string;
  };
  "event:created": TPluginEventPayload;
  "event:updated": TPluginEventPayload;
  "event:cancelled": TPluginEventPayload;
  "event:started": TPluginEventPayload;
  "event:ended": TPluginEventPayload;
  "voice:runtime_initialized": {
    channelId: number;
  };
  "voice:runtime_closed": {
    channelId: number;
  };
}

// this API is probably going to change a lot in the future
// so consider it as experimental for now

type SettingValueType<T extends TPluginSettingDefinition> =
  T["type"] extends "string"
    ? string
    : T["type"] extends "number"
      ? number
      : T["type"] extends "boolean"
        ? boolean
        : unknown;

export interface PluginSettings<
  T extends readonly TPluginSettingDefinition[] = TPluginSettingDefinition[],
> {
  get<K extends T[number]["key"]>(
    key: K,
  ): SettingValueType<Extract<T[number], { key: K }>>;
  set<K extends T[number]["key"]>(
    key: K,
    value: SettingValueType<Extract<T[number], { key: K }>>,
  ): void;
}

// ---------------------------------------------------------------------------
// Actions (SDK 0.2)
// ---------------------------------------------------------------------------

/**
 * Why an action was refused. Every `actions.*` rejection is an `Error`
 * whose `code` is one of these; the message says what to change.
 *
 * - `BAD_REQUEST`  input out of bounds, or the target cannot take the
 *                  action (voice / encrypted channel, reply across
 *                  channels, …)
 * - `NOT_FOUND`    the id does not exist, or exists in a scope the
 *                  action may not touch (same answer on purpose)
 * - `FORBIDDEN`    the plugin does not own the message and lacks the
 *                  `moderate-messages` capability; auto-moderation
 *                  blocked the content
 * - `CONFLICT`     a concurrent write won (rare; retry)
 * - `UNAVAILABLE`  the feature is not installed on this server (for
 *                  example `actions.events` before the scheduler loads)
 */
export type TPluginActionErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "UNAVAILABLE";

export type TPluginActionError = Error & {
  name: "PluginActionError";
  code: TPluginActionErrorCode;
};

/** Narrow an `actions.*` rejection; anything else is an unexpected failure. */
export const isPluginActionError = (
  error: unknown,
): error is TPluginActionError =>
  error instanceof Error &&
  error.name === "PluginActionError" &&
  typeof (error as { code?: unknown }).code === "string";

/**
 * Display identity shown on a posted message instead of the owner
 * account the row is stored under. `avatarUrl` is a server-relative
 * `/public/<file>` path (what `actions.files.upload` returns as `url`)
 * or an absolute `http(s)` URL.
 */
export type TPluginAuthor = {
  name: string;
  avatarUrl?: string;
};

/** A file previously stored through `actions.files.upload`. */
export type TPluginAttachment = {
  fileId: number;
};

/** A stored file as the server addresses it; `url` is server-relative. */
export type TPluginFileRef = {
  id: number;
  name: string;
  originalName: string;
  url: string;
  size: number;
  mimeType: string;
};

/**
 * A message the plugin addresses either by the server's id or by the
 * `externalId` it gave at post time (unique per plugin).
 */
export type TPluginMessageRef =
  | { messageId: number; externalId?: never }
  | { externalId: string; messageId?: never };

export type TPluginPostMessageInput = {
  channelId: number;
  /** Message HTML/text, up to the shared message cap; may be empty when attachments are given. */
  content: string;
  author?: TPluginAuthor;
  /** Must be a message of the same channel. */
  replyToId?: number;
  /** At most 10 files owned by the plugin's actor (see `files.upload`). */
  attachments?: TPluginAttachment[];
  /**
   * Your own id for this message (≤ 256 chars). Posting the same
   * externalId again returns the existing message instead of a
   * duplicate, and `edit` / `delete` / `react` accept it in place of
   * the server id. Ids starting with `__` are reserved.
   */
  externalId?: string;
};

export type TPluginChannelType = "TEXT" | "VOICE" | "THREAD" | "FORUM";

export type TPluginChannel = {
  id: number;
  publicId: string;
  serverId: number;
  name: string;
  type: TPluginChannelType;
  categoryId: number | null;
  parentChannelId: number | null;
  topic: string | null;
  private: boolean;
  e2ee: boolean;
  archived: boolean;
  position: number;
};

export type TPluginCreateChannelInput = {
  serverId: number;
  name: string;
  type: "TEXT" | "VOICE";
  /** Defaults to the server's first category. */
  categoryId?: number;
  topic?: string;
};

export type TPluginCreateThreadInput = {
  /** The text or forum channel the thread hangs under. */
  channelId: number;
  /** Start the thread from this message of `channelId` (it must not have one yet). */
  parentMessageId?: number;
  name: string;
};

export type TPluginMember = {
  id: number;
  publicId: string;
  name: string;
  /** Per-server display name when the member set one. */
  nickname?: string;
  avatarUrl?: string;
  roles: { id: number; name: string }[];
};

export type TPluginUploadInput = {
  /** The file's bytes… */
  bytes?: Uint8Array | ArrayBuffer;
  /** …or an `http(s)` URL the server fetches through its hardened client (never both). */
  url?: string;
  filename: string;
  /** Used to pick an extension when `filename` has none. */
  mime?: string;
  /** Accepted for forward compatibility; files are instance-level today. */
  serverId?: number;
};

export type TPluginEventRole = {
  key: string;
  label: string;
  cap: number | null;
  color: string | null;
};

export type TPluginEvent = {
  id: number;
  serverId: number;
  title: string;
  description: string | null;
  gameTag: string | null;
  startsAt: number;
  endsAt: number;
  hostId: number | null;
  roles: TPluginEventRole[];
  maxParticipants: number | null;
  announceChannelId: number | null;
  voiceChannelId: number | null;
  status: TPluginEventStatus;
};

export type TPluginCreateEventInput = {
  serverId: number;
  title: string;
  description?: string;
  gameTag?: string;
  startsAt: number;
  endsAt: number;
  /** A member of the server, or null for a plugin-hosted event. */
  hostId?: number | null;
  roles: TPluginEventRole[];
  maxParticipants?: number;
  announceChannelId?: number;
};

export type TPluginUpdateEventInput = Partial<
  Omit<TPluginCreateEventInput, "serverId">
>;

/** What `ctx.fetch` resolves with: the bounded reading of one response. */
export type TPluginFetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bytes: () => Promise<Uint8Array>;
  text: () => Promise<string>;
  json: <T = unknown>() => Promise<T>;
};

export type TPluginFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Abort after this long (default 10 s, max 60 s). */
  timeoutMs?: number;
  /** Largest response body to read (default 1 MiB, max 64 MiB). */
  maxBytes?: number;
};

export type TPluginHttpRequest = {
  method: "GET" | "POST";
  /** The path the handler was registered under. */
  path: string;
  /** Lower-cased header names; the plugin secret header is removed. */
  headers: Record<string, string>;
  query: Record<string, string>;
  /** Parsed JSON for `application/json` bodies, the raw text otherwise; `null` on GET. */
  body: unknown;
};

export type TPluginHttpResponse = {
  status: number;
  /** A string is sent as `text/plain`, anything else as JSON; omit for an empty body. */
  body?: unknown;
  headers?: Record<string, string>;
};

export type TPluginHttpHandler = (
  request: TPluginHttpRequest,
) => TPluginHttpResponse | Promise<TPluginHttpResponse>;

export interface PluginContext {
  path: string;

  log(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  error(...args: unknown[]): void;

  events: {
    on<E extends ServerEvent>(
      event: E,
      handler: (payload: EventPayloads[E]) => void | Promise<void>,
    ): void;
  };

  actions: {
    voice: {
      getRouter(channelId: number): Router<AppData>;
      createStream(options: TCreateStreamOptions): TExternalStreamHandle;
      getListenInfo(): {
        ip: string;
        announcedAddress: string | undefined;
      };
    };

    messages: {
      /** Post into a text channel, thread or forum post. Refuses voice and encrypted channels. */
      post(input: TPluginPostMessageInput): Promise<{ messageId: number }>;
      /** Edit a message the plugin posted (any message with `moderate-messages`). */
      edit(input: TPluginMessageRef & { content: string }): Promise<void>;
      /** Delete a message the plugin posted (any message with `moderate-messages`). */
      delete(input: TPluginMessageRef): Promise<void>;
      /** Add (or with `remove`, take back) a reaction under the plugin's actor. */
      react(
        input: TPluginMessageRef & { emoji: string; remove?: boolean },
      ): Promise<void>;
    };

    channels: {
      list(serverId: number): Promise<TPluginChannel[]>;
      create(input: TPluginCreateChannelInput): Promise<TPluginChannel>;
      createThread(input: TPluginCreateThreadInput): Promise<TPluginChannel>;
    };

    members: {
      /** Up to 5000 members with their roles in that server; no e-mail, no identities. */
      list(serverId: number): Promise<TPluginMember[]>;
    };

    files: {
      /**
       * Store a file (from bytes or a fetched URL) under the plugin's
       * actor, subject to the instance upload limits. Attach it to a
       * message within five minutes or the orphan sweep removes it.
       */
      upload(input: TPluginUploadInput): Promise<TPluginFileRef>;
    };

    events: {
      create(input: TPluginCreateEventInput): Promise<TPluginEvent>;
      update(
        eventId: number,
        patch: TPluginUpdateEventInput,
      ): Promise<TPluginEvent>;
      cancel(eventId: number): Promise<void>;
    };
  };

  /**
   * Outbound HTTP through the server's hardened client: `http(s)` only,
   * private and link-local targets refused, DNS pinned, redirects
   * refused, per-host rate limited, body bounded. The runtime's global
   * `fetch` is still reachable from plugin code but is unsupported —
   * the loader does not sandbox.
   */
  fetch(url: string, init?: TPluginFetchInit): Promise<TPluginFetchResponse>;

  http: {
    /**
     * Serve `GET`/`POST /plugins/<pluginId>/<path>`. Callers must send
     * the plugin's secret in `x-pulse-plugin-secret` (generated on the
     * first registration, shown to the instance owner in the plugin's
     * settings). Bodies are capped at 1 MiB; requests are rate limited.
     */
    register(path: string, handler: TPluginHttpHandler): void;
  };

  commands: {
    register<TArgs = void>(command: CommandDefinition<TArgs>): void;
  };

  settings: {
    register<T extends readonly TPluginSettingDefinition[]>(
      definitions: T,
    ): Promise<PluginSettings<T>>;
  };
}

export type UnloadPluginContext = Pick<
  PluginContext,
  "log" | "debug" | "error"
>;

// re-export mediasoup types for plugin usage
export type {
  AppData,
  Producer,
  Router,
  Transport,
  PlainTransport,
  PlainTransportOptions,
  ProducerOptions,
  RtpCodecCapability,
  RtpParameters,
  RtpEncodingParameters,
  MediaKind,
} from "mediasoup/types";
