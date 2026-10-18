/**
 * getFileUrl resolves a file against the instance that OWNS it: the
 * home server by default, a federated peer's registered base URL when
 * the caller passes that peer's instance domain. A federated logo or
 * avatar rendered without the domain pointed at `<home>/public/<uuid>`
 * and 404'd — the broken tab icon of the v0.4.0 follow-up round.
 *
 * Run via: bun test apps/client/src/helpers/__tests__/get-file-url.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { TFileRef } from '@pulse/server/types';
import { getFileUrl, registerRemoteInstanceUrl } from '../get-file-url';

const file = (name: string): TFileRef => ({ name }) as TFileRef;

describe('getFileUrl', () => {
  test('without an instance domain the file lives on the home server', () => {
    const url = getFileUrl(file('logo.png'));
    expect(url).toBe(`${window.location.protocol}//${window.location.host}/public/logo.png`);
  });

  test('a registered peer base is used as-is for that instance domain', () => {
    // What the home server hands out for a plain-http LAN peer (and the
    // trailing slash a hand-typed URL may carry).
    registerRemoteInstanceUrl('pulse-fed-b:4991', 'http://pulse-fed-b:4991/');
    expect(getFileUrl(file('a1b2.png'), 'pulse-fed-b:4991')).toBe(
      'http://pulse-fed-b:4991/public/a1b2.png'
    );
  });

  test('an unregistered domain falls back to https, localhost to http', () => {
    expect(getFileUrl(file('x.png'), 'peer.example.com')).toBe(
      'https://peer.example.com/public/x.png'
    );
    expect(getFileUrl(file('x.png'), 'localhost:4991')).toBe(
      'http://localhost:4991/public/x.png'
    );
  });

  test('a per-file access token rides along; no file is an empty src', () => {
    registerRemoteInstanceUrl('pulse-fed-b:4991', 'http://pulse-fed-b:4991');
    expect(
      getFileUrl({ ...file('dm.png'), _accessToken: 'tok' }, 'pulse-fed-b:4991')
    ).toBe('http://pulse-fed-b:4991/public/dm.png?accessToken=tok');
    expect(getFileUrl(null)).toBe('');
    expect(getFileUrl(undefined, 'pulse-fed-b:4991')).toBe('');
  });
});
