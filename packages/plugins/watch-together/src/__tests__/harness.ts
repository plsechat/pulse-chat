import type {
  EventPayloads,
  PluginContext,
  ServerEvent,
  TExternalStreamHandle,
  TExternalStreamMedia,
  TPluginChannel,
  TPluginFetchResponse,
  TPluginMessageData,
  TPluginHttpHandler,
  TPluginHttpRequest,
  TPluginHttpResponse
} from '@pulse/plugin-sdk';
import type { CommandDefinition, TInvokerContext } from '@pulse/shared';

/**
 * The SDK context faked in memory: records every stream created and
 * every `update`/`remove` on it, answers `ctx.fetch` from a table the
 * test fills, keeps the registered command and routes so a test can
 * invoke them, and lets a test emit server events. Nothing touches the
 * network.
 */

export type TStreamRecord = {
  streamId: number;
  channelId: number;
  title: string;
  key: string;
  media: TExternalStreamMedia | null | undefined;
  updates: Array<{ media?: TExternalStreamMedia | null }>;
  removed: boolean;
};

/** `body` is what `json()` resolves with (an oEmbed answer in the YouTube tests). */
export type TProbeAnswer = { status: number; contentType?: string; body?: unknown } | Error;

/** A message the fake `messages.post` stored; edits land on it in order. */
export type TMessageRecord = {
  messageId: number;
  channelId: number;
  content: string;
  author?: { name: string; avatarUrl?: string };
  metadata: TPluginMessageData | undefined;
  /** Every `edit` applied, in order. */
  edits: Array<{ content?: string; metadata?: TPluginMessageData }>;
  deleted: boolean;
};

export type TFakeContext = {
  ctx: PluginContext;
  streams: TStreamRecord[];
  messages: TMessageRecord[];
  /** Channels `channels.list` answers with (any server). */
  channels: TPluginChannel[];
  logs: string[];
  fetches: Array<{ url: string; method?: string; headers?: Record<string, string> }>;
  probes: Map<string, TProbeAnswer>;
  settings: Record<string, unknown>;
  run: (invoker: TInvokerContext, args: Record<string, unknown>) => Promise<unknown>;
  /** The command as registered (its declaration is under test too). */
  get command(): CommandDefinition<unknown> | undefined;
  route: (path: string, request: Partial<TPluginHttpRequest>) => Promise<TPluginHttpResponse>;
  emit: <E extends ServerEvent>(event: E, payload: EventPayloads[E]) => Promise<void>;
};

export const invoker = (overrides: Partial<TInvokerContext> = {}): TInvokerContext => ({
  userId: 7,
  currentVoiceChannelId: 42,
  activeServerId: 1,
  canModerate: false,
  ...overrides
});

