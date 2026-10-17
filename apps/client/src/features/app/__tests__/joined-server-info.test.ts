/**
 * SERVER_SETTINGS_UPDATE reaches the joined summaries (rail, deck tabs,
 * Discover card) with the description included; fields an older server
 * leaves out of the payload stay as they were.
 *
 * Run via: bun test apps/client/src/features/app/__tests__/joined-server-info.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { TServerSummary } from '@pulse/server/types';
import { appSliceActions, appSliceReducer, type TAppState } from '../slice';

const summary = (overrides: Partial<TServerSummary> = {}): TServerSummary => ({
  id: 1,
  name: 'Pulse Server',
  publicId: 'srv_home',
  logo: null,
  description: 'The old blurb',
  ...overrides
});

const withServers = (...servers: TServerSummary[]): TAppState =>
  appSliceReducer(undefined, appSliceActions.setJoinedServers(servers));

describe('updateJoinedServerInfo', () => {
  test('carries name, description and logo onto the matching summary', () => {
    const logo = { id: 9, name: 'logo.png' } as TServerSummary['logo'];
    const state = appSliceReducer(
      withServers(summary(), summary({ id: 2, publicId: 'srv_other' })),
      appSliceActions.updateJoinedServerInfo({
        publicId: 'srv_home',
        name: 'Pulse Server (renamed)',
        description: 'A new description',
        logo
      })
    );
    expect(state.joinedServers[0]).toMatchObject({
      name: 'Pulse Server (renamed)',
      description: 'A new description',
      logo
    });
    // The other community is untouched.
    expect(state.joinedServers[1]).toEqual(
      summary({ id: 2, publicId: 'srv_other' })
    );
  });

  test('a cleared description is carried as cleared', () => {
    const state = appSliceReducer(
      withServers(summary()),
      appSliceActions.updateJoinedServerInfo({
        publicId: 'srv_home',
        description: ''
      })
    );
    expect(state.joinedServers[0].description).toBe('');
  });

  test('fields missing from the payload (older server) stay as they were', () => {
    const state = appSliceReducer(
      withServers(summary({ logo: { id: 3, name: 'old.png' } as TServerSummary['logo'] })),
      appSliceActions.updateJoinedServerInfo({
        publicId: 'srv_home',
        name: 'Only the name'
      })
    );
    expect(state.joinedServers[0]).toMatchObject({
      name: 'Only the name',
      description: 'The old blurb',
      logo: { id: 3, name: 'old.png' }
    });
  });

  test('matches by publicId, never by the numeric id', () => {
    const state = appSliceReducer(
      withServers(summary({ id: 7, publicId: 'srv_a' }), summary({ id: 7, publicId: 'srv_b' })),
      appSliceActions.updateJoinedServerInfo({
        publicId: 'srv_b',
        name: 'B renamed'
      })
    );
    expect(state.joinedServers[0].name).toBe('Pulse Server');
    expect(state.joinedServers[1].name).toBe('B renamed');
  });

  test('an unknown publicId changes nothing', () => {
    const before = withServers(summary());
    const after = appSliceReducer(
      before,
      appSliceActions.updateJoinedServerInfo({
        publicId: 'srv_unknown',
        name: 'x',
        description: 'y'
      })
    );
    expect(after.joinedServers).toEqual(before.joinedServers);
  });
});
