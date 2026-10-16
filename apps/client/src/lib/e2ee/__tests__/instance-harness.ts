/**
 * Shared fixtures for the instance-explicit lib/e2ee tests.
 *
 * Nothing here talks to a server: tRPC clients are recording proxies
 * with per-route handlers, peers are real libsignal identities on
 * fake-indexeddb (so SKDMs are genuinely X3DH-encrypted and can be
 * opened by the peer to prove delivery), and instance context comes
 * from a Redux store built from the real reducers.
 *
 * `mock.module` is process-wide in bun:test and other files in this
 * directory replace `@/features/store`, `@/lib/trpc` and
 * `../identity-change-dispatch` for the rest of the run, in whatever
 * order the runner picks. This module installs its own replacements
 * for the same three, so its importers see a known shape whatever ran
 * before them — and because a module body runs once per process, each
 * test file calls `installModuleMocks()` itself before it imports the
 * lib, re-asserting the mocks over anything that ran in between.
 *
 * Importers MUST import './instance-dom-stubs' before this module, and
 * import `..` / `../store` / `../signal-protocol` dynamically after
 * `installModuleMocks()` — a static import binds index.ts to whatever
 * modules were registered first.
 */

import { mock, spyOn } from 'bun:test';
import { configureStore } from '@reduxjs/toolkit';
import { appSliceActions, appSliceReducer } from '@/features/app/slice';
import { dialogSliceReducer } from '@/features/dialogs/slice';
import { dmsSliceReducer } from '@/features/dms/slice';
import { friendsSliceReducer } from '@/features/friends/slice';
import { nameplatesSliceReducer } from '@/features/nameplates/slice';
import { serverScreenSliceReducer } from '@/features/server-screens/slice';
import { serverSliceActions, serverSliceReducer } from '@/features/server/slice';
import type { TFederatedServerEntry } from '@/features/app/slice';
import type { PreKeyBundle } from '../types';
import type { SignalProtocolStore as SignalProtocolStoreType } from '../store';

// --- Redux: the real reducers, a store of our own ---

export const testStore = configureStore({
  reducer: {
    app: appSliceReducer,
    server: serverSliceReducer,
    dialog: dialogSliceReducer,
    serverScreen: serverScreenSliceReducer,
    friends: friendsSliceReducer,
    dms: dmsSliceReducer,
    nameplates: nameplatesSliceReducer
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({ serializableCheck: false })
});

// --- tRPC: recording proxies routed by the active instance ---

export type RecordedCall = { path: string; input: unknown };
export type RouteHandlers = Record<string, (input: unknown) => unknown>;

/** Loose client type: the proxy satisfies any route the lib dereferences. */
type AnyClient = Record<string, unknown>;

export type FakeTrpc = {
  trpc: never;
  calls: RecordedCall[];
  handlers: RouteHandlers;
  /** Calls made to one route, in order. */
  callsTo: (path: string) => RecordedCall[];
};

/**
 * A tRPC proxy that resolves `a.b.c.query(input)` / `.mutate(input)`
 * to `handlers['a.b.c'](input)` and records every call. A route with
 * no handler rejects, so a test that forgot to model a dependency
 * fails loudly instead of silently returning undefined.
 */
export function fakeTrpc(handlers: RouteHandlers = {}): FakeTrpc {
  const calls: RecordedCall[] = [];
  const make = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get(_target, prop) {
        if (prop === 'query' || prop === 'mutate') {
          return async (input: unknown) => {
            const route = path.join('.');
            calls.push({ path: route, input });
            const handler = handlers[route];
            if (!handler) {
              throw new Error(`fakeTrpc: no handler for ${route}`);
            }
            return handler(input);
          };
        }
        if (prop === 'then') return undefined;
        return make([...path, String(prop)]);
      }
    });
  return {
    trpc: make([]) as never,
    calls,
    handlers,
    callsTo: (path) => calls.filter((c) => c.path === path)
  };
}

