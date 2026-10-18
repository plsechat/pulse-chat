import { EMOJI_SHORTCODE_ENTRIES } from "./emoji-shortcodes.data";

/**
 * Reactions are stored by shortcode name — `+1`, `heart`, `fire` — on
 * every path that writes one (the member's toggle, the DM toggle, a
 * plugin's `react` action), whatever spelling arrived: the picker's
 * name, a `:name:` token, or a raw glyph as a bridge relays it. One
 * stored form means one row per reaction on the message, and the
 * renderer draws the glyph for a known name and reaches for the custom
 * emoji image only for a name the table does not know.
 *
 * The table itself is generated (scripts/gen-emoji-shortcodes.ts) from
 * the client's emoji dataset, so the server agrees with the picker.
 */

const VARIATION_SELECTOR_16 = /️/g;

/** U+FE0F only asks for the emoji presentation; it never changes which emoji it is. */
export const stripVariationSelectors = (text: string): string =>
  text.replace(VARIATION_SELECTOR_16, "");

/** FE0F-stripped glyph → primary shortcode. */
const nameByGlyph = new Map<string, string>();
/** Every shortcode (primary and alias) → the glyph as the dataset spells it. */
const glyphByName = new Map<string, string>();

for (const [emoji, name, ...aliases] of EMOJI_SHORTCODE_ENTRIES) {
  nameByGlyph.set(stripVariationSelectors(emoji), name);
  for (const code of [name, ...aliases]) {
    if (!glyphByName.has(code)) glyphByName.set(code, emoji);
  }
}

/** `👍` → `+1`; null for a glyph the table does not know (or anything that is not a glyph). */
export const unicodeToShortcode = (emoji: string): string | null =>
  nameByGlyph.get(stripVariationSelectors(emoji)) ?? null;

/** `+1` (or an alias such as `thumbsup`) → `👍`; null for an unknown name. */
export const shortcodeToUnicode = (name: string): string | null => glyphByName.get(name) ?? null;

/** A `:name:` token: no whitespace or colon inside. */
const COLON_TOKEN = /^:([^\s:]+):$/;

/**
 * The stored form of a reaction: a known glyph becomes its shortcode,
 * a `:name:` token loses its colons, anything else (a bare name, custom
 * or not; a glyph newer than the table) is kept as it came. Aliases are
 * NOT folded into the primary name: a custom emoji may well be called
 * `yes` or `thumbsup`, and the renderer resolves either spelling.
 */
export const normalizeReaction = (raw: string): string => {
  const text = raw.trim();
  const fromGlyph = unicodeToShortcode(text);
  if (fromGlyph !== null) return fromGlyph;
  const token = COLON_TOKEN.exec(text);
  if (token) return token[1]!;
  return text;
};

const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/**
 * Whether a reaction string is itself an emoji glyph the table does not
 * know (one newer than the dataset, or a sequence it lacks). Such a
 * reaction is drawn as the glyph it is, never as a custom emoji image.
 */
export const isUnicodeEmoji = (text: string): boolean => PICTOGRAPHIC.test(text);
