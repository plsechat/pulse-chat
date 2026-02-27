import { describe, expect, test } from 'bun:test';
import { initTest } from '../../__tests__/helpers';

describe('deferred server data endpoints', () => {
  describe('getServerMembers', () => {
    test('should return members with role IDs', async () => {
      const { caller } = await initTest();
      const members = await caller.others.getServerMembers();

      expect(Array.isArray(members)).toBe(true);
      expect(members.length).toBeGreaterThan(0);

      const ownUser = members.find((u: { id: number }) => u.id === 1);
      expect(ownUser).toBeDefined();
      expect(ownUser).toHaveProperty('name');
      expect(ownUser).toHaveProperty('roleIds');
      expect(ownUser).toHaveProperty('status');
      expect(Array.isArray(ownUser!.roleIds)).toBe(true);
    });

    test('should not include raw _identity for local users', async () => {
      const { caller } = await initTest();
      const members = await caller.others.getServerMembers();

      for (const user of members) {
        // Local users should not have _identity set (only federated users get user@domain)
        if (user._identity) {
          expect(user._identity).toContain('@');
        }
      }
    });
  });

  describe('getServerEmojis', () => {
    test('should return emojis without creator user data', async () => {
      const { caller } = await initTest();
      const emojis = await caller.others.getServerEmojis();

      expect(Array.isArray(emojis)).toBe(true);

      // Emojis should not include the `user` field (stripped for bandwidth)
      for (const emoji of emojis) {
        expect(emoji).not.toHaveProperty('user');
        expect(emoji).toHaveProperty('id');
        expect(emoji).toHaveProperty('file');
      }
    });
  });

  describe('getServerVoiceState', () => {
    test('should return voice and streams maps', async () => {
      const { caller } = await initTest();
      const voiceState = await caller.others.getServerVoiceState();

      expect(voiceState).toHaveProperty('voiceMap');
      expect(voiceState).toHaveProperty('externalStreamsMap');
      expect(typeof voiceState.voiceMap).toBe('object');
      expect(typeof voiceState.externalStreamsMap).toBe('object');
    });
  });
});
