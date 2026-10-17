/**
 * Server Settings → Bridge, linked state: the status card renders the
 * remote server, the pairing settings in words, the counts, the last
 * sync, every skipped channel with its reason, the error and the
 * deletion note — from the status alone.
 *
 * Run via: bun test apps/client/src/components/server-screens/server-settings/bridge/__tests__/status-card.test.tsx
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, describe, expect, test } from 'bun:test';
import type { TBridgeServerStatus } from '@pulse/server/types';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BridgeStatusCard } from '..';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_760_000_000_000;

const status = (overrides: Partial<TBridgeServerStatus> = {}): TBridgeServerStatus => ({
  available: true,
  configured: true,
  connected: true,
  botUser: { id: '9', name: 'pulse-bridge' },
  lastError: null,
  link: {
    id: 1,
    serverId: 1,
    remoteGuildId: '100000000000000001',
    mode: 'mirror',
    createMissing: 'both',
    defaultDirection: 'inbound',
    createdBy: 1,
    createdAt: NOW - 3_600_000
  },
  remoteGuildName: 'Night Raiders',
  counts: { paired: 4, excluded: 1, manual: 2 },
  sync: {
    running: false,
    last: {
      trigger: 'link',
      startedAt: NOW - 125_000,
      finishedAt: NOW - 120_000,
      paired: 4,
      createdHere: 1,
      createdThere: 2,
      removed: 0,
      skipped: [
        { name: 'Voice', side: 'there', reason: 'voice channel' },
        { name: 'secret', side: 'here', reason: 'end-to-end encrypted' }
      ],
      error: null
    }
  },
  ...overrides
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const mount = (value: TBridgeServerStatus) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(BridgeStatusCard, { status: value, now: NOW })));
  return container.textContent ?? '';
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('BridgeStatusCard', () => {
  test('renders the linked server, settings, counts, last sync, skipped reasons and the deletion note', () => {
    const text = mount(status());

    expect(text).toContain('Night Raiders');
    expect(text).toContain('mirror, creating missing channels on both sides, only from there by default');
    expect(text).toContain('4 channels paired · 1 excluded · 2 linked on their own');
    expect(text).toContain('Last sync 2 minutes ago: 4 channels paired, 1 created here, 2 created there, 2 skipped.');
    expect(text).toContain('#Voice (there) — voice channel');
    expect(text).toContain('#secret (here) — end-to-end encrypted');
    expect(text).toContain('Deletions are never mirrored.');
    expect(text).not.toContain('reported an error');
  });

  test('a running sync, an unknown guild name and a plugin error each show; nothing renders without a link', () => {
    const text = mount(
      status({
        remoteGuildName: null,
        lastError: 'The bot token was rejected',
        sync: { running: true, last: null }
      })
    );

    expect(text).toContain('server 100000000000000001');
    expect(text).toContain('Pairing channels…');
    expect(text).toContain('The bot token was rejected');
    expect(text).not.toContain('Left alone');

    act(() => root?.unmount());
    expect(mount(status({ link: null }))).toBe('');
  });
});
