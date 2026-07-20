import type { CSSProperties } from 'react';

/**
 * Built-in nameplate visuals, keyed by the NAMEPLATE_PRESET_SLUGS
 * entries the server validates equips against. Every background is
 * right-anchored art dissolved toward the name by the shared left-fade
 * mask below, and alphas stay ≤ ~0.35 so a plate reads on both the
 * light and dark theme families without outshouting the row content.
 */
type TNameplatePreset = {
  label: string;
  /** CSS background-image (layered gradients allowed). */
  backgroundImage?: string;
  /** Bundled asset (animated GIF) — rendered cover, right-anchored. */
  imageUrl?: string;
  /** Oversized + drifted by the nameplate-drift animation when set
   *  (gradients only — GIFs animate themselves). */
  animated?: boolean;
};

/** Bundled animated presets — assets live in public/nameplates/. */
const ANIMATED_PRESET_LABELS: Record<string, string> = {
  drowned: 'Drowned',
  sakura: 'Sakura',
  borealis: 'Borealis',
  sunsetdrive: 'Sunset Drive',
  tide: 'Tide',
  lava: 'Lava',
  fireflies: 'Fireflies',
  prism: 'Prism',
  clouds: 'Daydream',
  koi: 'Koi Pond',
  runes: 'Runes',
  cipher: 'Cipher',
  storm: 'Storm',
  starfield: 'Starfield',
  eclipse: 'Eclipse',
  abyss: 'Abyss',
  rainfall: 'City Rain',
  snowfall: 'Snowfall',
  neonwave: 'Neon Wave',
  embers: 'Embers',
  glitch: 'Glitch'
};

const NAMEPLATE_PRESETS: Record<string, TNameplatePreset> = {
  aurora: {
    label: 'Aurora',
    backgroundImage:
      'linear-gradient(100deg, transparent 40%, rgba(45, 212, 191, 0.24) 62%, rgba(96, 165, 250, 0.28) 80%, rgba(192, 132, 252, 0.32) 100%)',
    animated: true
  },
  ember: {
    label: 'Ember',
    backgroundImage:
      'linear-gradient(to left, rgba(239, 68, 68, 0.34) 0%, rgba(249, 115, 22, 0.22) 35%, rgba(250, 204, 21, 0.08) 60%, transparent 85%)'
  },
  ocean: {
    label: 'Ocean',
    backgroundImage:
      'linear-gradient(105deg, transparent 40%, rgba(14, 165, 233, 0.22) 65%, rgba(37, 99, 235, 0.32) 100%)'
  },
  synthwave: {
    label: 'Synthwave',
    backgroundImage:
      'linear-gradient(100deg, transparent 35%, rgba(217, 70, 239, 0.26) 60%, rgba(139, 92, 246, 0.30) 80%, rgba(34, 211, 238, 0.30) 100%)'
  },
  forest: {
    label: 'Forest',
    backgroundImage:
      'linear-gradient(to left, rgba(22, 163, 74, 0.32) 0%, rgba(101, 163, 13, 0.18) 40%, transparent 80%)'
  },
  rose: {
    label: 'Rose',
    backgroundImage:
      'linear-gradient(to left, rgba(244, 63, 94, 0.30) 0%, rgba(251, 113, 133, 0.16) 40%, transparent 80%)'
  },
  gold: {
    label: 'Gold',
    backgroundImage:
      'linear-gradient(100deg, transparent 45%, rgba(245, 158, 11, 0.16) 65%, rgba(252, 211, 77, 0.34) 85%, rgba(245, 158, 11, 0.30) 100%)'
  },
  steel: {
    label: 'Steel',
    backgroundImage:
      'linear-gradient(to left, rgba(148, 163, 184, 0.34) 0%, rgba(100, 116, 139, 0.18) 45%, transparent 85%)'
  },
  midnight: {
    label: 'Midnight',
    backgroundImage:
      'linear-gradient(105deg, transparent 40%, rgba(67, 56, 202, 0.28) 70%, rgba(30, 27, 75, 0.45) 100%)'
  },
  wave: {
    label: 'Wave',
    backgroundImage:
      'repeating-linear-gradient(115deg, rgba(34, 211, 238, 0.18) 0px, rgba(34, 211, 238, 0.18) 10px, rgba(59, 130, 246, 0.07) 10px, rgba(59, 130, 246, 0.07) 20px)',
    animated: true
  },
  ...Object.fromEntries(
    Object.entries(ANIMATED_PRESET_LABELS).map(([slug, label]) => [
      slug,
      { label, imageUrl: `/nameplates/${slug}.gif` }
    ])
  )
};

/**
 * Shared left fade — the art stays solid on the right ~30% of the row
 * and dissolves to nothing before it reaches the name/avatar. Applied
 * to presets AND custom images so both sources obey the same
 * "never louder than the content" ceiling.
 */
const NAMEPLATE_MASK =
  'linear-gradient(to left, black 30%, transparent 95%)';

const presetNameplateStyle = (preset: TNameplatePreset): CSSProperties =>
  preset.imageUrl
    ? {
        backgroundImage: `url("${preset.imageUrl}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'right center',
        maskImage: NAMEPLATE_MASK,
        WebkitMaskImage: NAMEPLATE_MASK
      }
    : {
        backgroundImage: preset.backgroundImage,
        maskImage: NAMEPLATE_MASK,
        WebkitMaskImage: NAMEPLATE_MASK
      };

/** Style for a server-uploaded pack image — right-cover, same left fade. */
const customNameplateStyle = (url: string): CSSProperties => ({
  backgroundImage: `url("${url}")`,
  backgroundSize: 'cover',
  backgroundPosition: 'right center',
  maskImage: NAMEPLATE_MASK,
  WebkitMaskImage: NAMEPLATE_MASK
});

export { customNameplateStyle, NAMEPLATE_PRESETS, presetNameplateStyle };
export type { TNameplatePreset };
