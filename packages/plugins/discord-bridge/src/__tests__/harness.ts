import type {
  EventPayloads,
  PluginContext,
  ServerEvent,
  TPluginFetchInit,
  TPluginFetchResponse,
  TPluginHttpHandler,
  TPluginMember
} from '@pulse/plugin-sdk';
import { Bridge, type TBridgeOptions } from '../bridge';
import type { TGatewaySocket, TGatewayTimers } from '../gateway';
import { createMemoryStorage } from '../store';
import gatewayFixture from './fixtures/gateway.json';
import restFixture from './fixtures/rest.json';

/**
 * Everything the bridge talks to, faked in memory:
 *
 *  - the SDK context records every action and lets a test emit server
 *    events into the handlers the bridge registered;
 *  - `ctx.fetch` answers from the recorded REST fixture (method + path
 *    → status/headers/body) and records every call it got;
 *  - the gateway socket is a hand-driven pipe: a test pushes recorded
 *    frames in and reads the frames the client sent.
 *
 * Nothing here opens a network connection.
 */

type TRecordedResponse = {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
};

type TRestCall = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
};

type TAction = { name: string; input: unknown };

export type TFixtureTransport = {
  calls: TRestCall[];
  /** Override or add an answer for `METHOD /path` (path without query). */
  respond: (key: string, response: TRecordedResponse | ((call: TRestCall) => TRecordedResponse)) => void;
  fetch: PluginContext['fetch'];
};

const API_PREFIX = 'https://discord.com/api/v10';

export const createFixtureTransport = (): TFixtureTransport => {
  const routes = new Map<string, TRecordedResponse | ((call: TRestCall) => TRecordedResponse)>();
  const calls: TRestCall[] = [];

  for (const [key, value] of Object.entries(restFixture.routes)) {
    routes.set(key, value as TRecordedResponse);
  }

  const fetch: PluginContext['fetch'] = async (url: string, init?: TPluginFetchInit) => {
    if (!url.startsWith(API_PREFIX)) {
      throw new Error(`fixture transport: unexpected origin ${url}`);
    }

    const parsed = new URL(url);
    const path = parsed.pathname.slice('/api/v10'.length);
    const query: Record<string, string> = {};
    for (const [name, value] of parsed.searchParams) query[name] = value;

    const method = init?.method ?? 'GET';
    const call: TRestCall = {
      method,
      path,
      query,
      headers: init?.headers ?? {},
      body: typeof init?.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : null
    };
    calls.push(call);

    // Exact match first, then a pattern with `:id` wildcards.
    let answer = routes.get(`${method} ${path}`);

    if (!answer) {
      for (const [key, value] of routes) {
        const [keyMethod, keyPath] = key.split(' ', 2);
        if (keyMethod !== method || !keyPath) continue;
        const pattern = new RegExp(
          `^${keyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[a-z]+/g, '[^/]+')}$`
        );
        if (pattern.test(path)) {
          answer = value;
          break;
        }
      }
    }

    const response: TRecordedResponse =
      typeof answer === 'function'
        ? answer(call)
        : (answer ?? { status: 404, body: { message: 'Unknown route (fixture)' } });

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(response.headers ?? {})
    };
    const bodyText = response.body === undefined ? '' : JSON.stringify(response.body);

    const result: TPluginFetchResponse = {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: '',
      headers,
      bytes: async () => new TextEncoder().encode(bodyText),
      text: async () => bodyText,
      json: async <T,>() => JSON.parse(bodyText) as T
    };

    return result;
  };

  return {
    calls,
    respond: (key, response) => {
      routes.set(key, response);
    },
    fetch
  };
};

export class FakeSocket implements TGatewaySocket {
  readonly sent: Record<string, unknown>[] = [];
  readonly url: string;
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  onerror: ((message: string) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    // The real socket fires `close` after the handshake; the fake does
    // it on the next tick so the caller's frame finishes first.
    queueMicrotask(() => this.onclose?.(code ?? 1005, reason ?? ''));
  }

  /** The server opened the socket. */
  open(): void {
    this.onopen?.();
  }

  /** A frame from the server. */
  receive(frame: unknown): void {
    this.onmessage?.(JSON.stringify(frame));
  }

