import type { TNameStyle } from '@pulse/shared';
import type { CSSProperties } from 'react';

/** `#rrggbb` → `rgba()` at the given alpha. */
const withAlpha = (hex: string, alpha: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`;
};

/** `#rrggbb` darkened toward black by `amount` (0..1). */
const darken = (hex: string, amount: number) => {
  const n = parseInt(hex.slice(1), 16);
  const scale = (c: number) => Math.round(c * (1 - amount));
  const v =
    (scale((n >> 16) & 0xff) << 16) |
    (scale((n >> 8) & 0xff) << 8) |
    scale(n & 0xff);
  return `#${v.toString(16).padStart(6, '0')}`;
};

/**
 * CSS for a styled display name (users.nameStyle — HOME surfaces only,
 * server chat/member lists keep role colors authoritative). Spread the
 * result onto the name element:
 *
 *   const nameCss = getNameStyleCss(user.nameStyle);
 *   <span className={cn('...', nameCss?.className)} style={nameCss?.style}>
 *
 * The `name-font-*` / `name-effect-*` classes are declared in index.css.
 */
export const getNameStyleCss = (
  style: TNameStyle | null | undefined
): { className?: string; style?: CSSProperties } | null => {
  if (!style) return null;

  const classes: string[] = [];
  const css: CSSProperties = {};

  if (style.font) classes.push(`name-font-${style.font}`);

  // Every effect except solid animates (keyframes live in index.css and
  // are disabled under prefers-reduced-motion, falling back to a static
  // version of the same look). Colors reach the keyframes via CSS vars.
  const vars = css as CSSProperties & Record<string, string>;

  switch (style.effect) {
    case 'solid':
      css.color = style.color;
      break;
    case 'gradient':
      // c1 -> c2 -> c1 tiles seamlessly for the horizontal sweep.
      classes.push('name-effect-gradient');
      css.backgroundImage = `linear-gradient(90deg, ${style.color}, ${style.color2 ?? style.color}, ${style.color})`;
      break;
    case 'neon':
      // Sign-style glow that breathes and occasionally flickers. The
      // static base keeps a tight, low-alpha halo so light themes stay
      // readable; the animation modulates the same halo.
      classes.push('name-effect-neon');
      css.color = style.color;
      vars['--name-neon-1'] = withAlpha(style.color, 0.6);
      vars['--name-neon-2'] = withAlpha(style.color, 0.4);
      vars['--name-neon-3'] = withAlpha(style.color, 0.25);
      css.textShadow = [
        `0 0 3px ${withAlpha(style.color, 0.6)}`,
        `0 0 8px ${withAlpha(style.color, 0.4)}`,
        `0 0 16px ${withAlpha(style.color, 0.25)}`
      ].join(', ');
      break;
    case 'toon':
      // Cartoon energy: the two colors chase vertically through the
      // glyphs with white flashes between them; a thin dark stroke
      // keeps the comic outline.
      classes.push('name-effect-toon');
      vars['--name-toon-1'] = style.color;
      vars['--name-toon-2'] = style.color2 ?? darken(style.color, 0.35);
      css.WebkitTextStroke = `1px ${darken(style.color, 0.6)}`;
      break;
    case 'pop':
      // Cycle: flat primary -> the text lifts, revealing the duplicate
      // in the secondary color behind -> holds -> settles flat again.
      classes.push('name-effect-pop');
      css.color = style.color;
      vars['--name-pop-2'] = style.color2 ?? '#000000';
      break;
  }

  return {
    className: classes.length ? classes.join(' ') : undefined,
    style: css
  };
};
