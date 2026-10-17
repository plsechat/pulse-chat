import type { TGatewayPayload, TReadyPayload } from './types';

/**
 * One gateway connection for the whole plugin.
 *
 * The protocol in one breath: open the socket, wait for HELLO (op 10,
 * carries the heartbeat interval), IDENTIFY (op 2) or RESUME (op 6),
 * then heartbeat (op 1) on the interval and treat a missing ACK (op 11)
 * as a dead link. The service may ask us to reconnect (op 7) or tell us
 * the session is gone (op 9, resumable or not); every close that is not
 * our own doing reconnects with exponential backoff, resuming when the
 * session is still good so no dispatch is lost. A close code that means
 * "you are misconfigured" (bad token, disallowed intents) stops the
 * loop and surfaces the reason — retrying it would only get the bot
 * banned from the gateway for a while.
 *
 * The socket is an injected factory so tests drive recorded frames
 * through it without a network; the production factory wraps the
 * runtime's WebSocket.
 */

export const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

export const Intents = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  MESSAGE_CONTENT: 1 << 15,
  GUILD_SCHEDULED_EVENTS: 1 << 16
} as const;

export const BRIDGE_INTENTS =
  Intents.GUILDS |
  Intents.GUILD_MEMBERS |
  Intents.GUILD_MESSAGES |
  Intents.GUILD_MESSAGE_REACTIONS |
  Intents.MESSAGE_CONTENT |
  Intents.GUILD_SCHEDULED_EVENTS;

const Op = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11
} as const;

/** Close codes after which a reconnect cannot help; the operator must act. */
const FATAL_CLOSE_CODES: Record<number, string> = {
  4004: 'The bot token was rejected',
  4010: 'Invalid shard',
  4011: 'The bot is in too many servers for a single connection',
  4012: 'Unsupported gateway version',
  4013: 'Invalid gateway intents',
  4014: 'The bot is missing a privileged intent (Server Members or Message Content) in its application settings'
};

/** Close codes after which the session cannot be resumed. */
const NO_RESUME_CLOSE_CODES = new Set([4007, 4009]);

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/** Our own close code when the heartbeat went unanswered. */
const ZOMBIE_CLOSE_CODE = 4000;

export interface TGatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  onerror: ((message: string) => void) | null;
}

export type TSocketFactory = (url: string) => TGatewaySocket;

export type TGatewayTimers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

export type TGatewayStatus = {
  connected: boolean;
  /** Set when the loop stopped on a fatal close. */
  fatal: string | null;
  lastError: string | null;
  botUserId: string | null;
  botUsername: string | null;
  reconnects: number;
};

export type TGatewayOptions = {
  token: () => string;
  intents?: number;
  socketFactory: TSocketFactory;
  timers?: TGatewayTimers;
  onDispatch: (type: string, data: unknown) => void | Promise<void>;
  onStatus?: (status: TGatewayStatus) => void;
  log: (...message: unknown[]) => void;
  /** Deterministic backoff jitter in tests. */
  random?: () => number;
};

/** The production socket: the runtime's own WebSocket, text frames only. */
export const createWebSocketFactory = (): TSocketFactory => (url) => {
  const ws = new WebSocket(url);
  const wrapper: TGatewaySocket = {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null
  };

  ws.addEventListener('open', () => wrapper.onopen?.());
  ws.addEventListener('message', (event) => {
    const data = typeof event.data === 'string' ? event.data : '';
    if (data) wrapper.onmessage?.(data);
  });
  ws.addEventListener('close', (event) => wrapper.onclose?.(event.code, event.reason));
  ws.addEventListener('error', () => wrapper.onerror?.('socket error'));

  return wrapper;
};

const defaultTimers: TGatewayTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
};

/**
 * Only the service's own gateway hosts: the resume URL arrives in a
 * payload, and a payload must not be able to point the bot elsewhere.
 */
export const isTrustedGatewayUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'wss:' &&
      (parsed.hostname === 'discord.gg' || parsed.hostname.endsWith('.discord.gg'))
    );
  } catch {
    return false;
  }
};

