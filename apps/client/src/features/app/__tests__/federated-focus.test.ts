/**
 * Reload while a federated server is in focus. The focus is persisted as
 * its (instance, id) pair — never through ACTIVE_SERVER_ID, which is the
 * HOME id the reload's first openSession loads — and is re-entered only
 * when it still matches a membership.
 *
 * Run via:
 *   bun test apps/client/src/features/app/__tests__/federated-focus.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  clearFederatedFocus,
  readFederatedFocus,
  resolveFederatedFocus,
  saveFederatedFocus
} from '@/features/app/federated-focus';
import type { TFederatedServerEntry } from '@/features/app/slice';
import { LocalStorageKey } from '@/helpers/storage';

const entry = (
  instanceDomain: string,
  id: number
): TFederatedServerEntry => ({
  instanceDomain,
  instanceName: instanceDomain,
  remoteUrl: `https://${instanceDomain}`,
  server: { id, publicId: `pub-${instanceDomain}-${id}`, name: 'S', logo: null },
  federationToken: 't',
  tokenExpiresAt: 0
});

afterEach(() => {
  clearFederatedFocus();
  localStorage.removeItem(LocalStorageKey.ACTIVE_SERVER_ID);
});

describe('federated focus persistence', () => {
  test('round-trips and never touches the home server id key', () => {
    localStorage.setItem(LocalStorageKey.ACTIVE_SERVER_ID, '3');
    saveFederatedFocus({ instanceDomain: 'peer.example', serverId: 3 });
    expect(readFederatedFocus()).toEqual({
      instanceDomain: 'peer.example',
      serverId: 3
    });
    expect(localStorage.getItem(LocalStorageKey.ACTIVE_SERVER_ID)).toBe('3');
    clearFederatedFocus();
    expect(readFederatedFocus()).toBeUndefined();
  });

  test('rejects malformed values instead of re-entering nonsense', () => {
    localStorage.setItem(
      LocalStorageKey.ACTIVE_FEDERATED_SERVER,
      JSON.stringify({ instanceDomain: 'peer.example', serverId: '3' })
    );
    expect(readFederatedFocus()).toBeUndefined();
    localStorage.setItem(
      LocalStorageKey.ACTIVE_FEDERATED_SERVER,
      JSON.stringify({ serverId: 3 })
    );
    expect(readFederatedFocus()).toBeUndefined();
    localStorage.setItem(LocalStorageKey.ACTIVE_FEDERATED_SERVER, '{');
    expect(readFederatedFocus()).toBeUndefined();
  });
});

describe('resolveFederatedFocus', () => {
  const entries = [entry('a.example', 3), entry('b.example', 3)];

  test('matches on the (instance, id) pair — the same id on another peer is not it', () => {
    expect(
      resolveFederatedFocus({ instanceDomain: 'b.example', serverId: 3 }, entries)
    ).toBe(entries[1]);
  });

  test('a stale focus (left, kicked, unpeered) resolves to nothing', () => {
    expect(
      resolveFederatedFocus({ instanceDomain: 'c.example', serverId: 3 }, entries)
    ).toBeUndefined();
    expect(
      resolveFederatedFocus({ instanceDomain: 'a.example', serverId: 9 }, entries)
    ).toBeUndefined();
    expect(resolveFederatedFocus(undefined, entries)).toBeUndefined();
  });
});