const clients: { home: FakeTrpc | null; remotes: Record<string, FakeTrpc> } = {
  home: null,
  remotes: {}
};

// --- Identity-changed dialog: a decision the test makes ---

export type IdentityChangeRequest = {
  userId: number;
  newIdentityPublicKey: string;
  store: SignalProtocolStoreType;
  resolve: (accepted: boolean) => void;
};

/** Every presentIdentityChange call since the last reset, in order. */
export const identityChangeRequests: IdentityChangeRequest[] = [];

class UntrustedIdentityError extends Error {
  readonly userId: number;
  readonly newIdentityPublicKey: string;
  constructor(userId: number, newIdentityPublicKey: string) {
    super(`Untrusted identity for user ${userId}`);
    this.name = 'UntrustedIdentityError';
    this.userId = userId;
    this.newIdentityPublicKey = newIdentityPublicKey;
  }
}

/** Register (or re-register) the harness's module replacements. */
export function installModuleMocks(): void {
  mock.module('@/features/store', () => ({ store: testStore }));
  mock.module('@/lib/trpc', () => ({
    getHomeTRPCClient: (): AnyClient | null => clients.home?.trpc ?? null,
    getTRPCClient: (): AnyClient | null => {
      const domain = testStore.getState().app.activeInstanceDomain;
      if (domain) return clients.remotes[domain]?.trpc ?? null;
      return clients.home?.trpc ?? null;
    },
    connectToTRPC: () => {
      throw new Error('connectToTRPC is not available under the e2ee test harness');
    },
    cleanup: () => undefined
  }));
  mock.module('../identity-change-dispatch', () => ({
    presentIdentityChange: (
      userId: number,
      newIdentityPublicKey: string,
      store: SignalProtocolStoreType
    ) =>
      new Promise<boolean>((resolve) => {
        identityChangeRequests.push({ userId, newIdentityPublicKey, store, resolve });
      }),
    UntrustedIdentityError
  }));
}

installModuleMocks();

/**
 * Settle the pending dialog for `userId` the way the real one does:
 * Accept re-pins in the store it was raised for and resolves true;
 * Block resolves false and leaves the pin alone.
 */
export async function decideIdentityChange(
  userId: number,
  decision: 'accept' | 'block'
): Promise<void> {
  const request = identityChangeRequests.find((r) => r.userId === userId);
  if (!request) throw new Error(`no pending identity change for user ${userId}`);
  if (decision === 'accept') {
    await request.store.acceptIdentityChange(userId, request.newIdentityPublicKey);
  }
  request.resolve(decision === 'accept');
}

// Everything below depends on the mocks above being in place.
const { connectionManager } = await import('@/lib/connection-manager');
const { buildSession, decryptMessage, encryptMessage, generateKeys } =
  await import('../signal-protocol');
const { SignalProtocolStore, signalStore } = await import('../store');

// --- libsignal peers ---

/**
 * A libsignal identity in its own IDB store. `bundle()` hands out the
 * next unused one-time prekey, like the server route does.
 */
export type Peer = {
  store: SignalProtocolStoreType;
  keys: Awaited<ReturnType<typeof generateKeys>>;
  identityPublicKey: string;
  bundle: () => PreKeyBundle;
  /** Open a pairwise ciphertext this peer received from `fromUserId`. */
  decryptFrom: (fromUserId: number, ciphertext: string) => Promise<string>;
};

let peerCounter = 0;

export async function createPeer(store?: SignalProtocolStoreType): Promise<Peer> {
  const s = store ?? new SignalProtocolStore(`test-peer-${++peerCounter}`);
  if (!store) await s.clearAll();
  const keys = await generateKeys(4, s);
  let nextOtp = 0;
  return {
    store: s,
    keys,
    identityPublicKey: keys.identityPublicKey,
    bundle: () => ({
      identityPublicKey: keys.identityPublicKey,
      registrationId: keys.registrationId,
      signedPreKey: keys.signedPreKey,
      oneTimePreKey: keys.oneTimePreKeys[nextOtp++] ?? null
    }),
    decryptFrom: (fromUserId, ciphertext) =>
      decryptMessage(fromUserId, ciphertext, s)
  };
}