export class GatewayClient {
  private readonly token: () => string;
  private readonly intents: number;
  private readonly socketFactory: TSocketFactory;
  private readonly timers: TGatewayTimers;
  private readonly onDispatch: TGatewayOptions['onDispatch'];
  private readonly onStatus: TGatewayOptions['onStatus'];
  private readonly log: TGatewayOptions['log'];
  private readonly random: () => number;

  private socket: TGatewaySocket | null = null;
  private running = false;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private sequence: number | null = null;
  private heartbeatHandle: unknown = null;
  private heartbeatAcked = true;
  private reconnectHandle: unknown = null;
  private backoffMs = MIN_BACKOFF_MS;
  private generation = 0;

  readonly status: TGatewayStatus = {
    connected: false,
    fatal: null,
    lastError: null,
    botUserId: null,
    botUsername: null,
    reconnects: 0
  };

  constructor(options: TGatewayOptions) {
    this.token = options.token;
    this.intents = options.intents ?? BRIDGE_INTENTS;
    this.socketFactory = options.socketFactory;
    this.timers = options.timers ?? defaultTimers;
    this.onDispatch = options.onDispatch;
    this.onStatus = options.onStatus;
    this.log = options.log;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    this.status.fatal = null;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();

    const socket = this.socket;
    this.socket = null;
    this.generation++;

    if (socket) {
      try {
        socket.close(1000, 'plugin stopping');
      } catch {
        // already gone
      }
    }

    this.setConnected(false);
  }

  /** Drop the session and dial again (for a changed token). */
  restart(): void {
    this.stop();
    this.sessionId = null;
    this.resumeUrl = null;
    this.sequence = null;
    this.backoffMs = MIN_BACKOFF_MS;
    this.start();
  }

  private setConnected(connected: boolean) {
    if (this.status.connected === connected) return;

    this.status.connected = connected;
    this.onStatus?.(this.status);
  }

