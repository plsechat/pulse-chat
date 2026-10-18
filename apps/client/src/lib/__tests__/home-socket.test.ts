/**
 * lib/home-socket — one live client, one retry machine.
 *
 *  - a recoverable close retires the dying client (which is what stops
 *    tRPC's own reconnect) and hands the code to the reconnect hook
 *  - the replaced client is an orphan: its later close neither nulls
 *    the live client nor reports anything
 *  - ban / deletion / revocation report a non-recoverable close
 *  - an intentional close reports nothing
 *
 * Run via: bun test apps/client/src/lib/__tests__/home-socket.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { DisconnectCode } from '@pulse/shared';
import {
  createHomeSocketManager,
  isNonRecoverable,
  type HomeSocketDeps,
  type HomeSocketHooks
} from '../home-socket';

type Options = Parameters<HomeSocketDeps['createWSClient']>[0];

type FakeWs = {
  id: number;
  opts: Options;
  closeCalls: number;
  close: () => Promise<void>;
};

/** A socket factory that hands out inspectable clients. */
function fakeSocketFactory() {
  const created: FakeWs[] = [];
  const deps: HomeSocketDeps = {
    createWSClient: (opts) => {
      const ws: FakeWs = {
        id: created.length + 1,
        opts,
        closeCalls: 0,
        close: async () => {
          ws.closeCalls++;
        }
      };
      created.push(ws);
      return ws as never;
    },
    createTrpcClient: (ws) => ({ clientFor: (ws as unknown as FakeWs).id }) as never
  };
  return { created, deps };
}

const closeWith = (ws: FakeWs, code: number) => ws.opts.onClose?.({ code });

let hooks: HomeSocketHooks;
let recoverable: ReturnType<typeof mock>;
let nonRecoverable: ReturnType<typeof mock>;

beforeEach(() => {
  recoverable = mock(() => undefined);
  nonRecoverable = mock(() => undefined);
  hooks = {
    getAccessToken: async () => 'token',
    onRecoverableClose: recoverable as never,
    onNonRecoverableClose: nonRecoverable as never
  };
});

describe('recoverable close', () => {
  test('retires the dying client and reports the code once', () => {
    const { created, deps } = fakeSocketFactory();
    const manager = createHomeSocketManager(hooks, deps);

    const client = manager.connect('ws://home');
    expect(manager.getClient()).toBe(client);
    expect(created).toHaveLength(1);

    closeWith(created[0]!, DisconnectCode.UNEXPECTED);

    expect(created[0]!.closeCalls).toBe(1);
    expect(manager.getClient()).toBeNull();
    expect(recoverable).toHaveBeenCalledTimes(1);
    expect(recoverable).toHaveBeenCalledWith(DisconnectCode.UNEXPECTED);
    expect(nonRecoverable).not.toHaveBeenCalled();
  });

  test('a missing code counts as recoverable', () => {
    const { created, deps } = fakeSocketFactory();
    const manager = createHomeSocketManager(hooks, deps);
    manager.connect('ws://home');

    created[0]!.opts.onClose?.(undefined);

    expect(recoverable).toHaveBeenCalledWith(0);
  });
});

