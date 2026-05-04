import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { generateFileToken, verifyFileToken } from '../files-crypto';

const mockGetFileHmacSecretSync = mock(() => 'test-server-token-12345');

mock.module('../../db/queries/server', () => ({
  getFileHmacSecretSync: mockGetFileHmacSecretSync
}));

describe('files-crypto', () => {
  beforeEach(() => {
    mockGetFileHmacSecretSync.mockClear();
  });

  describe('generateFileToken', () => {
    test('should generate a valid token for given fileId and channelAccessToken', () => {
      const fileId = 123;
      const channelAccessToken = 'channel-token-abc';

      const token = generateFileToken(fileId, channelAccessToken);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.length).toBe(64);
      expect(mockGetFileHmacSecretSync).toHaveBeenCalledTimes(1);
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

      generateFileToken(fileId, channelAccessToken);

      expect(mockGetFileHmacSecretSync).toHaveBeenCalledTimes(1);
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
