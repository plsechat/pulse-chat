/**
 * SenderKeyChain protocol tests. Run via:
 *   bun test apps/client/src/lib/e2ee/__tests__/sender-key-chain.test.ts
 *
 * No DB / network / DOM. WebCrypto is a Bun built-in, Ed25519 is
 * supported in Bun 1.1+.
 */

import { describe, expect, test } from 'bun:test';
import {
  MAX_SKIPPED_KEYS_PER_CHAIN,
  SenderKeyChain,
  decodeWire,
  encodeWire,
  generateChainSigningKeyPair,
  __testing
} from '../sender-key-chain';

const aad = (overrides: Partial<{ kind: 'channel' | 'dm'; scopeId: number; senderId: number }> = {}) => ({
  kind: 'channel' as const,
  scopeId: 42,
  senderId: 7,
  ...overrides
});

async function freshChainPair(senderKeyId = 1) {
  const sender = await SenderKeyChain.createOutbound(senderKeyId);
  const skdm = sender.buildDistribution();
  const recipient = SenderKeyChain.acceptInbound(
    skdm.senderKeyId,
    __testing.fromB64(skdm.chainKey),
    skdm.iteration,
    __testing.fromB64(skdm.signingPublicKey)
  );
  return { sender, recipient };
}

describe('SenderKeyChain', () => {
  test('round-trip a single message', async () => {
    const { sender, recipient } = await freshChainPair();
    const wire = await sender.encrypt('hello', aad());
    const pt = await recipient.decrypt(wire, aad());
    expect(pt).toBe('hello');
  });

  test('chain advances independently on each side per message', async () => {
    const { sender, recipient } = await freshChainPair();
    for (let i = 0; i < 10; i++) {
      const wire = await sender.encrypt(`m${i}`, aad());
      const pt = await recipient.decrypt(wire, aad());
      expect(pt).toBe(`m${i}`);
    }
    expect(sender.state.iteration).toBe(10);
    expect(recipient.state.iteration).toBe(10);
    expect(recipient.state.lastSeen).toBe(9);
  });

  test('out-of-order delivery: 0,2,1', async () => {
    const { sender, recipient } = await freshChainPair();
    const w0 = await sender.encrypt('m0', aad());
    const w1 = await sender.encrypt('m1', aad());
    const w2 = await sender.encrypt('m2', aad());

    expect(await recipient.decrypt(w0, aad())).toBe('m0');
    expect(await recipient.decrypt(w2, aad())).toBe('m2'); // skips iter 1
    expect(await recipient.decrypt(w1, aad())).toBe('m1'); // arrives late
  });

  test('out-of-order delivery: deeper skip 0,5,3,1,4,2', async () => {
    const { sender, recipient } = await freshChainPair();
    const wires: string[] = [];
    for (let i = 0; i < 6; i++) {
      wires.push(await sender.encrypt(`m${i}`, aad()));
    }
    const order = [0, 5, 3, 1, 4, 2];
    for (const i of order) {
      expect(await recipient.decrypt(wires[i], aad())).toBe(`m${i}`);
    }
  });

  test('replay rejection: same wire twice throws on second decrypt', async () => {
    const { sender, recipient } = await freshChainPair();
    const w0 = await sender.encrypt('replay-me', aad());
    expect(await recipient.decrypt(w0, aad())).toBe('replay-me');
    await expect(recipient.decrypt(w0, aad())).rejects.toThrow(/replay/);
  });

  test('signature verification fails when ciphertext is tampered', async () => {
    const { sender, recipient } = await freshChainPair();
    const wire = await sender.encrypt('secret', aad());
    const decoded = decodeWire(wire);
    // Flip a bit in the ciphertext.
    decoded.ciphertext[0] ^= 0x01;
    const tampered = encodeWire({
      senderKeyId: decoded.senderKeyId,
      iteration: decoded.iteration,
      iv: decoded.iv,
      ciphertext: decoded.ciphertext,
      signature: decoded.signature
    });
    await expect(recipient.decrypt(tampered, aad())).rejects.toThrow(/signature/);
  });

  test('AAD mismatch fails decrypt (different scopeId)', async () => {
    const { sender, recipient } = await freshChainPair();
    const wire = await sender.encrypt('hi', aad({ scopeId: 1 }));
    await expect(recipient.decrypt(wire, aad({ scopeId: 2 }))).rejects.toThrow();
  });

  test('AAD mismatch fails decrypt (channel vs dm kind)', async () => {
    const { sender, recipient } = await freshChainPair();
    const wire = await sender.encrypt('hi', aad({ kind: 'channel' }));
    await expect(recipient.decrypt(wire, aad({ kind: 'dm' }))).rejects.toThrow();
  });

  test('skipped-keys cache evicts oldest past MAX_SKIPPED_KEYS_PER_CHAIN', async () => {
    const { sender, recipient } = await freshChainPair();
    // Encrypt one more than the cache holds — recipient skips them
    // all by jumping ahead, then tries to consume the oldest, which
    // must have been evicted.
    const N = MAX_SKIPPED_KEYS_PER_CHAIN + 5;
    const wires: string[] = [];
    for (let i = 0; i < N; i++) {
      wires.push(await sender.encrypt(`m${i}`, aad()));
    }
    // Decrypt the LAST one first — caches keys for [0..N-2] but
    // immediately overflows the cache for indices 0..4 (the oldest).
    expect(await recipient.decrypt(wires[N - 1], aad())).toBe(`m${N - 1}`);
    // Iterations N-1 - MAX_SKIPPED_KEYS_PER_CHAIN and earlier should
    // have been evicted; we expect those late-arriving wires to fail.
    await expect(recipient.decrypt(wires[0], aad())).rejects.toThrow(/replay|expired/);
    // But keys still in the window decrypt fine.
    expect(await recipient.decrypt(wires[N - 2], aad())).toBe(`m${N - 2}`);
  });

  test('senderKeyId mismatch is rejected (defends against rotation confusion)', async () => {
    const a = await SenderKeyChain.createOutbound(1);
    const skdm = a.buildDistribution();
    const wire = await a.encrypt('rot', aad());
    const recip = SenderKeyChain.acceptInbound(
      99, // different senderKeyId — recipient set up under a different rotation
      __testing.fromB64(skdm.chainKey),
      skdm.iteration,
      __testing.fromB64(skdm.signingPublicKey)
    );
    await expect(recip.decrypt(wire, aad())).rejects.toThrow(/senderKeyId/);
  });

  test('rotation: new senderKeyId generates a fresh independent chain', async () => {
    const v1 = await SenderKeyChain.createOutbound(1);
    const v2 = await SenderKeyChain.createOutbound(2);
    expect(v1.state.senderKeyId).toBe(1);
    expect(v2.state.senderKeyId).toBe(2);
    // Different chain keys (overwhelmingly likely — both are 32
    // random bytes; collision probability is 2^-256).
    expect(__testing.toB64(v1.state.chainKey)).not.toBe(
      __testing.toB64(v2.state.chainKey)
    );
    // Different signing keys.
    expect(__testing.toB64(v1.state.signingPublicKey)).not.toBe(
      __testing.toB64(v2.state.signingPublicKey)
    );
  });

  test('encrypt fails on inbound-only chain (no private signing key)', async () => {
    const sender = await SenderKeyChain.createOutbound(1);
    const skdm = sender.buildDistribution();
    const recipient = SenderKeyChain.acceptInbound(
      skdm.senderKeyId,
      __testing.fromB64(skdm.chainKey),
      skdm.iteration,
      __testing.fromB64(skdm.signingPublicKey)
    );
    await expect(recipient.encrypt('illegal', aad())).rejects.toThrow(/inbound/);
  });

  test('generateChainSigningKeyPair returns 32-byte Ed25519 public key', async () => {
    const { publicKey } = await generateChainSigningKeyPair();
    expect(publicKey.length).toBe(32);
  });
});

