/**
 * Stored reactions are shortcodes; the renderer draws the glyph for a
 * known one and only reaches for a custom-emoji image when the name is
 * not an emoji at all.
 *
 * Run via: bun test apps/client/src/helpers/__tests__/emoji-shortcode.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { reactionText, resolveReactionGlyph } from '../emoji-shortcode';

describe('resolveReactionGlyph', () => {
  test('a shortcode, an alias, a :token: and a raw glyph all draw the glyph', () => {
    expect(resolveReactionGlyph('+1')).toEqual({ kind: 'glyph', glyph: '👍' });
    expect(resolveReactionGlyph('thumbsup')).toEqual({ kind: 'glyph', glyph: '👍' });
    expect(resolveReactionGlyph(':+1:')).toEqual({ kind: 'glyph', glyph: '👍' });
    expect(resolveReactionGlyph('👍')).toEqual({ kind: 'glyph', glyph: '👍' });
    expect(resolveReactionGlyph('❤️')).toEqual({ kind: 'glyph', glyph: '❤' });
  });

  test('a glyph the table lacks is still a glyph, never an image', () => {
    expect(resolveReactionGlyph('\u{1FAFF}')).toEqual({ kind: 'glyph', glyph: '\u{1FAFF}' });
    expect(resolveReactionGlyph('🇩🇪')).toEqual({ kind: 'glyph', glyph: '🇩🇪' });
  });

  test('only a name that is no emoji is a custom one', () => {
    expect(resolveReactionGlyph('pogchamp')).toEqual({ kind: 'custom', name: 'pogchamp' });
    expect(resolveReactionGlyph(':pogchamp:')).toEqual({ kind: 'custom', name: 'pogchamp' });
  });
});

describe('reactionText', () => {
  test('the glyph, else the token', () => {
    expect(reactionText('fire')).toBe('🔥');
    expect(reactionText('🔥')).toBe('🔥');
    expect(reactionText('pogchamp')).toBe(':pogchamp:');
  });
});
