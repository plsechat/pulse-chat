/**
 * The community header's logo is the CONNECTED community's own logo,
 * served by the instance that owns it. It used to read
 * `state.server.info.logo` — the home /info payload's FIRST community —
 * so every other home community and every federated community showed
 * a stranger's logo (and a federated one requested it from the wrong
 * host). The tile is its own component (CommunityLogo) so it renders
 * with react-dom under happy-dom on the connection harness's store
 * without the rest of the sidebar's device/voice providers.
 *
 * Run via: bun test apps/client/src/components/left-sidebar/__tests__/header-logo.test.tsx
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import type {
  TFile,
  TPublicServerSettings,
  TServerInfo
} from '@pulse/server/types';
import { appSliceActions } from '@/features/app/slice';
import { serverSliceActions } from '@/features/server/slice';
import { registerRemoteInstanceUrl } from '@/helpers/get-file-url';
import {
  installConnectionMocks,
  resetConnectionState,
  testStore
} from '@/__tests__/home-connection-harness';

installConnectionMocks();

// Imported after the mocks so `@/features/store` resolves to the harness store.
const { CommunityLogo } = await import('../community-logo');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const PEER = 'pulse-fed-b:4991';
const HOME_ORIGIN = `${window.location.protocol}//${window.location.host}`;

const file = (name: string): TFile => ({ id: 1, name }) as unknown as TFile;

const publicSettings = (
  publicId: string,
  logo: TFile | null | undefined
): TPublicServerSettings =>
  ({
    id: 1,
    name: 'Pulse Server',
    description: '',
    publicId,
    logo
  }) as unknown as TPublicServerSettings;

/** Connect to a community: what openSession's payload does to the slice. */
const connect = (publicId: string, logo: TFile | null | undefined) =>
  testStore.dispatch(
    serverSliceActions.setInitialData({
      serverId: publicId,
      categories: [],
      channels: [],
      ownUserId: 1,
      roles: [],
      publicSettings: publicSettings(publicId, logo),
      channelPermissions: {},
      readStates: {}
    })
  );

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const mount = async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(Provider, {
        store: testStore,
        children: createElement(CommunityLogo)
      })
    );
  });
  return host;
};

const headerLogo = (el: HTMLElement) =>
  el.querySelector<HTMLImageElement>('.squircle img');

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  host?.remove();
  root = null;
  host = null;
  resetConnectionState();
});

describe('community header logo', () => {
  test('a federated community shows its own logo from its own instance', async () => {
    registerRemoteInstanceUrl(PEER, `http://${PEER}`);
    // The home instance's first community has a logo of its own.
    testStore.dispatch(
      serverSliceActions.setInfo({
        logo: file('home-first.png'),
        name: 'Home',
        version: '0'
      } as TServerInfo)
    );
    testStore.dispatch(
      appSliceActions.setFederatedServers([
        {
          instanceDomain: PEER,
          instanceName: 'Peer',
          remoteUrl: `http://${PEER}`,
          server: {
            id: 1,
            publicId: 'pub-remote',
            name: 'Pulse Server',
            logo: file('remote-logo.png')
          },
          federationToken: 't',
          tokenExpiresAt: 0
        }
      ])
    );
    connect('pub-remote', file('remote-logo.png'));

    const el = await mount();
    const img = headerLogo(el);
    expect(img).not.toBeNull();
    expect(img!.src).toBe(`http://${PEER}/public/remote-logo.png`);
    expect(img!.src).not.toContain('home-first.png');
  });

  test('a second home community shows its own logo, not the first community’s', async () => {
    testStore.dispatch(
      serverSliceActions.setInfo({
        logo: file('home-first.png'),
        name: 'Home',
        version: '0'
      } as TServerInfo)
    );
    testStore.dispatch(appSliceActions.setFederatedServers([]));
    connect('pub-home-second', file('second-home.png'));

    const el = await mount();
    const img = headerLogo(el);
    expect(img).not.toBeNull();
    expect(img!.src).toBe(`${HOME_ORIGIN}/public/second-home.png`);
  });

  test('a community without a logo shows its initial, never info.logo', async () => {
    testStore.dispatch(
      serverSliceActions.setInfo({
        logo: file('home-first.png'),
        name: 'Home',
        version: '0'
      } as TServerInfo)
    );
    testStore.dispatch(appSliceActions.setFederatedServers([]));
    connect('pub-home-plain', null);

    const el = await mount();
    expect(headerLogo(el)).toBeNull();
    expect(el.querySelector('.squircle')?.textContent).toBe('P');
  });
});