export const createFakeContext = (): TFakeContext => {
  const streams: TStreamRecord[] = [];
  const messages: TMessageRecord[] = [];
  const channels: TPluginChannel[] = [];
  const logs: string[] = [];
  let nextMessageId = 100;

  /** `actions.*` rejections carry a code like the real loader's. */
  const actionError = (code: string, message: string) => {
    const error = new Error(message) as Error & { code: string };
    error.name = 'PluginActionError';
    error.code = code;
    return error;
  };
  const fetches: TFakeContext['fetches'] = [];
  const probes = new Map<string, TProbeAnswer>();
  const settings: Record<string, unknown> = {};
  const handlers = new Map<ServerEvent, Array<(payload: unknown) => void | Promise<void>>>();
  const routes = new Map<string, TPluginHttpHandler>();
  let command: CommandDefinition<unknown> | undefined;
  let nextStreamId = 0;

  const notImplemented = (name: string) => () => {
    throw new Error(`${name} is not part of this plugin's surface`);
  };

  const ctx: PluginContext = {
    path: '/plugins/watch-together',
    log: (...m) => logs.push(m.map(String).join(' ')),
    debug: (...m) => logs.push(m.map(String).join(' ')),
    error: (...m) => logs.push(`ERROR ${m.map(String).join(' ')}`),
    events: {
      on: (event, handler) => {
        const list = handlers.get(event) ?? [];
        list.push(handler as (payload: unknown) => void | Promise<void>);
        handlers.set(event, list);
      }
    },
    fetch: async (url, init): Promise<TPluginFetchResponse> => {
      fetches.push({ url, method: init?.method, headers: init?.headers });
      const answer = probes.get(url);
      if (!answer) throw new Error(`fetch ${url} failed: no fixture`);
      if (answer instanceof Error) throw answer;
      const headers: Record<string, string> = {};
      if (answer.contentType) headers['content-type'] = answer.contentType;
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        statusText: '',
        headers,
        bytes: async () => new Uint8Array(),
        text: async () => '',
        json: async <T,>() => (answer.body ?? {}) as T
      };
    },
    server: { notify: () => {} },
    http: {
      register: (path, handler) => {
        routes.set(path.replace(/^\/+|\/+$/g, ''), handler);
      }
    },
    actions: {
      voice: {
        getRouter: notImplemented('getRouter'),
        getListenInfo: () => ({ ip: '127.0.0.1', announcedAddress: undefined }),
        createStream: (options): TExternalStreamHandle => {
          const record: TStreamRecord = {
            streamId: nextStreamId++,
            channelId: options.channelId,
            title: options.title,
            key: options.key,
            media: options.media,
            updates: [],
            removed: false
          };
          streams.push(record);
          return {
            streamId: record.streamId,
            remove: () => {
              if (record.removed) throw new Error('already removed');
              record.removed = true;
            },
            update: (update) => {
              record.updates.push({ media: update.media });
              if (update.media !== undefined) record.media = update.media;
            }
          };
        }
      },
      messages: {
        post: async (input) => {
          const record: TMessageRecord = {
            messageId: nextMessageId++,
            channelId: input.channelId,
            content: input.content,
            author: input.author,
            metadata: input.metadata,
            edits: [],
            deleted: false
          };
          messages.push(record);
          return { messageId: record.messageId };
        },
        edit: async (input) => {
          const record = messages.find((m) => m.messageId === input.messageId);
          if (!record || record.deleted) throw actionError('NOT_FOUND', 'Message not found');
          record.edits.push({
            ...(input.content !== undefined ? { content: input.content } : {}),
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
          });
          if (input.content !== undefined) record.content = input.content;
          if (input.metadata !== undefined) record.metadata = input.metadata;
        },
        delete: notImplemented('messages.delete'),
        react: notImplemented('messages.react')
      },
      channels: {
        list: async () => channels,
        create: notImplemented('channels.create'),
        createThread: notImplemented('channels.createThread')
      },
      members: { list: notImplemented('members.list') },
      files: { upload: notImplemented('files.upload') },
      events: {
        create: notImplemented('events.create'),
        update: notImplemented('events.update'),
        cancel: notImplemented('events.cancel')
      }
    },
    commands: {
      register: (definition) => {
        command = definition as CommandDefinition<unknown>;
      }
    },
    settings: {
      register: async (definitions) => {
        for (const d of definitions) settings[d.key] ??= d.defaultValue;
        return {
          get: (key: string) => settings[key],
          set: (key: string, value: unknown) => {
            settings[key] = value;
          }
        } as never;
      }
    }
  };

  return {
    ctx,
    streams,
    messages,
    channels,
    logs,
    fetches,
    probes,
    settings,
    get command() {
      return command;
    },
    run: (inv, args) => {
      if (!command) throw new Error('no command registered');
      return command.executes(inv, args);
    },
    route: async (path, request) => {
      const handler = routes.get(path);
      if (!handler) throw new Error(`no route ${path}`);
      return handler({
        method: 'GET',
        path,
        headers: {},
        query: {},
        body: null,
        ...request
      });
    },
    emit: async (event, payload) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload);
    }
  };
};
