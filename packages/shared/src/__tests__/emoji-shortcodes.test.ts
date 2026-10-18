import { describe, expect, test } from "bun:test";
import {
  isUnicodeEmoji,
  normalizeReaction,
  shortcodeToUnicode,
  stripVariationSelectors,
  unicodeToShortcode
} from "../emoji-shortcodes";
import { EMOJI_SHORTCODE_ENTRIES } from "../emoji-shortcodes.data";

/**
 * The reaction normalizer every write path shares, and the generated
 * table behind it.
 *
 * Run via: bun test packages/shared/src/__tests__/emoji-shortcodes.test.ts
 */

describe("the generated table", () => {
  test("holds the dataset's glyphs once each, under their primary shortcode", () => {
    expect(EMOJI_SHORTCODE_ENTRIES.length).toBeGreaterThan(1_800);
    const glyphs = EMOJI_SHORTCODE_ENTRIES.map(([emoji]) => stripVariationSelectors(emoji));
    expect(new Set(glyphs).size).toBe(glyphs.length);
    expect(EMOJI_SHORTCODE_ENTRIES.find(([, name]) => name === "+1")).toEqual(["👍", "+1", "thumbsup", "yes"]);
    // Picture-only entries (no unicode) are not in the table.
    expect(EMOJI_SHORTCODE_ENTRIES.some(([, name]) => name === "octocat")).toBe(false);
  });
});

describe("unicodeToShortcode / shortcodeToUnicode", () => {
  test("round-trip through the primary name; variation selectors are ignored on the way in", () => {
    expect(unicodeToShortcode("👍")).toBe("+1");
    expect(unicodeToShortcode("❤️")).toBe("heart");
    expect(unicodeToShortcode("❤")).toBe("heart");
    expect(unicodeToShortcode("🔥")).toBe("fire");
    expect(unicodeToShortcode("fire")).toBeNull();
    expect(unicodeToShortcode("")).toBeNull();

    expect(shortcodeToUnicode("+1")).toBe("👍");
    expect(shortcodeToUnicode("thumbsup")).toBe("👍");
    // The dataset spells this one without the selector; it comes back as spelled.
    expect(shortcodeToUnicode("heart")).toBe("❤");
    expect(shortcodeToUnicode("red_heart")).toBe("❤");
    expect(shortcodeToUnicode("fire")).toBe("🔥");
    expect(shortcodeToUnicode("pogchamp")).toBeNull();
  });
});

describe("normalizeReaction", () => {
  test("a known glyph becomes its shortcode; a :name: token loses its colons; the rest is kept", () => {
    expect(normalizeReaction("👍")).toBe("+1");
    expect(normalizeReaction("❤️")).toBe("heart");
    expect(normalizeReaction("😂")).toBe("joy");
    expect(normalizeReaction(":pogchamp:")).toBe("pogchamp");
    expect(normalizeReaction(":+1:")).toBe("+1");
    expect(normalizeReaction("pogchamp")).toBe("pogchamp");
    expect(normalizeReaction("+1")).toBe("+1");
    // An alias stays an alias: it may be a custom emoji's name.
    expect(normalizeReaction("thumbsup")).toBe("thumbsup");
    expect(normalizeReaction("yes")).toBe("yes");
    // Surrounding whitespace is noise, inner colons are not a token.
    expect(normalizeReaction(" 👍 ")).toBe("+1");
    expect(normalizeReaction("::")).toBe("::");
    expect(normalizeReaction(":a b:")).toBe(":a b:");
    // A glyph the table lacks (a reserved pictographic code point) is kept as it is.
    expect(unicodeToShortcode("\u{1FAFF}")).toBeNull();
    expect(normalizeReaction("\u{1FAFF}")).toBe("\u{1FAFF}");
  });
});

describe("isUnicodeEmoji", () => {
  test("recognises glyphs, not names", () => {
    expect(isUnicodeEmoji("👍")).toBe(true);
    expect(isUnicodeEmoji("🇩🇪")).toBe(true);
    expect(isUnicodeEmoji("\u{1FAFF}")).toBe(true);
    expect(isUnicodeEmoji("fire")).toBe(false);
    expect(isUnicodeEmoji("pogchamp")).toBe(false);
    expect(isUnicodeEmoji("+1")).toBe(false);
  });
});
