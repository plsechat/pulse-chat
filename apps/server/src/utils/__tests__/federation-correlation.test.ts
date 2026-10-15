/**
 * Phase debug-logging / Phase 1 — cross-instance correlation header.
 *
 * Verifies the `X-Pulse-Request-Id` propagation that lets a single
 * trace span both sides of a federation call:
 *
 *   - Outbound `relayToInstance` / `queryInstance` reuse the active
 *     log-context's `requestId` if one is in scope, or mint a fresh
 *     id when called outside any scope.
 *   - The header value matches the in-scope context exactly, so a
 *     receiver that extracts and seeds its own context sees the
 *     same id the sender logged.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { config } from '../../config';
import {
  mockDns,
  seedPeerInstance,
  spyOnFetch
} from '../../__tests__/federation-fixtures';
import { initTest } from '../../__tests__/helpers';
import { generateFederationKeys, relayToInstance } from '../federation';
import { withLogContext } from '../log-context';

config.federation.enabled = true;

const PEER_DOMAIN = 'corr.example.com';

afterEach(() => {
  mock.restore();
});

describe('cross-instance correlation header', () => {
  test('relayToInstance carries the active log-context requestId', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedPeerInstance(PEER_DOMAIN);

    const { calls } = spyOnFetch();

    await withLogContext({ requestId: 'trace-from-test' }, async () => {
      await relayToInstance(PEER_DOMAIN, '/federation/info', {
        anything: 1
      });
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['x-pulse-request-id']).toBe('trace-from-test');
  });

  test('relayToInstance mints a fresh id when called outside any scope', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedPeerInstance(PEER_DOMAIN);

    const { calls } = spyOnFetch();

    await relayToInstance(PEER_DOMAIN, '/federation/info', { x: 1 });

    expect(calls).toHaveLength(1);
    const id = calls[0]!.headers['x-pulse-request-id'];
    expect(typeof id).toBe('string');
    expect(id!.length).toBeGreaterThan(20);
  });
});