  private clearTimers() {
    if (this.heartbeatHandle !== null) {
      this.timers.clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
    if (this.reconnectHandle !== null) {
      this.timers.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
  }

  private connect() {
    if (!this.running) return;

    const url =
      this.sessionId && this.resumeUrl && isTrustedGatewayUrl(this.resumeUrl)
        ? this.resumeUrl
        : GATEWAY_URL;
    const generation = ++this.generation;

    let socket: TGatewaySocket;

    try {
      socket = this.socketFactory(url);
    } catch (error) {
      this.fail(`Could not open the gateway socket: ${(error as Error).message}`);
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    this.heartbeatAcked = true;

    socket.onopen = () => {
      if (generation !== this.generation) return;
      this.log('Gateway socket open');
    };

    socket.onmessage = (data) => {
      if (generation !== this.generation) return;
      this.handleFrame(data);
    };

    socket.onerror = (message) => {
      if (generation !== this.generation) return;
      this.status.lastError = message;
    };

    socket.onclose = (code, reason) => {
      if (generation !== this.generation) return;

      this.socket = null;
      this.clearTimers();
      this.setConnected(false);

      const fatal = FATAL_CLOSE_CODES[code];

      if (fatal) {
        this.running = false;
        this.status.fatal = fatal;
        this.status.lastError = fatal;
        this.sessionId = null;
        this.log(`Gateway closed with ${code}: ${fatal}`);
        this.onStatus?.(this.status);
        return;
      }

      if (NO_RESUME_CLOSE_CODES.has(code)) {
        this.sessionId = null;
        this.sequence = null;
      }

      this.log(`Gateway closed (${code}${reason ? ` ${reason}` : ''}); reconnecting`);
      this.scheduleReconnect();
    };
  }

  private fail(message: string) {
    this.status.lastError = message;
    this.log(message);
  }

  private scheduleReconnect() {
    if (!this.running || this.reconnectHandle !== null) return;

    const jitter = 1 + this.random() * 0.25;
    const wait = Math.round(this.backoffMs * jitter);
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    this.status.reconnects++;

    this.reconnectHandle = this.timers.setTimeout(() => {
      this.reconnectHandle = null;
      this.connect();
    }, wait);
  }

  private send(payload: TGatewayPayload) {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch (error) {
      this.fail(`Gateway send failed: ${(error as Error).message}`);
    }
  }

  private handleFrame(data: string) {
    let payload: TGatewayPayload;

    try {
      payload = JSON.parse(data) as TGatewayPayload;
    } catch {
      this.fail('Gateway sent a frame that is not JSON');
      return;
    }

    if (typeof payload.s === 'number') this.sequence = payload.s;

    switch (payload.op) {
      case Op.HELLO: {
        const interval = Number((payload.d as { heartbeat_interval?: unknown })?.heartbeat_interval);
        this.startHeartbeat(Number.isFinite(interval) && interval > 0 ? interval : 41_250);

        if (this.sessionId && this.sequence !== null) {
          this.send({
            op: Op.RESUME,
            d: { token: this.token(), session_id: this.sessionId, seq: this.sequence }
          });
        } else {
          this.send({
            op: Op.IDENTIFY,
            d: {
              token: this.token(),
              intents: this.intents,
              properties: { os: 'linux', browser: 'pulse-bridge', device: 'pulse-bridge' }
            }
          });
        }
        return;
      }
      case Op.HEARTBEAT:
        this.send({ op: Op.HEARTBEAT, d: this.sequence });
        return;
      case Op.HEARTBEAT_ACK:
        this.heartbeatAcked = true;
        return;
      case Op.RECONNECT:
        this.log('Gateway asked for a reconnect');
        this.socket?.close(ZOMBIE_CLOSE_CODE, 'reconnect requested');
        return;
      case Op.INVALID_SESSION: {
        const resumable = payload.d === true;
        if (!resumable) {
          this.sessionId = null;
          this.sequence = null;
        }
        this.log(`Gateway invalidated the session (resumable: ${resumable})`);
        this.socket?.close(ZOMBIE_CLOSE_CODE, 'invalid session');
        return;
      }
      case Op.DISPATCH:
        this.handleDispatch(payload.t ?? '', payload.d);
        return;
      default:
        return;
    }
  }

  private startHeartbeat(intervalMs: number) {
    if (this.heartbeatHandle !== null) this.timers.clearInterval(this.heartbeatHandle);

    this.heartbeatAcked = true;
    this.heartbeatHandle = this.timers.setInterval(() => {
      if (!this.heartbeatAcked) {
        // The link is up but nobody answers: a zombie connection. Close
        // with a non-1000 code so the session stays resumable.
        this.fail('Heartbeat went unanswered; reconnecting');
        this.socket?.close(ZOMBIE_CLOSE_CODE, 'heartbeat timeout');
        return;
      }

      this.heartbeatAcked = false;
      this.send({ op: Op.HEARTBEAT, d: this.sequence });
    }, intervalMs);
  }

  private handleDispatch(type: string, data: unknown) {
    if (type === 'READY') {
      const ready = data as TReadyPayload;
      this.sessionId = ready.session_id;
      this.resumeUrl = isTrustedGatewayUrl(ready.resume_gateway_url)
        ? ready.resume_gateway_url
        : null;
      this.status.botUserId = ready.user?.id ?? null;
      this.status.botUsername = ready.user?.username ?? null;
      this.status.lastError = null;
      this.backoffMs = MIN_BACKOFF_MS;
      this.setConnected(true);
      this.log(`Gateway ready as ${this.status.botUsername ?? 'unknown bot'}`);
      return;
    }

    if (type === 'RESUMED') {
      this.backoffMs = MIN_BACKOFF_MS;
      this.status.lastError = null;
      this.setConnected(true);
      this.log('Gateway session resumed');
      return;
    }

    Promise.resolve(this.onDispatch(type, data)).catch((error) => {
      this.fail(
        `${type} handler failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
}
