/**
 * Backup payload versioning for the e2ee key export/import.
 *
 * v5 dropped the Phase A `senderKeys` / `distributedMembers` stores
 * from the payload. These tests pin that:
 *   - a fresh export is v5 and carries no Phase A stores;
 *   - a v4 payload (which still carries them) imports cleanly and its
 *     Phase A rows are ignored rather than written back;
 *   - version-specific required-store validation is intact.
 *
 * Run via: bun test apps/client/src/lib/e2ee/__tests__/key-backup.test.ts
 */

import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { openDB } from 'idb';
import {
  decryptBackupPayload,
  deriveBackupKey,
  encryptBackupData,
  importKeys,
  type BackupPayload
} from '../key-backup';
import { arrayBufferToBase64 } from '../utils';

const PASSPHRASE = 'correct horse battery staple';

type Entry = { key: string; value: unknown };

const V4_STORES = [
  'identityKey',
  'registrationId',
  'preKeys',
  'signedPreKeys',
  'sessions',
  'identities',
  'senderKeys',
  'distributedMembers',
  'meta',
  'verifiedIdentities'
] as const;

/** Build a payload at an explicit version, bypassing encryptBackupData's pin. */
async function encryptAt(
  version: BackupPayload['version'],
  data: Record<string, Entry[]>
): Promise<BackupPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(PASSPHRASE, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(data))
  );
  return {
    version,
    salt: arrayBufferToBase64(salt.buffer),
    iv: arrayBufferToBase64(iv.buffer),
    ciphertext: arrayBufferToBase64(ciphertext)
  };
}

function v4Data(): Record<string, Entry[]> {
  const data: Record<string, Entry[]> = {};
  for (const name of V4_STORES) data[name] = [];
  data.identityKey = [{ key: 'identityKey', value: { pubKey: 'pk', privKey: 'sk' } }];
  data.registrationId = [{ key: 'registrationId', value: 4242 }];
  data.senderKeys = [{ key: '7:3', value: 'phase-a-sender-key' }];
  data.distributedMembers = [{ key: '7', value: [3, 4] }];
  return data;
}

function payloadFile(payload: BackupPayload): File {
  return new File([JSON.stringify(payload)], 'backup.json', {
    type: 'application/json'
  });
}

describe('key-backup payload versions', () => {
  test('a fresh export is v5 and carries no Phase A stores', async () => {
    const payload = await encryptBackupData(
      { identityKey: [], registrationId: [], preKeys: [], signedPreKeys: [],
        sessions: [], identities: [], meta: [], verifiedIdentities: [] },
      PASSPHRASE
    );
    expect(payload.version).toBe(5);

    const data = await decryptBackupPayload(payload, PASSPHRASE);
    expect(Object.keys(data)).not.toContain('senderKeys');
    expect(Object.keys(data)).not.toContain('distributedMembers');
  });

  test('v5 validation does not require the dropped stores', async () => {
    const payload = await encryptAt(5, {
      identityKey: [], registrationId: [], preKeys: [], signedPreKeys: [],
      sessions: [], identities: [], meta: [], verifiedIdentities: []
    });
    await expect(decryptBackupPayload(payload, PASSPHRASE)).resolves.toBeDefined();
  });

  test('v4 validation still requires senderKeys/distributedMembers', async () => {
    const data = v4Data();
    delete data.senderKeys;
    const payload = await encryptAt(4, data);
    await expect(decryptBackupPayload(payload, PASSPHRASE)).rejects.toThrow(
      'Backup is missing store: senderKeys'
    );
  });

  test('unknown versions are rejected', async () => {
    const payload = await encryptAt(5, v4Data());
    const future = { ...payload, version: 6 as unknown as BackupPayload['version'] };
    await expect(decryptBackupPayload(future, PASSPHRASE)).rejects.toThrow(
      'Unsupported backup version: 6'
    );
  });

  test('a v4 backup imports: live stores restored, Phase A rows ignored', async () => {
    const domain = `v4-import-${Date.now()}`;
    const dbName = `pulse-e2ee-${domain}`;
    const payload = await encryptAt(4, v4Data());

    await importKeys(payloadFile(payload), PASSPHRASE, domain);

    const db = await openDB(dbName);
    try {
      expect(await db.get('registrationId', 'registrationId')).toBe(4242);
      expect(await db.get('identityKey', 'identityKey')).toEqual({
        pubKey: 'pk',
        privKey: 'sk'
      });
      // Dropped from the payload in v5: never written back on import.
      expect(await db.count('senderKeys')).toBe(0);
      expect(await db.count('distributedMembers')).toBe(0);
    } finally {
      db.close();
    }
  });
});
