/**
 * lib/voice-client — which tRPC client a voice call goes through.
 *
 *  - no pin → the home client
 *  - a pinned instance → THAT instance's client, whatever is in focus
 *  - a pinned instance that is not connected → null, never home
 *
 * Run via: bun test apps/client/src/lib/__tests__/voice-client.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { resolveVoiceTRPCClient } from '../voice-client';

const HOME = { name: 'home' };
const PEER = { name: 'peer.example' };

const remotes: Record<string, typeof PEER> = { 'peer.example': PEER };
const getRemote = (domain: string) => remotes[domain] ?? null;
const getHome = () => HOME;

describe('resolveVoiceTRPCClient', () => {
  test('an unpinned session resolves to home', () => {
    expect(resolveVoiceTRPCClient(undefined, getRemote, getHome)).toBe(HOME);
  });

  test('a session pinned to a connected instance resolves to it', () => {
    expect(resolveVoiceTRPCClient('peer.example', getRemote, getHome)).toBe(
      PEER
    );
  });

  test('a session pinned to a disconnected instance resolves to null, not home', () => {
    expect(resolveVoiceTRPCClient('gone.example', getRemote, getHome)).toBeNull();
  });

  test('home being down surfaces as null for an unpinned session', () => {
    expect(resolveVoiceTRPCClient(undefined, getRemote, () => null)).toBeNull();
  });
});
