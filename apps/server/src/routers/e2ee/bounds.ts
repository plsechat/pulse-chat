/**
 * Input bounds shared by the channel and DM E2EE routers. Every value
 * here is client-supplied and lands in a table row, so each cap is a
 * storage/DoS ceiling rather than a protocol constant.
 */

/** Base64 Curve25519 keys and Ed25519/XEdDSA signatures are < 100 chars. */
const MAX_E2EE_KEY_LENGTH = 256;
/** A sender-key distribution message (SKDM) encrypted to one recipient. */
const MAX_DISTRIBUTION_MESSAGE_LENGTH = 16_384;
/** Recipients per distribution call / ids per acknowledge call. */
const MAX_E2EE_BATCH = 500;
/** One-time pre-keys accepted per upload (the client replenishes 100). */
const MAX_OTP_BATCH = 200;
/** One-time pre-keys a user may have waiting on the server. */
const MAX_OTP_PER_USER = 500;
/** Signed pre-keys kept after a rotation: the current one plus the previous. */
const SIGNED_PREKEYS_KEPT = 2;
const MAX_SENDER_KEY_ID = 2 ** 31 - 1;
const MAX_REGISTRATION_ID = 2 ** 31 - 1;
/** Encrypted key backup blob (a few tens of KB in practice). */
const MAX_KEY_BACKUP_LENGTH = 1_048_576;

export {
  MAX_DISTRIBUTION_MESSAGE_LENGTH,
  MAX_E2EE_BATCH,
  MAX_E2EE_KEY_LENGTH,
  MAX_KEY_BACKUP_LENGTH,
  MAX_OTP_BATCH,
  MAX_OTP_PER_USER,
  MAX_REGISTRATION_ID,
  MAX_SENDER_KEY_ID,
  SIGNED_PREKEYS_KEPT
};