describe('persistence', () => {
  test('toIdb / fromIdb round-trip preserves chain state', async () => {
    const { sender, recipient } = await freshChainPair();
    // Send a few so iteration / lastSeen / skipped state is non-trivial
    const w0 = await sender.encrypt('a', aad());
    const w1 = await sender.encrypt('b', aad());
    const w2 = await sender.encrypt('c', aad());
    await recipient.decrypt(w0, aad());
    await recipient.decrypt(w2, aad()); // skip iter 1 — caches its key

    const senderRestored = SenderKeyChain.fromIdb(sender.toIdb());
    const recipRestored = SenderKeyChain.fromIdb(recipient.toIdb());

    // Sender continues encrypting at the right iteration after restore
    const w3 = await senderRestored.encrypt('d', aad());
    expect(await recipRestored.decrypt(w3, aad())).toBe('d');
    // Late iter 1 still decryptable through the restored skip cache
    expect(await recipRestored.decrypt(w1, aad())).toBe('b');
  });
});

describe('wire format', () => {
  test('encode then decode round-trip preserves all fields', () => {
    const iv = new Uint8Array(12).fill(0x42);
    const ct = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const sig = new Uint8Array(64).fill(0xaa);
    const b64 = encodeWire({
      senderKeyId: 0xdeadbeef,
      iteration: 0x12345678,
      iv,
      ciphertext: ct,
      signature: sig
    });
    const decoded = decodeWire(b64);
    expect(decoded.version).toBe(__testing.WIRE_VERSION);
    expect(decoded.senderKeyId).toBe(0xdeadbeef);
    expect(decoded.iteration).toBe(0x12345678);
    expect(Array.from(decoded.iv)).toEqual(Array.from(iv));
    expect(Array.from(decoded.ciphertext)).toEqual(Array.from(ct));
    expect(Array.from(decoded.signature)).toEqual(Array.from(sig));
  });

  test('decode rejects truncated payload', () => {
    expect(() => decodeWire(__testing.toB64(new Uint8Array(5)))).toThrow();
  });

  test('decode rejects unknown version byte', () => {
    const buf = new Uint8Array(__testing.WIRE_HEADER_LENGTH + __testing.SIGNATURE_LENGTH + 8);
    buf[0] = 0xff; // not WIRE_VERSION
    expect(() => decodeWire(__testing.toB64(buf))).toThrow(/version/);
  });
});
