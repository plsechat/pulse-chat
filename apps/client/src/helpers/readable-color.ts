/**
 * Contrast mitigation for user-chosen role colors. Roles can be ANY hex —
 * a white/pastel role on a light surface (or near-black on a dark one) is
 * unreadable. Instead of special-casing '#ffffff' (the old dodge, which
 * #fefefe sailed straight past), measure actual WCAG contrast against the
 * surface and, only when it fails, mix the color toward the readable pole
 * until it passes — keeping as much of the chosen hue as possible.
 */

type TRgb = { r: number; g: number; b: number };

function hexToRgb(hex: string): TRgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }: TRgb): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: TRgb): number {
  const chan = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function contrastRatio(a: TRgb, b: TRgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: TRgb, b: TRgb, t: number): TRgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t)
  };
}

/** Colored-name text floor. 3:1 is the WCAG large-text/graphics bar —
 * names are short, semibold, and sit beside an avatar, so 3:1 reads fine
 * while preserving far more of the chosen hue than 4.5:1 would. */
const MIN_RATIO = 3;

/**
 * Returns `color` unchanged when it already reads against `surface`;
 * otherwise the closest hue-preserving mix toward black/white that does.
 * Falls back to the input on unparseable values (var() etc.).
 */
export function ensureReadableColor(color: string, surface: string): string {
  const fg = hexToRgb(color);
  const bg = hexToRgb(surface);
  if (!fg || !bg) return color;
  if (contrastRatio(fg, bg) >= MIN_RATIO) return color;

  // Pull toward whichever pole opposes the surface.
  const pole: TRgb =
    luminance(bg) > 0.5 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };

  // Binary search the smallest mix that clears the floor (8 steps ≈ 0.4%).
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(mix(fg, pole, mid), bg) >= MIN_RATIO) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return rgbToHex(mix(fg, pole, hi));
}
