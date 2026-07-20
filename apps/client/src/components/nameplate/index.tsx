import { useActiveInstanceDomain } from '@/features/app/hooks';
import { useNameplatePacks } from '@/features/nameplates/hooks';
import { getFileUrl } from '@/helpers/get-file-url';
import { cn } from '@/lib/utils';
import { memo, useMemo } from 'react';
import {
  customNameplateStyle,
  NAMEPLATE_PRESETS,
  presetNameplateStyle
} from './presets';

type TNameplateBackgroundProps = {
  /** The user's `nameplate` value — null/undefined renders nothing. */
  nameplate: string | null | undefined;
  /**
   * The row's user lives in HOME id-space (DM sidebar). 'custom:<id>'
   * ids are home ids too, so while a federated server is active — when
   * the packs store holds the REMOTE server's packs — custom resolution
   * is skipped instead of matching a colliding remote id. Presets are
   * id-free and always render.
   */
  homeScope?: boolean;
  className?: string;
};

/**
 * Decorative background strip for a user's row (member list, DM list).
 * Mount as the first child of a `relative overflow-hidden` row; the row
 * content itself must be positioned (`relative`) so it paints on top.
 * The row's own hover/selection background stays underneath, showing
 * through the plate's translucency.
 */
const NameplateBackground = memo(
  ({ nameplate, homeScope, className }: TNameplateBackgroundProps) => {
    const packs = useNameplatePacks();
    const activeInstanceDomain = useActiveInstanceDomain();

    const resolved = useMemo(() => {
      if (!nameplate) return undefined;

      if (nameplate.startsWith('preset:')) {
        const preset = NAMEPLATE_PRESETS[nameplate.slice('preset:'.length)];
        if (!preset) return undefined;
        return { style: presetNameplateStyle(preset), animated: preset.animated };
      }

      if (nameplate.startsWith('custom:')) {
        if (homeScope && activeInstanceDomain) return undefined;
        const packId = Number(nameplate.slice('custom:'.length));
        const pack = packs.find((p) => p.id === packId);
        if (!pack) return undefined;
        return {
          style: customNameplateStyle(
            getFileUrl(pack.file, activeInstanceDomain ?? undefined)
          )
        };
      }

      return undefined;
    }, [nameplate, homeScope, packs, activeInstanceDomain]);

    if (!resolved) return null;

    return (
      <div
        aria-hidden
        className={cn(
          // Slightly dimmed on light themes — the same alphas read
          // stronger against white than against dark surfaces.
          'pointer-events-none absolute inset-0 opacity-80 dark:opacity-100',
          resolved.animated && 'nameplate-animated',
          className
        )}
        style={resolved.style}
      />
    );
  }
);

export { NameplateBackground };
