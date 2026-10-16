import { describe, expect, test } from 'bun:test';
import {
  applyWebrtcIceEnv,
  buildIceServers,
  defaultWebrtcIceConfig,
  normaliseWebrtcIceConfig
} from '../webrtc-ice';

// The TURN relay config reaches every client's RTCPeerConnection via
// /info, so the parser is where the bounds live: scheme allowlist, entry
// count, lengths, and a strict policy enum. config.ts is mocked in the
// suite, which is why the parser is a standalone helper.

describe('applyWebrtcIceEnv', () => {
  test('parses a comma list, trims, dedupes and keeps order', () => {
    const cfg = applyWebrtcIceEnv(defaultWebrtcIceConfig(), {
      WEBRTC_TURN_URLS:
        ' turn:relay.example.com:3478?transport=udp, turns:relay.example.com:5349 ,turn:relay.example.com:3478?transport=udp',
      WEBRTC_TURN_USERNAME: ' pulse ',
      WEBRTC_TURN_CREDENTIAL: 'secret',
      WEBRTC_ICE_TRANSPORT_POLICY: 'Relay'
    });

    expect(cfg.turn.urls).toEqual([
      'turn:relay.example.com:3478?transport=udp',
      'turns:relay.example.com:5349'
    ]);
    expect(cfg.turn.username).toBe('pulse');
    expect(cfg.turn.credential).toBe('secret');
    expect(cfg.iceTransportPolicy).toBe('relay');
  });

  test('drops entries outside the turn/turns/stun/stuns schemes', () => {
    const cfg = applyWebrtcIceEnv(defaultWebrtcIceConfig(), {
      WEBRTC_TURN_URLS:
        'https://relay.example.com,javascript:alert(1),stun:stun.example.com:3478,turn:with space'
    });
    expect(cfg.turn.urls).toEqual(['stun:stun.example.com:3478']);
  });

  test('bounds the entry count and the entry length', () => {
    const many = Array.from({ length: 12 }, (_, i) => `turn:r${i}.example.com:3478`);
    const cfg = applyWebrtcIceEnv(defaultWebrtcIceConfig(), {
      WEBRTC_TURN_URLS: [`turn:${'a'.repeat(300)}.example.com`, ...many].join(',')
    });
    expect(cfg.turn.urls).toHaveLength(8);
    expect(cfg.turn.urls[0]).toBe('turn:r0.example.com:3478');
  });

  test('an over-long credential is dropped, an unknown policy is ignored', () => {
    const cfg = applyWebrtcIceEnv(
      { ...defaultWebrtcIceConfig(), iceTransportPolicy: 'relay' },
      {
        WEBRTC_TURN_CREDENTIAL: 'x'.repeat(600),
        WEBRTC_ICE_TRANSPORT_POLICY: 'everything'
      }
    );
    expect(cfg.turn.credential).toBe('');
    expect(cfg.iceTransportPolicy).toBe('relay');
  });

  test('unset variables leave the base (INI) values untouched', () => {
    const base = normaliseWebrtcIceConfig({
      turn: { urls: ['turn:ini.example.com:3478'], username: 'ini' },
      iceTransportPolicy: 'relay'
    });
    const cfg = applyWebrtcIceEnv(base, { WEBRTC_TURN_CREDENTIAL: 'from-env' });
    expect(cfg.turn.urls).toEqual(['turn:ini.example.com:3478']);
    expect(cfg.turn.username).toBe('ini');
    expect(cfg.turn.credential).toBe('from-env');
    expect(cfg.iceTransportPolicy).toBe('relay');
  });
});

describe('normaliseWebrtcIceConfig', () => {
  test('tolerates a missing or malformed INI section', () => {
    expect(normaliseWebrtcIceConfig(undefined)).toEqual(defaultWebrtcIceConfig());
    expect(normaliseWebrtcIceConfig('nope')).toEqual(defaultWebrtcIceConfig());
    expect(normaliseWebrtcIceConfig({ turn: 'nope', iceTransportPolicy: 7 })).toEqual(
      defaultWebrtcIceConfig()
    );
  });

  test('accepts the INI list form and a single string', () => {
    expect(
      normaliseWebrtcIceConfig({ turn: { urls: 'turn:a.example.com:3478' } }).turn.urls
    ).toEqual(['turn:a.example.com:3478']);
    expect(
      normaliseWebrtcIceConfig({
        turn: { urls: ['turn:a.example.com:3478', 'bad'] }
      }).turn.urls
    ).toEqual(['turn:a.example.com:3478']);
  });
});

describe('buildIceServers', () => {
  test('is undefined without URLs, omits empty credentials, includes set ones', () => {
    expect(buildIceServers(defaultWebrtcIceConfig())).toBeUndefined();

    const bare = normaliseWebrtcIceConfig({
      turn: { urls: ['stun:stun.example.com:3478'] }
    });
    expect(buildIceServers(bare)).toEqual([{ urls: ['stun:stun.example.com:3478'] }]);

    const full = normaliseWebrtcIceConfig({
      turn: {
        urls: ['turn:relay.example.com:3478'],
        username: 'u',
        credential: 'c'
      }
    });
    expect(buildIceServers(full)).toEqual([
      { urls: ['turn:relay.example.com:3478'], username: 'u', credential: 'c' }
    ]);
  });
});
