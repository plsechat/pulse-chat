import { afterEach, describe, expect, test } from 'bun:test';
import { getClientIp, resolvePublicOrigin } from '../../helpers/get-ws-info';

const ORIGINAL_TRUST_PROXY = process.env.TRUST_PROXY;
const ORIGINAL_PUBLIC_URL = process.env.PUBLIC_URL;

const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

afterEach(() => {
  restore('TRUST_PROXY', ORIGINAL_TRUST_PROXY);
  restore('PUBLIC_URL', ORIGINAL_PUBLIC_URL);
});

const req = (
  headers: Record<string, string | string[] | undefined>,
  socket: { remoteAddress?: string; encrypted?: boolean } = {
    remoteAddress: '10.0.0.9'
  }
) => ({ headers, socket });

describe('getClientIp', () => {
  test('without TRUST_PROXY, proxy headers are ignored', () => {
    delete process.env.TRUST_PROXY;

    expect(
      getClientIp(
        req({
          'x-forwarded-for': '6.6.6.6',
          'x-real-ip': '7.7.7.7',
          'cf-connecting-ip': '8.8.8.8'
        })
      )
    ).toBe('10.0.0.9');
  });

  test('with TRUST_PROXY, takes the RIGHTMOST X-Forwarded-For hop', () => {
    process.env.TRUST_PROXY = 'true';

    expect(
      getClientIp(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.4' }))
    ).toBe('198.51.100.4');
    expect(
      getClientIp(req({ 'x-forwarded-for': '1.1.1.1,2.2.2.2 , 3.3.3.3' }))
    ).toBe('3.3.3.3');
  });

  test('with TRUST_PROXY, cf-connecting-ip / x-real-ip are ignored unless TRUST_PROXY_HEADER names them', () => {
    process.env.TRUST_PROXY = 'true';
    delete process.env.TRUST_PROXY_HEADER;

    // A proxy that does not overwrite these headers passes a client value
    // through; without an explicit opt-in they must not win.
    expect(
      getClientIp(
        req({
          'cf-connecting-ip': '198.51.100.8',
          'x-forwarded-for': '6.6.6.6, 9.9.9.9'
        })
      )
    ).toBe('9.9.9.9');
    expect(
      getClientIp(
        req({ 'x-real-ip': '198.51.100.9', 'x-forwarded-for': '6.6.6.6' })
      )
    ).toBe('6.6.6.6');
    expect(getClientIp(req({ 'x-real-ip': '198.51.100.9' }))).toBe('10.0.0.9');
  });

  test('TRUST_PROXY_HEADER opts a single overwriting header in', () => {
    process.env.TRUST_PROXY = 'true';
    process.env.TRUST_PROXY_HEADER = 'cf-connecting-ip';

    expect(
      getClientIp(
        req({
          'cf-connecting-ip': '198.51.100.8',
          'x-forwarded-for': '6.6.6.6, 9.9.9.9'
        })
      )
    ).toBe('198.51.100.8');
    // The other override header stays untrusted.
    expect(
      getClientIp(
        req({ 'x-real-ip': '198.51.100.9', 'x-forwarded-for': '6.6.6.6' })
      )
    ).toBe('6.6.6.6');
    // Unknown names are ignored entirely.
    process.env.TRUST_PROXY_HEADER = 'x-custom-ip';
    expect(getClientIp(req({ 'x-custom-ip': '198.51.100.7', 'x-forwarded-for': '6.6.6.6' }))).toBe('6.6.6.6');
    delete process.env.TRUST_PROXY_HEADER;
  });

  test('garbage header values fall back to the socket address', () => {
    process.env.TRUST_PROXY = 'true';

    expect(getClientIp(req({ 'x-forwarded-for': 'garbage' }))).toBe('10.0.0.9');
    expect(getClientIp(req({ 'x-forwarded-for': '__proto__' }))).toBe('10.0.0.9');
    expect(getClientIp(req({ 'x-forwarded-for': 'x'.repeat(16_000) }))).toBe(
      '10.0.0.9'
    );
    process.env.TRUST_PROXY_HEADER = 'x-real-ip';
    expect(getClientIp(req({ 'x-real-ip': '999.1.1.1' }))).toBe('10.0.0.9');
    delete process.env.TRUST_PROXY_HEADER;
  });

  test('normalises IPv4-mapped IPv6, brackets and ::1', () => {
    delete process.env.TRUST_PROXY;

    expect(getClientIp(req({}, { remoteAddress: '::ffff:192.0.2.1' }))).toBe(
      '192.0.2.1'
    );
    expect(getClientIp(req({}, { remoteAddress: '::1' }))).toBe('127.0.0.1');

    process.env.TRUST_PROXY = 'true';
    expect(getClientIp(req({ 'x-forwarded-for': '[2001:db8::1]' }))).toBe(
      '2001:db8::1'
    );
  });

  test('returns "unknown" when nothing usable is present', () => {
    delete process.env.TRUST_PROXY;

    expect(getClientIp(req({}, {}))).toBe('unknown');
    expect(getClientIp(req({}, { remoteAddress: 'not-an-ip' }))).toBe('unknown');
  });
});

describe('resolvePublicOrigin', () => {
  test('without TRUST_PROXY: Host header and http', () => {
    delete process.env.TRUST_PROXY;
    delete process.env.PUBLIC_URL;

    expect(
      resolvePublicOrigin(
        req({
          host: 'pulse.example.com',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'evil.example'
        })
      )
    ).toEqual({ proto: 'http', host: 'pulse.example.com' });
  });

  test('a TLS socket yields https even without a proxy', () => {
    delete process.env.TRUST_PROXY;
    delete process.env.PUBLIC_URL;

    expect(
      resolvePublicOrigin(
        req({ host: 'pulse.example.com:5443' }, { remoteAddress: '10.0.0.9', encrypted: true })
      )
    ).toEqual({ proto: 'https', host: 'pulse.example.com:5443' });
  });

  test('with TRUST_PROXY: validated x-forwarded-proto / x-forwarded-host', () => {
    process.env.TRUST_PROXY = 'true';
    delete process.env.PUBLIC_URL;

    expect(
      resolvePublicOrigin(
        req({
          host: 'internal:5443',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'pulse.example.com'
        })
      )
    ).toEqual({ proto: 'https', host: 'pulse.example.com' });

    // Invalid forwarded values fall back to the request's own values.
    expect(
      resolvePublicOrigin(
        req({
          host: 'internal:5443',
          'x-forwarded-proto': 'gopher',
          'x-forwarded-host': 'bad host/with path'
        })
      )
    ).toEqual({ proto: 'http', host: 'internal:5443' });
  });

  test('PUBLIC_URL wins over everything', () => {
    process.env.TRUST_PROXY = 'true';
    process.env.PUBLIC_URL = 'https://chat.example.org/';

    expect(
      resolvePublicOrigin(
        req({
          host: 'internal:5443',
          'x-forwarded-proto': 'http',
          'x-forwarded-host': 'other.example'
        })
      )
    ).toEqual({ proto: 'https', host: 'chat.example.org' });
  });

  test('an unparsable PUBLIC_URL is ignored', () => {
    delete process.env.TRUST_PROXY;
    process.env.PUBLIC_URL = 'not a url';

    expect(resolvePublicOrigin(req({ host: 'pulse.example.com' }))).toEqual({
      proto: 'http',
      host: 'pulse.example.com'
    });
  });

  test('a missing or invalid Host falls back to localhost', () => {
    delete process.env.TRUST_PROXY;
    delete process.env.PUBLIC_URL;

    expect(resolvePublicOrigin(req({}))).toEqual({ proto: 'http', host: 'localhost' });
    expect(resolvePublicOrigin(req({ host: 'a b' }))).toEqual({
      proto: 'http',
      host: 'localhost'
    });
  });
});
