/**
 * Phase B SenderKeyChain — the protocol-correct replacement for the
 * static-AES sender keys we shipped in Phase A.
 *
 * Each chain models one (channel, sender, senderKeyId) ratchet:
 *  - 32-byte chain key, advances forward via HMAC-SHA256 (HKDF-Extract
 *    style with single-byte info constants) on every message.
 *  - Per-message AES-256-GCM key derived from the chain key — never
 *    reused, can't be reversed back to chainKey or to prior keys.
 *  - 32-bit monotonic iteration counter in the wire envelope.
 *  - Ed25519 signing key generated per chain (only the sender holds
 *    the private half); each ciphertext is signed so peers can detect
 *    impersonation between members of the same channel.
 *  - Bounded LRU of skipped message keys for out-of-order delivery,
 *    sized to MAX_SKIPPED_KEYS_PER_CHAIN. Past that horizon, late
 *    messages are dropped (replay-or-too-late).
 *
 * What this module does NOT do:
 *  - Talk to the network. Distribution of fresh chains (SKDMs) and
 *    storage of chain state in IDB live in the consumer modules
 *    (`sender-keys.ts` for channels, `dm-sender-keys.ts` for DM
 *    groups), wired in B2 / B3.
 *  - Handle migration from Phase A wire format. The agreed-on path is
 *    a clean break — old ciphertexts become unreadable. v2 wire format
 *    has a leading version byte (`WIRE_VERSION = 2`) so a future v3 can
 *    coexist without revisiting this file.
 *
 * Wire format (v2):
 *   version(1) | senderKeyId(4 BE) | iteration(4 BE) | iv(12) |
 *     ciphertext+tag(N) | signature(64)
 *
 * AAD bound to every encrypt:
 *   `chain:${kind}:${scopeId}:${senderId}:${senderKeyId}:${iteration}`
 *
 * Tests live in `__tests__/sender-key-chain.test.ts` and run via
 * `bun test apps/client/src/lib/e2ee/__tests__/`.
 */

const CHAIN_KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SIGNATURE_LENGTH = 64; // Ed25519
const WIRE_VERSION = 0x02;
const WIRE_HEADER_LENGTH = 1 + 4 + 4 + IV_LENGTH; // version + senderKeyId + iter + iv

/**
 * Out-of-order tolerance. Sized for "user is in many channels with
 * many senders" — at 256 keys × 32 bytes ≈ 8 KB per chain, a busy
 * user with 100 channels × 100 senders sits around 80 MB of cache.
 * Larger windows tolerate more reordering at the cost of memory.
 */
export const MAX_SKIPPED_KEYS_PER_CHAIN = 256;

/**
 * Hard cap on how far ahead a single decrypt can ratchet. Stops a
 * malicious sender claiming `iteration = 2^31` and DoSing the
 * recipient's HMAC loop. 4096 ≫ any plausible legitimate skip from
 * normal network reordering.
 */
export const MAX_FORWARD_RATCHET = 4096;

const HMAC_INFO_MESSAGE = new Uint8Array([0x01]);
const HMAC_INFO_CHAIN = new Uint8Array([0x02]);

/** Identifies which family of chain we're encrypting under — channel
 *  sender keys vs DM-group sender keys. Goes into the AAD so a server
 *  can't lift a ciphertext from a DM into a channel. */
export type ChainKind = 'channel' | 'dm';

export type AadContext = {
  kind: ChainKind;
  scopeId: number; // channelId or dmChannelId
  senderId: number;
  senderKeyId: number;
};

export type SenderKeyChainState = {
  /** Sender-assigned id; bumps on every rotation (kick/leave). */
  senderKeyId: number;
  /** Current 32-byte chain key. Advances after every encrypt. */
  chainKey: Uint8Array;
  /** Iteration counter for the next outbound message. Monotonic. */
  iteration: number;
  /** Highest iteration successfully decrypted (own outbound chains
   *  always have lastSeen = iteration - 1; receiving chains track
   *  the head of the inbound stream). */
  lastSeen: number;
  /** Out-of-order message keys, keyed by their iteration index. LRU
   *  eviction policy implemented in `cacheSet`. */
  skippedKeys: Map<number, Uint8Array>;
  /** Public Ed25519 key for verify (always present). */
  signingPublicKey: Uint8Array;
  /** Private Ed25519 key for sign (only present on own chains, never
   *  serialized to the wire — only to local IDB). */
  signingPrivateKey?: CryptoKey;
};

