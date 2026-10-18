import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as serverQueries from '../../db/queries/server';
import {
  FILE_TOKEN_BUCKET_MS,
  FILE_TOKEN_MAX_TTL_MS,
  generateFileToken,
  verifyFileToken
} from '../files-crypto';

// The HMAC secret comes from the real `getFileHmacSecretSync`: setup.ts
// warms it from the seeded server row before every test. The two tests
// that care about the lookup itself spy on the export (restorable) —
// never `mock.module`, which is process-global and irreversible.

afterEach(() => {
  mock.restore();
});

describe('files-crypto', () => {
  describe('generateFileToken', () => {
    test('should generate a valid token for given fileId and channelAccessToken', () => {
      const fileId = 123;
      const channelAccessToken = 'channel-token-abc';

      const token = generateFileToken(fileId, channelAccessToken);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      // `<exp unix seconds>.<hex sha256 hmac>`
      expect(token).toMatch(/^\d{10}\.[0-9a-f]{64}$/);
    });

    test('should generate different tokens for different fileIds', () => {
      const channelAccessToken = 'channel-token-abc';

      const token1 = generateFileToken(1, channelAccessToken);
      const token2 = generateFileToken(2, channelAccessToken);

      expect(token1).not.toBe(token2);
    });

    test('should generate different tokens for different channelAccessTokens', () => {
      const fileId = 123;

      const token1 = generateFileToken(fileId, 'channel-token-1');
      const token2 = generateFileToken(fileId, 'channel-token-2');

      expect(token1).not.toBe(token2);
    });

    test('should generate consistent tokens for same inputs', () => {
      const fileId = 123;
      const channelAccessToken = 'channel-token-abc';

      const token1 = generateFileToken(fileId, channelAccessToken);
      const token2 = generateFileToken(fileId, channelAccessToken);

      expect(token1).toBe(token2);
    });

    test('should use server token from getFileHmacSecretSync', () => {
      const fileId = 123;
      const channelAccessToken = 'channel-token-abc';
      const secretSpy = spyOn(serverQueries, 'getFileHmacSecretSync');

      const token = generateFileToken(fileId, channelAccessToken);

      expect(secretSpy).toHaveBeenCalledTimes(1);
      expect(verifyFileToken(fileId, channelAccessToken, token)).toBe(true);
    });

    test('tokens are bound to the server secret', () => {
      const fileId = 123;
      const channelAccessToken = 'channel-token-abc';
      const realToken = generateFileToken(fileId, channelAccessToken);

      spyOn(serverQueries, 'getFileHmacSecretSync').mockReturnValue(
        'a-different-server-secret'
      );
      const otherSecretToken = generateFileToken(fileId, channelAccessToken);

      expect(otherSecretToken).not.toBe(realToken);
      expect(verifyFileToken(fileId, channelAccessToken, realToken)).toBe(false);
    });
  });

  describe('verifyFileToken', () => {
    test('should return true for valid token', () => {
      const fileId = 123;
      const channelAccessToken = 'channel-token-abc';

      const token = generateFileToken(fileId, channelAccessToken);
      const isValid = verifyFileToken(fileId, channelAccessToken, token);

      expect(isValid).toBe(true);
    });

    test('should return false for invalid token', () => {
      const fileId = 123;
      const channelAccessToken = 'channel-token-abc';

      const isValid = verifyFileToken(
        fileId,
        channelAccessToken,
        'invalid-token-xyz'
      );

      expect(isValid).toBe(false);
    });

    test('should return false for token with different fileId', () => {
      const channelAccessToken = 'channel-token-abc';

      const token = generateFileToken(123, channelAccessToken);
      const isValid = verifyFileToken(456, channelAccessToken, token);

      expect(isValid).toBe(false);
    });

    test('should return false for token with different channelAccessToken', () => {
      const fileId = 123;

      const token = generateFileToken(fileId, 'channel-token-1');
      const isValid = verifyFileToken(fileId, 'channel-token-2', token);

      expect(isValid).toBe(false);
    });

    test('should return false for token with different length', () => {
      const fileId = 123;
      const channelAccessToken = 'channel-token-abc';

      const isValid = verifyFileToken(fileId, channelAccessToken, 'short');

      expect(isValid).toBe(false);
    });

    test('should return false for empty token', () => {
      const fileId = 123;
      const channelAccessToken = 'channel-token-abc';

      const isValid = verifyFileToken(fileId, channelAccessToken, '');

      expect(isValid).toBe(false);
    });

    test('should use timing-safe comparison to prevent timing attacks', () => {
      const fileId = 123;
      const channelAccessToken = 'channel-token-abc';

      const token = generateFileToken(fileId, channelAccessToken);
      const almostValidToken = token.slice(0, -1) + 'x';

      const isValid = verifyFileToken(
        fileId,
        channelAccessToken,
        almostValidToken
      );

      expect(isValid).toBe(false);
    });

    test('should handle numeric fileIds correctly', () => {
      const channelAccessToken = 'channel-token-abc';

      const token1 = generateFileToken(1, channelAccessToken);
      const token2 = generateFileToken(10, channelAccessToken);
      const token3 = generateFileToken(100, channelAccessToken);

      expect(verifyFileToken(1, channelAccessToken, token1)).toBe(true);
      expect(verifyFileToken(10, channelAccessToken, token2)).toBe(true);
      expect(verifyFileToken(100, channelAccessToken, token3)).toBe(true);

      expect(verifyFileToken(1, channelAccessToken, token2)).toBe(false);
      expect(verifyFileToken(10, channelAccessToken, token3)).toBe(false);
    });

    test('should handle special characters in channelAccessToken', () => {
      const fileId = 123;
      const specialTokens = [
        'token-with-dashes',
        'token_with_underscores',
        'token.with.dots',
        'token/with/slashes',
        'token:with:colons'
      ];

      for (const channelAccessToken of specialTokens) {
        const token = generateFileToken(fileId, channelAccessToken);
        const isValid = verifyFileToken(fileId, channelAccessToken, token);

        expect(isValid).toBe(true);
      }
    });
  });

  describe('expiry', () => {
    const fileId = 123;
    const salt = 'channel-token-abc';
    // A fixed instant 1 ms into a bucket, so the bucket arithmetic is
    // exercised at both ends below.
    const bucketStart =
      Math.floor(1_800_000_000_000 / FILE_TOKEN_BUCKET_MS) *
      FILE_TOKEN_BUCKET_MS;

    const expOf = (token: string) => Number(token.split('.')[0]) * 1000;

    test('tokens minted anywhere inside one bucket are byte-identical', () => {
      const early = generateFileToken(fileId, salt, bucketStart + 1);
      const late = generateFileToken(
        fileId,
        salt,
        bucketStart + FILE_TOKEN_BUCKET_MS - 1
      );
      const nextBucket = generateFileToken(
        fileId,
        salt,
        bucketStart + FILE_TOKEN_BUCKET_MS
      );

      expect(late).toBe(early);
      expect(nextBucket).not.toBe(early);
    });

    test('every token is valid for at least one bucket and at most two', () => {
      const first = generateFileToken(fileId, salt, bucketStart);
      const last = generateFileToken(
        fileId,
        salt,
        bucketStart + FILE_TOKEN_BUCKET_MS - 1
      );

      expect(expOf(first) - bucketStart).toBe(FILE_TOKEN_MAX_TTL_MS);
      expect(expOf(last) - (bucketStart + FILE_TOKEN_BUCKET_MS - 1)).toBe(
        FILE_TOKEN_BUCKET_MS + 1
      );
    });

    test('a token stops verifying exactly at its exp', () => {
      const token = generateFileToken(fileId, salt, bucketStart + 1);
      const exp = expOf(token);

      expect(verifyFileToken(fileId, salt, token, bucketStart + 1)).toBe(true);
      expect(verifyFileToken(fileId, salt, token, exp - 1)).toBe(true);
      expect(verifyFileToken(fileId, salt, token, exp)).toBe(false);
      expect(verifyFileToken(fileId, salt, token, exp + 1)).toBe(false);
    });

    test('a token minted long ago is rejected now', () => {
      const stale = generateFileToken(
        fileId,
        salt,
        Date.now() - FILE_TOKEN_MAX_TTL_MS - 1
      );

      expect(verifyFileToken(fileId, salt, stale)).toBe(false);
    });

    test('a forged exp fails the signature even when it is in range', () => {
      const token = generateFileToken(fileId, salt, bucketStart + 1);
      const [exp, signature] = token.split('.');
      const forged = `${Number(exp) + 60}.${signature}`;

      expect(verifyFileToken(fileId, salt, forged, bucketStart + 1)).toBe(
        false
      );
    });

    test('a correctly signed far-future exp is still outside the bound', () => {
      // Signed with the real secret, as a leaked-secret attacker would,
      // but for a window ten days out: the 24 h ceiling rejects it.
      const farFuture = generateFileToken(
        fileId,
        salt,
        bucketStart + 10 * 24 * 60 * 60 * 1000
      );

      expect(verifyFileToken(fileId, salt, farFuture, bucketStart)).toBe(
        false
      );
      // ...and verifies once its own window arrives.
      expect(
        verifyFileToken(
          fileId,
          salt,
          farFuture,
          expOf(farFuture) - FILE_TOKEN_BUCKET_MS
        )
      ).toBe(true);
    });

    test('malformed exp parts are rejected before any HMAC work', () => {
      const token = generateFileToken(fileId, salt, bucketStart + 1);
      const signature = token.split('.')[1]!;

      for (const bad of [
        signature,
        `.${signature}`,
        `abc.${signature}`,
        `1e10.${signature}`,
        `-1.${signature}`,
        `12.5.${signature}`,
        `1234567890123.${signature}`,
        `${'9'.repeat(200)}.${signature}`
      ]) {
        expect(verifyFileToken(fileId, salt, bad, bucketStart + 1)).toBe(false);
      }
    });

    test('the wrong salt never verifies, expired or not', () => {
      const token = generateFileToken(fileId, salt, bucketStart + 1);

      expect(verifyFileToken(fileId, 'other-salt', token, bucketStart + 1)).toBe(
        false
      );
    });
  });

  describe('integration', () => {
    test('should generate and verify tokens for multiple files', () => {
      const channelAccessToken = 'channel-token-abc';
      const fileIds = [1, 2, 3, 4, 5];

      const tokens = fileIds.map((id) =>
        generateFileToken(id, channelAccessToken)
      );

      const uniqueTokens = new Set(tokens);

      expect(uniqueTokens.size).toBe(fileIds.length);

      for (let i = 0; i < fileIds.length; i++) {
        const isValid = verifyFileToken(
          fileIds[i]!,
          channelAccessToken,
          tokens[i]!
        );
        expect(isValid).toBe(true);
      }

      expect(verifyFileToken(fileIds[0]!, channelAccessToken, tokens[1]!)).toBe(
        false
      );
    });
  });
});