  /** The server dropped the connection. */
  drop(code: number, reason = ''): void {
    this.onclose?.(code, reason);
  }

  /** Frames the client sent with this opcode. */
  sentOp(op: number): Record<string, unknown>[] {
    return this.sent.filter((frame) => frame.op === op);
  }
}

export const createSocketFactory = () => {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: (url: string) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    latest: () => sockets[sockets.length - 1]!
  };
};

/** Timers a test advances by hand. */
export const createFakeTimers = () => {
  let now = 0;
  type TTimer = { at: number; fn: () => void; interval: number | null };
  const timers = new Map<number, TTimer>();
  let nextId = 1;

  const timersApi: TGatewayTimers = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn, interval: null });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    setInterval: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn, interval: ms });
      return id;
    },
    clearInterval: (handle) => {
      timers.delete(handle as number);
    }
  };

  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      let next: [number, TTimer] | undefined;
      for (const entry of timers) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      now = next[1].at;
      if (next[1].interval !== null) next[1].at = now + next[1].interval;
      else timers.delete(next[0]);
      next[1].fn();
    }
    now = target;
  };

  return { timers: timersApi, advance, pending: () => timers.size, now: () => now };
};

export type TFakeContext = {
  ctx: PluginContext;
  actions: TAction[];
  logs: string[];
  errors: string[];
  routes: Map<string, TPluginHttpHandler>;
  emit: <E extends ServerEvent>(event: E, payload: EventPayloads[E]) => Promise<void>;
  members: TPluginMember[];
  /** Make the next action with this name reject. */
  failNext: (name: string, error: Error) => void;
  nextMessageId: () => number;
};

export const createFakeContext = (fetch: PluginContext['fetch']): TFakeContext => {
  const actions: TAction[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const routes = new Map<string, TPluginHttpHandler>();
  const handlers = new Map<string, ((payload: unknown) => void | Promise<void>)[]>();
  const failures = new Map<string, Error>();
  let messageSeq = 1000;
  let threadSeq = 500;
  let fileSeq = 1;
  let eventSeq = 1;
  const members: TPluginMember[] = [
    {
      id: 7,
      publicId: 'pub-7',
      name: 'Alice',
      nickname: 'Ali',
      avatarUrl: '/public/alice.png',
      roles: [{ id: 3, name: 'Raiders' }]
    },
    { id: 8, publicId: 'pub-8', name: 'Bob', roles: [] }
  ];

  const record = <T,>(name: string, input: unknown, result: T): T => {
    actions.push({ name, input });
    const failure = failures.get(name);
    if (failure) {
      failures.delete(name);
      throw failure;
    }
    return result;
  };

  const ctx = {
    path: '/tmp/fake-plugin',
    log: (...message: unknown[]) => {
      logs.push(message.map(String).join(' '));
    },
    debug: (...message: unknown[]) => {
      logs.push(message.map(String).join(' '));
    },
    error: (...message: unknown[]) => {
      errors.push(message.map(String).join(' '));
    },
    events: {
      on: (event: string, handler: (payload: unknown) => void | Promise<void>) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }
    },
    actions: {
      voice: {
        getRouter: () => {
          throw new Error('not in tests');
        },
        createStream: () => {
          throw new Error('not in tests');
        },
        getListenInfo: () => ({ ip: '0.0.0.0', announcedAddress: undefined })
      },
      messages: {
        post: async (input: unknown) => record('messages.post', input, { messageId: ++messageSeq }),
        edit: async (input: unknown) => record('messages.edit', input, undefined),
        delete: async (input: unknown) => record('messages.delete', input, undefined),
        react: async (input: unknown) => record('messages.react', input, undefined)
      },
      channels: {
        list: async () => record('channels.list', undefined, []),
        create: async () => {
          throw new Error('not in tests');
        },
        createThread: async (input: { channelId: number; name: string }) =>
          record('channels.createThread', input, {
            id: ++threadSeq,
            publicId: 'thread',
            serverId: 1,
            name: input.name,
            type: 'THREAD' as const,
            categoryId: null,
            parentChannelId: input.channelId,
            topic: null,
            private: false,
            e2ee: false,
            archived: false,
            position: 0
          })
      },
      members: {
        list: async (serverId: number) => record('members.list', serverId, members)
      },
      files: {
        upload: async (input: { filename: string }) =>
          record('files.upload', input, {
            id: fileSeq++,
            name: `stored-${input.filename}`,
            originalName: input.filename,
            url: `/public/stored-${input.filename}`,
            size: 10,
            mimeType: 'application/octet-stream'
          })
      },
      events: {
        create: async (input: { serverId: number; title: string; startsAt: number; endsAt: number }) => {
          const id = eventSeq++;
          const result = {
            id,
            serverId: input.serverId,
            title: input.title,
            description: null,
            gameTag: null,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            hostId: null,
            roles: [],
            maxParticipants: null,
            announceChannelId: null,
            voiceChannelId: null,
            status: 'scheduled' as const
          };
          actions.push({ name: 'events.create', input });
          // The server emits `event:created` from inside the action.
          await emit('event:created', {
            eventId: id,
            serverId: input.serverId,
            title: input.title,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            status: 'scheduled'
          });
          return result;
        },
        update: async (eventId: number, patch: unknown) => {
          actions.push({ name: 'events.update', input: { eventId, patch } });
          await emit('event:updated', {
            eventId,
            serverId: 1,
            title: 'x',
            startsAt: 0,
            endsAt: 0,
            status: 'scheduled'
          });
          return {} as never;
        },
        cancel: async (eventId: number) => {
          actions.push({ name: 'events.cancel', input: eventId });
          await emit('event:cancelled', {
            eventId,
            serverId: 1,
            title: 'x',
            startsAt: 0,
            endsAt: 0,
            status: 'cancelled'
          });
        }
      }
    },
    fetch,
    http: {
      register: (path: string, handler: TPluginHttpHandler) => {
        routes.set(path, handler);
      }
    },
    commands: {
      register: () => {}
    },
    settings: {
      register: async () => ({ get: () => undefined, set: () => {} })
    }
  } as unknown as PluginContext;

  const emit = async <E extends ServerEvent>(event: E, payload: EventPayloads[E]) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload);
    }
  };

  return {
    ctx,
    actions,
    logs,
    errors,
    routes,
    emit,
    members,
    failNext: (name, error) => {
      failures.set(name, error);
    },
    nextMessageId: () => messageSeq + 1
  };
};

