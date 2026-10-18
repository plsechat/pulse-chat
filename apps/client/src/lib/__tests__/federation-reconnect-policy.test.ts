import { describe, expect, test } from 'bun:test';
import { DisconnectCode } from '@pulse/shared';
import {
  classifyFederatedClose,
  shouldRefreshFederationToken,
  TOKEN_REFRESH_WINDOW_MS
} from '../federation-reconnect-policy';

describe('classifyFederatedClose', () => {
  test('an expired federation token asks for a re-mint, not a stop', () => {
    expect(classifyFederatedClose(DisconnectCode.FEDERATION_TOKEN_EXPIRED)).toBe(
      'refresh-token'
    );
  });

  test('peer-level rejections are permanent', () => {
    for (const code of [
      DisconnectCode.FEDERATION_REJECTED,
      DisconnectCode.BANNED,
      DisconnectCode.ACCOUNT_DELETED,
      DisconnectCode.SESSION_REVOKED
    ]) {
      expect(classifyFederatedClose(code)).toBe('permanent');
    }
  });

  test('everything else is left to the transport retry', () => {
    expect(classifyFederatedClose(undefined)).toBe('retry');
    expect(classifyFederatedClose(DisconnectCode.UNEXPECTED)).toBe('retry');
    expect(classifyFederatedClose(DisconnectCode.SERVER_SHUTDOWN)).toBe('retry');
    expect(classifyFederatedClose(DisconnectCode.KICKED)).toBe('retry');
    expect(classifyFederatedClose(1000)).toBe('retry');
  });
});

describe('shouldRefreshFederationToken', () => {
  const now = 1_700_000_000_000;

  test('refreshes inside the window and once expired', () => {
    expect(shouldRefreshFederationToken(now + TOKEN_REFRESH_WINDOW_MS - 1, now)).toBe(true);
    expect(shouldRefreshFederationToken(now + 1000, now)).toBe(true);
    expect(shouldRefreshFederationToken(now - 60_000, now)).toBe(true);
  });

  test('leaves a token with more than the window left alone', () => {
    expect(shouldRefreshFederationToken(now + TOKEN_REFRESH_WINDOW_MS, now)).toBe(false);
    expect(shouldRefreshFederationToken(now + 23 * 60 * 60 * 1000, now)).toBe(false);
  });

  test('an unknown expiry is never reported as expiring', () => {
    expect(shouldRefreshFederationToken(undefined, now)).toBe(false);
    expect(shouldRefreshFederationToken(Number.NaN, now)).toBe(false);
  });
});