/**
 * Bytes carried inside a Sender Key Distribution Message — the
 * payload the sender encrypts to each peer over the existing pairwise
 * X3DH session, telling them how to read this chain.
 */
export type SenderKeyDistribution = {
  senderKeyId: number;
  iteration: number;
  chainKey: string; // base64
  signingPublicKey: string; // base64
};

// --- Encoding helpers ---

const toB64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

const fromB64 = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

const writeU32BE = (buf: Uint8Array, offset: number, value: number): void => {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
};

const readU32BE = (buf: Uint8Array, offset: number): number => {
  return (
    (buf[offset] << 24) |
    (buf[offset + 1] << 16) |
    (buf[offset + 2] << 8) |
    buf[offset + 3]
  ) >>> 0;
};

// --- Crypto primitives ---

/** Single-block HMAC-SHA256. Used as the KDF for chain advance. */
async function hmacSha256(
  key: Uint8Array,
  data: Uint8Array
): Promise<Uint8Array> {
  // Note: `key.slice()` defends against the input array being a view
  // into a longer ArrayBuffer (importKey reads the underlying buffer
  // ranges, not the typed-array view bounds, on some implementations).
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key.slice().buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, data.slice().buffer);
  return new Uint8Array(sig);
}

/**
 * Advance the chain by one step. Returns the message key for the
 * CURRENT iteration and the chain key to use for the NEXT iteration.
 * Symmetric — both encrypt and decrypt run this with the same input
 * to land on the same per-iteration message key.
 */
async function advanceChain(chainKey: Uint8Array): Promise<{
  messageKey: Uint8Array;
  nextChainKey: Uint8Array;
}> {
  const [messageKey, nextChainKey] = await Promise.all([
    hmacSha256(chainKey, HMAC_INFO_MESSAGE),
    hmacSha256(chainKey, HMAC_INFO_CHAIN)
  ]);
  return { messageKey, nextChainKey };
}

function buildAad(ctx: AadContext, iteration: number): Uint8Array {
  // Plain text AAD — readable in logs without revealing content. AES-
  // GCM treats it as opaque bytes either way.
  const str = `chain:${ctx.kind}:${ctx.scopeId}:${ctx.senderId}:${ctx.senderKeyId}:${iteration}`;
  return new TextEncoder().encode(str);
}

async function aesGcmEncrypt(
  messageKey: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    messageKey.slice().buffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.slice().buffer, additionalData: aad.slice().buffer },
    key,
    plaintext.slice().buffer
  );
  return new Uint8Array(ct);
}

async function aesGcmDecrypt(
  messageKey: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    messageKey.slice().buffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.slice().buffer, additionalData: aad.slice().buffer },
    key,
    ciphertext.slice().buffer
  );
  return new Uint8Array(pt);
}

// --- Signing (Ed25519 via WebCrypto) ---

/**
 * Generate a new Ed25519 keypair for a fresh chain. The private key
 * is non-extractable so it can never leave WebCrypto — even own-chain
 * persistence to IDB stores the CryptoKey directly via structured
 * clone, never a raw byte form. Public key is exported to base64 for
 * SKDM transport.
 */
export async function generateChainSigningKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKey: Uint8Array;
}> {
  const kp = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    false, // private extractable=false
    ['sign', 'verify']
  ) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey('raw', kp.publicKey);
  return {
    privateKey: kp.privateKey,
    publicKey: new Uint8Array(pub)
  };
}

async function importEd25519PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    raw.slice().buffer,
    { name: 'Ed25519' },
    true,
    ['verify']
  );
}

async function signEd25519(
  privateKey: CryptoKey,
  data: Uint8Array
): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign('Ed25519', privateKey, data.slice().buffer);
  return new Uint8Array(sig);
}

async function verifyEd25519(
  publicKeyRaw: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  const key = await importEd25519PublicKey(publicKeyRaw);
  return crypto.subtle.verify(
    'Ed25519',
    key,
    signature.slice().buffer,
    data.slice().buffer
  );
}

// --- Wire format ---

