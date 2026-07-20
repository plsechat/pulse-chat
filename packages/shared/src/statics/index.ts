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
  "racer",
  "motorbike",
  "archery",
  "gridiron",
  "arcade",
  "controller",
  "anime",
  "katana",
  "haunted",
  "jackolantern",
  "sunny",
  "rainbowpop",
  "kawaii",
  "dice",
  "equalizer",
  "hoops",
];

/**
 * Built-in avatar decoration presets — animated frames drawn around the
 * avatar circle, bundled with the client as APNG at
 * public/decorations/<slug>.png (canvas 288, avatar radius 120, so the
 * art extends ~20% beyond the avatar on each side). The server only
 * validates equipped values ('preset:<slug>' in users.avatarDecoration)
 * against this list.
 */
export const AVATAR_DECORATION_SLUGS: readonly string[] = [
  "mists",
  "flames",
  "halo",
  "orbit",
  "thorns",
  "frost",
  "petals",
  "neonring",
  "stardust",
  "glitchring",
  "koifish",
  "crown",
];

/**
 * Styled display-name options (HOME surfaces only — server chat and the
 * member list keep role colors authoritative). Fonts are bundled with
 * the client at public/fonts/<slug>.woff2; effects map to CSS in the
 * client's name-style helper.
 */
export const NAME_STYLE_FONTS = [
  "press-start",
  "pacifico",
  "playfair",
  "baloo",
  "jetbrains-mono",
  "oswald",
  "medieval",
  "jellybean",
  "sakura",
  "tempo",
  "vampyre",
] as const;

export const NAME_STYLE_EFFECTS = [
  "solid",
  "gradient",
  "neon",
  "toon",
  "pop",
] as const;

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