/**
 * Encrypt `plaintext` from `sender` to `recipient` under a fresh X3DH
 * session, addressing the recipient as `recipientAddressId` in the
 * sender's store — what a peer does when it SKDMs us.
 */
export async function encryptFromPeer(
  sender: Peer,
  recipient: Peer,
  recipientAddressId: number,
  plaintext: string
): Promise<string> {
  await buildSession(recipientAddressId, recipient.bundle(), sender.store);
  return encryptMessage(recipientAddressId, plaintext, sender.store);
}

/** Give the home store a fresh identity (hasKeys() becomes true). */
export async function installHomeIdentity(): Promise<Peer> {
  await signalStore.clearAll();
  return createPeer(signalStore);
}

// --- Instance context ---

/**
 * Redux state the instance helpers read. `activeDomain` = the server
 * in focus; `activeOwnUserId` = state.server.ownUserId (ambient id on
 * the active server); `homeOwnUserId` = our id at home.
 */
export function setInstanceState(opts: {
  homeOwnUserId: number;
  activeDomain?: string | null;
  activeOwnUserId?: number;
  federatedServers?: TFederatedServerEntry[];
}): void {
  testStore.dispatch(appSliceActions.setHomeOwnUserId(opts.homeOwnUserId));
  testStore.dispatch(
    appSliceActions.setActiveInstanceDomain(opts.activeDomain ?? null)
  );
  testStore.dispatch(
    appSliceActions.setFederatedServers(opts.federatedServers ?? [])
  );
  testStore.dispatch(
    serverSliceActions.setInitialData({
      serverId: 'test-server',
      categories: [],
      channels: [],
      ownUserId: opts.activeOwnUserId ?? opts.homeOwnUserId,
      roles: [],
      channelPermissions: {},
      readStates: {}
    })
  );
}

export function federatedEntry(
  instanceDomain: string,
  ownUserId?: number
): TFederatedServerEntry {
  return {
    instanceDomain,
    instanceName: instanceDomain,
    remoteUrl: `https://${instanceDomain}`,
    server: { id: 1, name: 'Remote', publicId: `srv-${instanceDomain}`, logo: null },
    federationToken: 'token',
    tokenExpiresAt: Date.now() + 3_600_000,
    ownUserId
  };
}

export function resetInstanceState(): void {
  testStore.dispatch(appSliceActions.setHomeOwnUserId(undefined));
  testStore.dispatch(appSliceActions.setActiveInstanceDomain(null));
  testStore.dispatch(appSliceActions.setFederatedServers([]));
  testStore.dispatch(serverSliceActions.resetState());
  identityChangeRequests.length = 0;
}

type Spies = { mockRestore: () => void }[];

/**
 * Route the lib's client lookups: `home` answers getHomeTRPCClient,
 * `remotes[domain]` answers connectionManager.getRemoteTRPCClient and
 * getConnectedDomains, and getTRPCClient follows the active domain
 * the way the real one does.
 */
export function installClients(opts: {
  home: FakeTrpc | null;
  remotes?: Record<string, FakeTrpc>;
}): () => void {
  clients.home = opts.home;
  clients.remotes = opts.remotes ?? {};
  const spies: Spies = [
    spyOn(connectionManager, 'getRemoteTRPCClient').mockImplementation(
      (domain: string) => (clients.remotes[domain]?.trpc ?? null) as never
    ),
    spyOn(connectionManager, 'getConnectedDomains').mockImplementation(() =>
      Object.keys(clients.remotes)
    )
  ];
  return () => {
    for (const spy of spies) spy.mockRestore();
    clients.home = null;
    clients.remotes = {};
  };
}

/** Poll until `predicate` holds or the budget runs out. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
