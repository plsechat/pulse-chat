import { describe, expect, test } from 'bun:test';
import { BRIDGE_INTENTS, GATEWAY_URL, GatewayClient, isTrustedGatewayUrl } from '../gateway';
import gateway from './fixtures/gateway.json';
import { createFakeTimers, createSocketFactory } from './harness';

const HEARTBEAT = gateway.hello.d.heartbeat_interval;

const makeGateway = (token = 'tok') => {
  const sockets = createSocketFactory();
  const clock = createFakeTimers();
  const dispatches: { type: string; data: unknown }[] = [];
  const logs: string[] = [];
  const client = new GatewayClient({
    token: () => token,
    socketFactory: sockets.factory,
    timers: clock.timers,
    random: () => 0,
    onDispatch: (type, data) => {
      dispatches.push({ type, data });
    },
    log: (...message) => {
      logs.push(message.map(String).join(' '));
    }
  });

  return { client, sockets, clock, dispatches, logs };
};

/** Let the fake socket's queued close callbacks run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('gateway client', () => {
  test('identifies on HELLO with the token and the bridge intents, then reports ready', () => {
    const { client, sockets } = makeGateway();
    client.start();

    const socket = sockets.latest();
    expect(socket.url).toBe(GATEWAY_URL);
    socket.open();
    socket.receive(gateway.hello);

    const identify = socket.sentOp(2)[0]!;
    expect(identify.d).toMatchObject({ token: 'tok', intents: BRIDGE_INTENTS });
    expect(BRIDGE_INTENTS & (1 << 15)).toBeTruthy(); // message content
    expect(BRIDGE_INTENTS & (1 << 1)).toBeTruthy(); // guild members
    expect(BRIDGE_INTENTS & (1 << 16)).toBeTruthy(); // scheduled events

    socket.receive(gateway.ready);
    expect(client.status).toMatchObject({
      connected: true,
      botUserId: '900000000000000001',
      botUsername: 'pulse-bridge',
      fatal: null
    });
  });

  test('dispatches reach the handler with their type; READY/RESUMED do not', () => {
    const { client, sockets, dispatches } = makeGateway();
    client.start();
    const socket = sockets.latest();
    socket.receive(gateway.hello);
    socket.receive(gateway.ready);
    socket.receive(gateway.guildCreate);
    socket.receive({ op: 0, s: 3, t: 'MESSAGE_CREATE', d: gateway.messageCreatePlain.d });

    expect(dispatches.map((d) => d.type)).toEqual(['GUILD_CREATE', 'MESSAGE_CREATE']);
  });

  test('heartbeats on the interval with the last sequence and answers an explicit heartbeat request', () => {
    const { client, sockets, clock } = makeGateway();
    client.start();
    const socket = sockets.latest();
    socket.receive(gateway.hello);
    socket.receive(gateway.ready);
    socket.receive(gateway.guildCreate);

    clock.advance(HEARTBEAT);
    expect(socket.sentOp(1)).toEqual([{ op: 1, d: 2 }]);

    socket.receive(gateway.heartbeatAck);
    socket.receive({ op: 1 });
    expect(socket.sentOp(1)).toHaveLength(2);
  });

  test('a heartbeat without an ACK closes the socket and the reconnect RESUMES the session', async () => {
    const { client, sockets, clock } = makeGateway();
    client.start();
    const first = sockets.latest();
    first.receive(gateway.hello);
    first.receive(gateway.ready);
    first.receive(gateway.guildCreate);

    clock.advance(HEARTBEAT); // beat sent, never acked
    clock.advance(HEARTBEAT); // zombie detected
    expect(first.closed?.code).toBe(4000);
    await settle();
    expect(client.status.connected).toBe(false);

    clock.advance(1000); // first backoff step
    const second = sockets.latest();
    expect(second).not.toBe(first);
    expect(second.url).toBe('wss://gateway-us-east1-b.discord.gg');

    second.receive(gateway.hello);
    const resume = second.sentOp(6)[0]!;
    expect(resume.d).toEqual({ token: 'tok', session_id: 'sess-1', seq: 2 });
    expect(second.sentOp(2)).toHaveLength(0);

    second.receive(gateway.resumed);
    expect(client.status.connected).toBe(true);
    expect(client.status.reconnects).toBe(1);
  });

  test('backoff doubles per failed attempt up to a minute and resets after a successful READY', async () => {
    const { client, sockets, clock } = makeGateway();
    client.start();

    for (const expected of [1000, 2000, 4000]) {
      const socket = sockets.latest();
      socket.drop(1006);
      await settle();
      const before = sockets.sockets.length;
      clock.advance(expected - 1);
      expect(sockets.sockets.length).toBe(before);
      clock.advance(1);
      expect(sockets.sockets.length).toBe(before + 1);
    }

    const socket = sockets.latest();
    socket.receive(gateway.hello);
    socket.receive(gateway.ready);
    socket.drop(1006);
    await settle();
    clock.advance(1000);
    expect(sockets.sockets.length).toBe(5);
  });

  test('a fatal close code stops the loop and names the reason; no reconnect follows', async () => {
    const { client, sockets, clock } = makeGateway();
    client.start();
    const socket = sockets.latest();
    socket.receive(gateway.hello);
    socket.drop(4014, 'Disallowed intent(s)');
    await settle();

    expect(client.status.fatal).toContain('privileged intent');
    expect(client.status.connected).toBe(false);
    clock.advance(120_000);
    expect(sockets.sockets).toHaveLength(1);

    client.start();
    socket.receive(gateway.hello);
    sockets.latest().drop(4004);
    await settle();
    expect(client.status.fatal).toContain('token was rejected');
  });

  test('a non-resumable INVALID_SESSION reconnects with a fresh IDENTIFY, not a RESUME', async () => {
    const { client, sockets, clock } = makeGateway();
    client.start();
    const first = sockets.latest();
    first.receive(gateway.hello);
    first.receive(gateway.ready);
    first.receive(gateway.invalidSessionNotResumable);
    await settle();

    clock.advance(1000);
    const second = sockets.latest();
    second.receive(gateway.hello);
    expect(second.sentOp(6)).toHaveLength(0);
    expect(second.sentOp(2)).toHaveLength(1);
  });

  test('RECONNECT (op 7) reconnects with a resume', async () => {
    const { client, sockets, clock } = makeGateway();
    client.start();
    const first = sockets.latest();
    first.receive(gateway.hello);
    first.receive(gateway.ready);
    first.receive(gateway.reconnect);
    await settle();

    clock.advance(1000);
    const second = sockets.latest();
    second.receive(gateway.hello);
    expect(second.sentOp(6)).toHaveLength(1);
  });

  test('a resume URL outside the service is ignored and the default gateway is dialled instead', async () => {
    const { client, sockets, clock } = makeGateway();
    client.start();
    const first = sockets.latest();
    first.receive(gateway.hello);
    first.receive(gateway.readyUntrustedResume);
    first.drop(1006);
    await settle();
    clock.advance(1000);

    expect(sockets.latest().url).toBe(GATEWAY_URL);
    expect(isTrustedGatewayUrl('wss://gateway.discord.gg')).toBe(true);
    expect(isTrustedGatewayUrl('wss://x.discord.gg.evil.com')).toBe(false);
    expect(isTrustedGatewayUrl('ws://gateway.discord.gg')).toBe(false);
  });

  test('stop closes cleanly, cancels timers and ignores late frames; restart drops the session', async () => {
    const { client, sockets, clock, dispatches } = makeGateway();
    client.start();
    const first = sockets.latest();
    first.receive(gateway.hello);
    first.receive(gateway.ready);

    client.stop();
    expect(first.closed?.code).toBe(1000);
    expect(clock.pending()).toBe(0);
    first.receive(gateway.guildCreate);
    expect(dispatches).toHaveLength(0);
    await settle();
    expect(sockets.sockets).toHaveLength(1);

    client.restart();
    const second = sockets.latest();
    second.receive(gateway.hello);
    expect(second.sentOp(2)).toHaveLength(1);
  });
});
