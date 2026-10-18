import { afterEach, describe, expect, test } from 'bun:test';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocket, type WebSocketServer } from 'ws';
import { getMockedToken } from '../../__tests__/helpers';
import { createWsServer } from '../wss';

// Each test boots its own HTTP + WebSocket server on an ephemeral port
// (the shared test server in __tests__/setup.ts is HTTP-only) so the
// connection caps are exercised against the real `createWsServer` with
// the env read at creation time.
//
// Clients connect with `?connectionParams=1` like the real client does:
// without it tRPC's adapter creates the context on connect, which fails
// (no token) and closes the socket with 1000 before anything else runs.

const ENV_KEYS = ['WS_CONNECTION_PARAMS_TIMEOUT_MS', 'WS_MAX_CONNECTIONS_PER_USER'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

type TRig = { url: string; httpServer: http.Server; wss: WebSocketServer };

const rigs: TRig[] = [];
const clients: WebSocket[] = [];

const startRig = async (): Promise<TRig> => {
  const httpServer = http.createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const wss = await createWsServer(httpServer);
  const { port } = httpServer.address() as AddressInfo;
  const rig = { url: `ws://127.0.0.1:${port}/?connectionParams=1`, httpServer, wss };
  rigs.push(rig);
  return rig;
};

/** Connect and resolve once open; reject if the server refuses first. */
const connect = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    clients.push(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

/** Resolve with the close code the server sent. */
const closeCode = (ws: WebSocket): Promise<number> =>
  new Promise((resolve) => ws.once('close', (code) => resolve(code)));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out: ${label}`)), ms)
    )
  ]);

type TWireResult = {
  id: number;
  result?: { type: string; data?: unknown };
  error?: { data?: { code?: string } };
};

/**
 * Send one tRPC request frame and resolve with its response — or with
 * `{ closed: code }` if the server closes the socket before answering.
 */
const request = (ws: WebSocket, id: number, path: string, input?: unknown) =>
  withTimeout(
    new Promise<TWireResult | { closed: number }>((resolve) => {
      const onMessage = (raw: WebSocket.RawData) => {
        const parsed = JSON.parse(raw.toString()) as TWireResult;
        if (parsed.id !== id) return;
        ws.off('message', onMessage);
        ws.off('close', onClose);
        resolve(parsed);
      };
      const onClose = (code: number) => {
        ws.off('message', onMessage);
        resolve({ closed: code });
      };
      ws.on('message', onMessage);
      ws.once('close', onClose);
      ws.send(JSON.stringify({ id, method: 'query', params: { path, input } }));
    }),
    5_000,
    path
  );

const isResponse = (value: TWireResult | { closed: number }): value is TWireResult =>
  !('closed' in value);

const sendConnectionParams = (ws: WebSocket, accessToken: string) =>
  ws.send(JSON.stringify({ method: 'connectionParams', data: { accessToken } }));

/** Connect, authenticate and join like the real client's boot sequence. */
const connectAndJoin = async (url: string, accessToken: string) => {
  const ws = await connect(url);
  sendConnectionParams(ws, accessToken);

  const handshake = await request(ws, 1, 'others.handshake');
  if (!isResponse(handshake)) throw new Error(`closed during handshake: ${handshake.closed}`);
  const handshakeHash = (handshake.result?.data as { handshakeHash: string }).handshakeHash;
  expect(typeof handshakeHash).toBe('string');

  const join = await request(ws, 2, 'others.joinServer', { handshakeHash });
  return { ws, join };
};

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  for (const ws of clients.splice(0)) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }
  }
  for (const rig of rigs.splice(0)) {
    rig.wss.close();
    rig.httpServer.closeAllConnections?.();
    await withTimeout(
      new Promise<void>((resolve) => rig.httpServer.close(() => resolve())),
      2_000,
      'httpServer.close'
    ).catch(() => undefined);
  }
});

describe('WebSocket connection limits', () => {
  test('the 21st socket from one address is closed with 1008', async () => {
    const { url } = await startRig();

    const open: WebSocket[] = [];
    for (let i = 0; i < 20; i++) {
      open.push(await connect(url));
    }
    await sleep(100);
    expect(open.every((ws) => ws.readyState === WebSocket.OPEN)).toBe(true);

    const extra = await connect(url);
    const code = await withTimeout(closeCode(extra), 5_000, '21st close');

    expect(code).toBe(1008);
    expect(open.every((ws) => ws.readyState === WebSocket.OPEN)).toBe(true);

    // Closing one frees a slot for the next.
    open[0]!.close();
    await closeCode(open[0]!);
    await sleep(50);

    const replacement = await connect(url);
    await sleep(100);
    expect(replacement.readyState).toBe(WebSocket.OPEN);
  });

  test('a 2 MiB frame closes the socket with 1009', async () => {
    const { url } = await startRig();
    const ws = await connect(url);

    ws.send(Buffer.alloc(2 * 1024 * 1024, 0x61));

    expect(await withTimeout(closeCode(ws), 5_000, '1009 close')).toBe(1009);
  });

  test('a socket that never sends connection params is closed with 1008', async () => {
    process.env.WS_CONNECTION_PARAMS_TIMEOUT_MS = '300';
    const { url } = await startRig();

    const silent = await connect(url);
    const started = Date.now();
    const code = await withTimeout(closeCode(silent), 5_000, 'timeout close');

    expect(code).toBe(1008);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  test('a socket that sends connection params survives the timeout', async () => {
    process.env.WS_CONNECTION_PARAMS_TIMEOUT_MS = '300';
    const { url } = await startRig();
    const token = await getMockedToken(1);

    const ws = await connect(url);
    sendConnectionParams(ws, token);

    await sleep(700);

    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  test('the socket over the per-user cap is refused on join and closed with 1008', async () => {
    process.env.WS_MAX_CONNECTIONS_PER_USER = '2';
    const { url } = await startRig();
    const token = await getMockedToken(1);

    const first = await connectAndJoin(url, token);
    expect(isResponse(first.join) && first.join.result?.type).toBe('data');

    const second = await connectAndJoin(url, token);
    expect(isResponse(second.join) && second.join.result?.type).toBe('data');

    const third = await connectAndJoin(url, token);
    // The refusal reaches the client as a tRPC error first...
    expect(isResponse(third.join) && third.join.error?.data?.code).toBe(
      'TOO_MANY_REQUESTS'
    );
    // ...then the socket is closed with 1008.
    expect(await withTimeout(closeCode(third.ws), 5_000, 'third close')).toBe(1008);

    await sleep(100);
    expect(first.ws.readyState).toBe(WebSocket.OPEN);
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
  });
});