describe('orphan guard', () => {
  test('after a reconnect exactly one client is live and the old one is closed', () => {
    const { created, deps } = fakeSocketFactory();
    const manager = createHomeSocketManager(hooks, deps);

    manager.connect('ws://home');
    closeWith(created[0]!, DisconnectCode.UNEXPECTED);
    const second = manager.connect('ws://home');

    expect(created).toHaveLength(2);
    expect(manager.getClient()).toBe(second);
    expect(created[0]!.closeCalls).toBe(1);
    expect(created[1]!.closeCalls).toBe(0);
  });

  test("the orphan's later close does not null the live client or report", () => {
    const { created, deps } = fakeSocketFactory();
    const manager = createHomeSocketManager(hooks, deps);

    manager.connect('ws://home');
    closeWith(created[0]!, DisconnectCode.UNEXPECTED);
    const second = manager.connect('ws://home');
    recoverable.mockClear();

    // Server restart / idle kill reaching the retired socket.
    closeWith(created[0]!, DisconnectCode.SERVER_SHUTDOWN);
    closeWith(created[0]!, DisconnectCode.BANNED);

    expect(manager.getClient()).toBe(second);
    expect(recoverable).not.toHaveBeenCalled();
    expect(nonRecoverable).not.toHaveBeenCalled();
    expect(created[0]!.closeCalls).toBe(1);
  });

  test('connecting over a live client retires it without reporting', () => {
    const { created, deps } = fakeSocketFactory();
    const manager = createHomeSocketManager(hooks, deps);

    manager.connect('ws://home');
    const second = manager.connect('ws://home');

    expect(created[0]!.closeCalls).toBe(1);
    expect(manager.getClient()).toBe(second);
    closeWith(created[0]!, DisconnectCode.UNEXPECTED);
    expect(recoverable).not.toHaveBeenCalled();
    expect(manager.getClient()).toBe(second);
  });
});

describe('non-recoverable close', () => {
  test.each([
    DisconnectCode.BANNED,
    DisconnectCode.ACCOUNT_DELETED,
    DisconnectCode.SESSION_REVOKED
  ])('code %i reports a non-recoverable close and never a reconnect', (code) => {
    const { created, deps } = fakeSocketFactory();
    const manager = createHomeSocketManager(hooks, deps);
    manager.connect('ws://home');

    closeWith(created[0]!, code);

    expect(isNonRecoverable(code)).toBe(true);
    expect(nonRecoverable).toHaveBeenCalledTimes(1);
    expect(nonRecoverable.mock.calls[0]![0]).toMatchObject({
      code,
      reason: '',
      wasClean: false
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(manager.getClient()).toBeNull();
    expect(created[0]!.closeCalls).toBe(1);
  });

  test('reads reason and wasClean from a real CloseEvent', () => {
    const { created, deps } = fakeSocketFactory();
    const manager = createHomeSocketManager(hooks, deps);
    manager.connect('ws://home');

    const event = new CloseEvent('close', {
      code: DisconnectCode.BANNED,
      reason: 'banned for spam',
      wasClean: true
    });
    created[0]!.opts.onClose?.(event);

    expect(nonRecoverable.mock.calls[0]![0]).toEqual({
      code: DisconnectCode.BANNED,
      reason: 'banned for spam',
      wasClean: true
    });
  });
});

describe('intentional close', () => {
  test('close() retires the client and its close callback is ignored', () => {
    const { created, deps } = fakeSocketFactory();
    const manager = createHomeSocketManager(hooks, deps);
    manager.connect('ws://home');

    manager.close();
    expect(manager.getClient()).toBeNull();
    expect(created[0]!.closeCalls).toBe(1);

    closeWith(created[0]!, 1000);
    expect(recoverable).not.toHaveBeenCalled();
    expect(nonRecoverable).not.toHaveBeenCalled();
  });

  test('close() with nothing live is a no-op', () => {
    const { deps } = fakeSocketFactory();
    const manager = createHomeSocketManager(hooks, deps);
    expect(() => manager.close()).not.toThrow();
  });
});

describe('connection params', () => {
  test('presents the current access token, empty when there is none', async () => {
    const { created, deps } = fakeSocketFactory();
    let token: string | null = 'abc';
    const manager = createHomeSocketManager(
      { ...hooks, getAccessToken: async () => token },
      deps
    );
    manager.connect('ws://home');
    const params = created[0]!.opts.connectionParams as () => Promise<{
      accessToken: string;
    }>;

    expect(await params()).toEqual({ accessToken: 'abc' });
    token = null;
    expect(await params()).toEqual({ accessToken: '' });
  });

  test('uses the url it was given with keepalive on', () => {
    const { created, deps } = fakeSocketFactory();
    createHomeSocketManager(hooks, deps).connect('wss://home.example');
    expect(created[0]!.opts.url).toBe('wss://home.example');
    expect(created[0]!.opts.keepAlive?.enabled).toBe(true);
  });
});