/**
 * Encoded message bytes ready for `JSON.stringify`-ed base64 transport
 * over the existing message-content channel. Format:
 *
 *   version(1) | senderKeyId(4 BE) | iteration(4 BE) | iv(12) |
 *     ciphertext+tag(N) | signature(64)
 *
 * Total overhead: 1 + 4 + 4 + 12 + 16 (gcm tag) + 64 = 101 bytes per
 * message.
 */
export function encodeWire(parts: {
  senderKeyId: number;
  iteration: number;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  signature: Uint8Array;
}): string {
  if (parts.iv.length !== IV_LENGTH) {
    throw new Error(`expected IV length ${IV_LENGTH}, got ${parts.iv.length}`);
  }
  if (parts.signature.length !== SIGNATURE_LENGTH) {
    throw new Error(
      `expected signature length ${SIGNATURE_LENGTH}, got ${parts.signature.length}`
    );
  }
  const header = new Uint8Array(WIRE_HEADER_LENGTH);
  header[0] = WIRE_VERSION;
  writeU32BE(header, 1, parts.senderKeyId);
  writeU32BE(header, 5, parts.iteration);
  header.set(parts.iv, 9);
  return toB64(concat(header, parts.ciphertext, parts.signature));
}

export type DecodedWire = {
  version: number;
  senderKeyId: number;
  iteration: number;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  signature: Uint8Array;
};

export function decodeWire(b64: string): DecodedWire {
  const buf = fromB64(b64);
  if (buf.length < WIRE_HEADER_LENGTH + SIGNATURE_LENGTH) {
    throw new Error('wire payload too short');
  }
  const version = buf[0];
  if (version !== WIRE_VERSION) {
    throw new Error(`unsupported wire version ${version}`);
  }
  const senderKeyId = readU32BE(buf, 1);
  const iteration = readU32BE(buf, 5);
  const iv = buf.slice(9, 9 + IV_LENGTH);
  const sigStart = buf.length - SIGNATURE_LENGTH;
  const ciphertext = buf.slice(WIRE_HEADER_LENGTH, sigStart);
  const signature = buf.slice(sigStart);
  return { version, senderKeyId, iteration, iv, ciphertext, signature };
}

// --- Skipped-keys cache (LRU) ---

