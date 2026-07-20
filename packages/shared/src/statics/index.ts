export * from "./permissions";
export * from "./storage";
export * from "./metrics";

export const DEFAULT_MESSAGES_LIMIT = 100;

/**
 * Plaintext budget the composer enforces before sending. The server-side
 * wire cap (MAX_MESSAGE_WIRE_LENGTH) is deliberately larger because E2EE
 * clients encrypt BEFORE the server validates: pairwise libsignal DMs
 * expand to ~1.63 chars per plaintext byte (JSON-escaped binary body,
 * more on a session's first PreKey message) and sender-key channels to
 * ~4/3 plus ~130 chars of envelope, so a full-length plaintext message
 * must still fit the wire cap after encryption.
 */
export const MAX_MESSAGE_CONTENT_LENGTH = 16000;
export const MAX_MESSAGE_WIRE_LENGTH = 40000;

export const OWNER_ROLE_ID = 1;

/**
 * Built-in nameplate presets — decorative member-row backgrounds. The
 * first group renders as client-side CSS gradients; the second as
 * animated GIFs bundled with the client (public/nameplates/<slug>.gif).
 * The server only validates equipped values ('preset:<slug>' in
 * users.nameplate) against this list.
 */
export const NAMEPLATE_PRESET_SLUGS: readonly string[] = [
  // CSS gradients
  "aurora",
  "ember",
  "ocean",
  "synthwave",
  "forest",
  "rose",
  "gold",
  "steel",
  "midnight",
  "wave",
  // Animated (bundled GIFs)
  "drowned",
  "sakura",
  "borealis",
  "sunsetdrive",
  "tide",
  "lava",
  "fireflies",
  "prism",
  "clouds",
  "koi",
  "runes",
  "cipher",
  "storm",
  "starfield",
  "eclipse",
  "abyss",
  "rainfall",
  "snowfall",
  "neonwave",
  "embers",
  "glitch",
];

export const TYPING_MS = 2000;

/**
 * Hover stream preview (voice roster). A sharing client publishes a small
 * JPEG data-URL frame every ~10s; hover cards pull it on demand (no fanout).
 * The length cap bounds the tRPC payload; the stale window keeps a dead
 * publisher from serving a frozen frame forever.
 */
export const VOICE_STREAM_PREVIEW_MAX_LENGTH = 65_536;
export const VOICE_STREAM_PREVIEW_STALE_MS = 45_000;
export const VOICE_STREAM_PREVIEW_INTERVAL_MS = 10_000;
export const VOICE_STREAM_PREVIEW_PREFIX = "data:image/jpeg;base64,";

export enum DisconnectCode {
  UNEXPECTED = 1006,
  FEDERATION_REJECTED = 4003,
  KICKED = 40000,
  BANNED = 40001,
  SERVER_SHUTDOWN = 40002,
}