export type TBridgeHarness = ReturnType<typeof createBridgeHarness>;

/** A started bridge with a token, idle until the gateway is driven. */
export const createBridgeHarness = (overrides: Partial<TBridgeOptions> & { token?: string } = {}) => {
  const transport = createFixtureTransport();
  const fake = createFakeContext(transport.fetch);
  const sockets = createSocketFactory();
  const clock = createFakeTimers();
  let now = 1_760_000_000_000;
  const sleeps: number[] = [];

  const bridge = new Bridge({
    ctx: fake.ctx,
    settings: {
      botToken: () => overrides.token ?? 'bot-token',
      publicUrl: () => 'https://pulse.example'
    },
    storage: overrides.storage ?? createMemoryStorage(),
    socketFactory: sockets.factory,
    timers: clock.timers,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    now: () => now,
    random: () => 0,
    ...overrides
  });

  /** Drive the socket through HELLO → IDENTIFY → READY → GUILD_CREATE. */
  const connect = () => {
    const socket = sockets.latest();
    socket.open();
    socket.receive(gatewayFixture.hello);
    socket.receive(gatewayFixture.ready);
    socket.receive(gatewayFixture.guildCreate);
    return socket;
  };

  /** Call one of the registered HTTP routes the way the server does. */
  const call = async (path: string, body: unknown) => {
    const handler = fake.routes.get(path);
    if (!handler) throw new Error(`route ${path} not registered`);
    return handler({ method: 'POST', path, headers: {}, query: {}, body });
  };

  /** Push a recorded dispatch and wait for the bridge to settle. */
  const dispatch = async (frame: { t: string; d: unknown }) => {
    await bridge.handleDispatch(frame.t, frame.d);
    await bridge.idle();
  };

  return {
    bridge,
    fake,
    transport,
    sockets,
    clock,
    sleeps,
    connect,
    call,
    dispatch,
    gateway: gatewayFixture,
    advanceClock: (ms: number) => {
      now += ms;
    }
  };
};