function cacheSet(
  cache: Map<number, Uint8Array>,
  iteration: number,
  key: Uint8Array
): void {
  // Map preserves insertion order; deleting + re-setting is the
  // canonical "move-to-most-recent" trick for an LRU on top of Map.
  if (cache.has(iteration)) cache.delete(iteration);
  cache.set(iteration, key);
  while (cache.size > MAX_SKIPPED_KEYS_PER_CHAIN) {
    // Drop the oldest entry. .keys().next() returns the first
    // insertion-order key.
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function cacheTake(
  cache: Map<number, Uint8Array>,
  iteration: number
): Uint8Array | undefined {
  const v = cache.get(iteration);
  if (v !== undefined) cache.delete(iteration);
  return v;
}

// --- SenderKeyChain ---

/**
 * Holds the in-memory state for a single (kind, scopeId, senderId,
 * senderKeyId) chain. Constructed two ways:
 *  - `createOutbound(...)`: I'm the sender. Generates a fresh chain
 *    key, signing keypair, iteration = 0.
 *  - `acceptInbound(...)`: peer sent me an SKDM. Uses the embedded
 *    chain key + signing public key to set up a verification-only
 *    chain.
 *
 * The class is intentionally network-unaware — encrypt/decrypt return
 * wire-format strings, and the caller is responsible for moving them
 * across the actual transport.
 */
export class SenderKeyChain {
  private constructor(public state: SenderKeyChainState) {}

  /** Serialize for IDB structured-clone storage. */
  toIdb(): SerializedChain {
    return {
      senderKeyId: this.state.senderKeyId,
      chainKey: this.state.chainKey,
      iteration: this.state.iteration,
      lastSeen: this.state.lastSeen,
      skippedKeys: this.state.skippedKeys,
      signingPublicKey: this.state.signingPublicKey,
      signingPrivateKey: this.state.signingPrivateKey
    };
  }

  /** Rebuild a chain from its IDB form. Each call gets its own
   *  instance — instances are never shared between concurrent
   *  encrypts/decrypts on the same chain. */
  static fromIdb(data: SerializedChain): SenderKeyChain {
    const skippedCopy = new Map<number, Uint8Array>();
    for (const [k, v] of data.skippedKeys) skippedCopy.set(k, v.slice());
    return new SenderKeyChain({
      senderKeyId: data.senderKeyId,
      chainKey: data.chainKey.slice(),
      iteration: data.iteration,
      lastSeen: data.lastSeen,
      skippedKeys: skippedCopy,
      signingPublicKey: data.signingPublicKey.slice(),
      signingPrivateKey: data.signingPrivateKey
    });
  }

  static async createOutbound(senderKeyId: number): Promise<SenderKeyChain> {
    const chainKey = crypto.getRandomValues(new Uint8Array(CHAIN_KEY_LENGTH));
    const { privateKey, publicKey } = await generateChainSigningKeyPair();
    return new SenderKeyChain({
      senderKeyId,
      chainKey,
      iteration: 0,
      lastSeen: -1,
      skippedKeys: new Map(),
      signingPublicKey: publicKey,
      signingPrivateKey: privateKey
    });
  }

  static acceptInbound(
    senderKeyId: number,
    initialChainKey: Uint8Array,
    initialIteration: number,
    signingPublicKey: Uint8Array
  ): SenderKeyChain {
    if (initialChainKey.length !== CHAIN_KEY_LENGTH) {
      throw new Error('invalid chain key length');
    }
    return new SenderKeyChain({
      senderKeyId,
      chainKey: initialChainKey.slice(),
      iteration: initialIteration,
      lastSeen: initialIteration - 1,
      skippedKeys: new Map(),
      signingPublicKey: signingPublicKey.slice()
    });
  }

  /** Build the SKDM bytes a sender ships to each peer (over X3DH). */
  buildDistribution(): SenderKeyDistribution {
    return {
      senderKeyId: this.state.senderKeyId,
      iteration: this.state.iteration,
      chainKey: toB64(this.state.chainKey),
      signingPublicKey: toB64(this.state.signingPublicKey)
    };
  }

  /** Encrypt + sign + advance. Caller must hold this chain's
   *  private signing key (i.e. it was created via createOutbound). */
  async encrypt(
    plaintext: string,
    aad: Omit<AadContext, 'senderKeyId'>
  ): Promise<string> {
    if (!this.state.signingPrivateKey) {
      throw new Error('encrypt called on inbound-only chain');
    }
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const ptBytes = new TextEncoder().encode(plaintext);
    const fullAad = buildAad(
      { ...aad, senderKeyId: this.state.senderKeyId },
      this.state.iteration
    );

    const { messageKey, nextChainKey } = await advanceChain(this.state.chainKey);
    const ciphertext = await aesGcmEncrypt(messageKey, iv, ptBytes, fullAad);

    // Sign the wire-canonical bytes (everything that decode would see
    // as immutable inputs). Any tampering — version flip, senderKeyId
    // change, ciphertext substitution — fails verify.
    const signed = concat(
      new Uint8Array([WIRE_VERSION]),
      u32ToBytes(this.state.senderKeyId),
      u32ToBytes(this.state.iteration),
      iv,
      ciphertext
    );
    const signature = await signEd25519(this.state.signingPrivateKey, signed);

    const wire = encodeWire({
      senderKeyId: this.state.senderKeyId,
      iteration: this.state.iteration,
      iv,
      ciphertext,
      signature
    });

    // Advance state ONLY after the encrypt+sign succeeded — partial
    // failures keep the chain on the original iteration so callers
    // can retry without skipping a counter slot.
    this.state.chainKey = nextChainKey;
    this.state.iteration += 1;
    this.state.lastSeen = this.state.iteration - 1;
    return wire;
  }

  /**
   * Verify + decrypt a wire payload. Handles three cases:
   *  - In-order (iteration === lastSeen + 1): ratchet once, decrypt.
   *  - Skipped-then-arrived (iteration <= lastSeen, key in cache):
   *    use cached key, evict from cache, decrypt.
   *  - Out-of-order ahead (iteration > lastSeen + 1, within
   *    MAX_FORWARD_RATCHET): derive intermediate keys, cache them,
   *    advance to the new head, decrypt the requested iteration.
   *
   * Throws on signature failure, replay (iteration <= lastSeen and
   * not in cache), or excessive forward skip.
   */
  async decrypt(
    wire: string,
    aad: Omit<AadContext, 'senderKeyId'>
  ): Promise<string> {
    const decoded = decodeWire(wire);
    if (decoded.senderKeyId !== this.state.senderKeyId) {
      throw new Error(
        `senderKeyId mismatch: wire=${decoded.senderKeyId} state=${this.state.senderKeyId}`
      );
    }

    // Verify the signature BEFORE doing any state mutation. Even a
    // ratchet-forward on a forged message would otherwise let a
    // malicious peer DoS the chain into uselessness.
    const signed = concat(
      new Uint8Array([WIRE_VERSION]),
      u32ToBytes(decoded.senderKeyId),
      u32ToBytes(decoded.iteration),
      decoded.iv,
      decoded.ciphertext
    );
    const sigOk = await verifyEd25519(
      this.state.signingPublicKey,
      signed,
      decoded.signature
    );
    if (!sigOk) throw new Error('signature verification failed');

    const fullAad = buildAad(
      { ...aad, senderKeyId: this.state.senderKeyId },
      decoded.iteration
    );

    // Case 1: late arrival of a previously-skipped iteration.
    if (decoded.iteration <= this.state.lastSeen) {
      const cached = cacheTake(this.state.skippedKeys, decoded.iteration);
      if (!cached) {
        throw new Error(
          `replay or expired skip: iteration ${decoded.iteration} <= lastSeen ${this.state.lastSeen}`
        );
      }
      const pt = await aesGcmDecrypt(
        cached,
        decoded.iv,
        decoded.ciphertext,
        fullAad
      );
      return new TextDecoder().decode(pt);
    }

    // Case 2: future iteration — possibly with skips.
    const skipDistance = decoded.iteration - this.state.lastSeen - 1;
    if (skipDistance > MAX_FORWARD_RATCHET) {
      throw new Error(
        `forward skip too large: ${skipDistance} > ${MAX_FORWARD_RATCHET}`
      );
    }

    let chainKey = this.state.chainKey;
    let cursor = this.state.lastSeen + 1;
    // Walk forward, caching message keys for any iterations we skip
    // past (peers will deliver them later).
    while (cursor < decoded.iteration) {
      const { messageKey, nextChainKey } = await advanceChain(chainKey);
      cacheSet(this.state.skippedKeys, cursor, messageKey);
      chainKey = nextChainKey;
      cursor++;
    }
    // Cursor now points at the requested iteration.
    const { messageKey: targetKey, nextChainKey: postKey } =
      await advanceChain(chainKey);
    const plaintext = await aesGcmDecrypt(
      targetKey,
      decoded.iv,
      decoded.ciphertext,
      fullAad
    );

    // Commit state only after a successful decrypt — same partial-
    // failure rule as encrypt, prevents a corrupt-but-signed
    // ciphertext from desyncing the chain.
    this.state.chainKey = postKey;
    this.state.lastSeen = decoded.iteration;
    this.state.iteration = decoded.iteration + 1;

    return new TextDecoder().decode(plaintext);
  }
}

function u32ToBytes(v: number): Uint8Array {
  const b = new Uint8Array(4);
  writeU32BE(b, 0, v);
  return b;
}

/**
 * Shape of a serialized chain in IDB. Uint8Arrays are stored
 * directly (structured clone handles them). The non-extractable
 * `signingPrivateKey` CryptoKey is also structured-cloneable; the
 * browser keeps the actual key material in protected storage.
 */
export type SerializedChain = {
  senderKeyId: number;
  chainKey: Uint8Array;
  iteration: number;
  lastSeen: number;
  skippedKeys: Map<number, Uint8Array>;
  signingPublicKey: Uint8Array;
  signingPrivateKey?: CryptoKey;
};

// Re-export helpers tests use directly — keeps the test surface
// clean even when the consumer modules don't need them.
export const __testing = {
  toB64,
  fromB64,
  advanceChain,
  buildAad,
  WIRE_VERSION,
  WIRE_HEADER_LENGTH,
  SIGNATURE_LENGTH
};
