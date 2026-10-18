import {
  isUnicodeEmoji,
  normalizeReaction,
  shortcodeToUnicode
} from '@pulse/shared';

/**
 * How a stored reaction is drawn. Reactions are stored by shortcode
 * (`+1`, `heart`, a custom emoji's bare name) — see @pulse/shared
 * normalizeReaction — but rows written before that, and anything a
 * bridge relays, may still carry a raw glyph or a `:name:` token, so
 * every spelling is resolved here: a name the table knows is its glyph,
 * a glyph the table does not know is still a glyph, and only a name
 * that is neither is a custom emoji whose image is on the row's file.
 */
export type TReactionGlyph =
  | { kind: 'glyph'; glyph: string }
  | { kind: 'custom'; name: string };

export const resolveReactionGlyph = (emoji: string): TReactionGlyph => {
  const name = normalizeReaction(emoji);
  const glyph = shortcodeToUnicode(name);
  if (glyph !== null) return { kind: 'glyph', glyph };
  if (isUnicodeEmoji(name)) return { kind: 'glyph', glyph: name };
  return { kind: 'custom', name };
};

/** The glyph for a known name, else the `:name:` token (forum cards, tooltips). */
export const reactionText = (emoji: string): string => {
  const resolved = resolveReactionGlyph(emoji);
  return resolved.kind === 'glyph' ? resolved.glyph : `:${resolved.name}:`;
};
