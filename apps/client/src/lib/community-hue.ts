/**
 * Every community gets its own hue, derived from a stable id, so its tab,
 * header and active channel are tinted the same way everywhere and every
 * time. Hues are spread across the wheel but kept away from the band the
 * destructive red owns (≈ 350–20), so a tinted row never reads as an error.
 */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const hash32 = (input: string): number => {
  let h = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
};

/** Degrees on the OKLCH wheel, 25 ≤ hue < 345. */
const communityHue = (seed: string): number => {
  if (!seed) return 190;
  return 25 + (hash32(seed) % 320);
};

export { communityHue };
