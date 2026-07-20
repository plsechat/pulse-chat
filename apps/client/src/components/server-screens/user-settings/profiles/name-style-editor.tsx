import { Button } from '@/components/ui/button';
import { getDisplayName } from '@/helpers/get-display-name';
import { getNameStyleCss } from '@/helpers/name-style';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getHomeTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { TJoinedPublicUser, TNameStyle } from '@pulse/shared';
import { NAME_STYLE_EFFECTS, NAME_STYLE_FONTS } from '@pulse/shared';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

type TFontSlug = NonNullable<TNameStyle['font']>;
type TEffect = TNameStyle['effect'];

const FONT_LABELS: Record<TFontSlug, string> = {
  'press-start': '8Bit',
  pacifico: 'Script',
  playfair: 'Modern',
  baloo: 'Bubble',
  'jetbrains-mono': 'Mono',
  oswald: 'Bold',
  medieval: 'Medieval',
  jellybean: 'Jellybean',
  sakura: 'Sakura',
  tempo: 'Tempo',
  vampyre: 'Vampyre'
};

const EFFECT_LABELS: Record<TEffect, string> = {
  solid: 'Solid',
  gradient: 'Gradient',
  neon: 'Neon',
  toon: 'Toon',
  pop: 'Pop'
};

/** Same curated palette shape as the role editor's swatch row. */
const NAME_COLOR_PRESETS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c', '#3498db',
  '#9b59b6', '#e91e8f', '#f43f5e', '#14b8a6', '#64748b', '#a1a1aa'
];

type TSwatchRowProps = {
  value: string;
  onPick: (color: string) => void;
  customLabel: string;
};

const SwatchRow = memo(({ value, onPick, customLabel }: TSwatchRowProps) => (
  <div className="flex flex-wrap items-center gap-1.5">
    {NAME_COLOR_PRESETS.map((preset) => (
      <button
        key={preset}
        type="button"
        aria-label={`Use color ${preset}`}
        onClick={() => onPick(preset)}
        className={cn(
          'h-7 w-7 rounded-full ring-1 ring-inset ring-black/10 transition-transform duration-100 hover:scale-110',
          value.toLowerCase() === preset &&
            'outline outline-2 outline-offset-2 outline-ring'
        )}
        style={{ backgroundColor: preset }}
      />
    ))}
    <input
      type="color"
      aria-label={customLabel}
      value={value}
      onChange={(e) => onPick(e.target.value)}
      className="h-7 w-9 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
    />
  </div>
));

type TNameStyleEditorProps = {
  user: TJoinedPublicUser;
  /**
   * Fired with the pending (unsaved) style whenever an axis changes, so
   * the live preview can overlay it. `undefined` hands the preview back
   * to the equipped `user.nameStyle` (untouched / just applied).
   */
  onDraftChange: (style: TNameStyle | undefined) => void;
};

/** Draft-then-apply editor for users.nameStyle — a single mutation on
 *  Apply covers all four axes (font / effect / color / color2). */
const NameStyleEditor = memo(({ user, onDraftChange }: TNameStyleEditorProps) => {
  const equipped = user.nameStyle ?? null;

  const [font, setFont] = useState<TFontSlug | undefined>(equipped?.font);
  const [effect, setEffect] = useState<TEffect>(equipped?.effect ?? 'solid');
  const [color, setColor] = useState(equipped?.color ?? '#3498db');
  const [color2, setColor2] = useState(equipped?.color2 ?? '#9b59b6');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  const usesColor2 = effect === 'gradient' || effect === 'pop';

  const draft = useMemo<TNameStyle>(
    () => ({
      ...(font ? { font } : {}),
      effect,
      color,
      ...(usesColor2 ? { color2 } : {})
    }),
    [font, effect, color, color2, usesColor2]
  );

  // Push the pending draft up only after the user actually changed
  // something — an untouched editor must not repaint the preview.
  useEffect(() => {
    if (touched) onDraftChange(draft);
  }, [touched, draft, onDraftChange]);

  const onApply = useCallback(async () => {
    const trpc = getHomeTRPCClient();
    if (!trpc) return;

    setSaving(true);
    try {
      await trpc.users.setNameStyle.mutate({ style: draft });
      // Equipped now matches the draft — hand the preview back to the
      // live user object (refreshed via the USER_UPDATE fanout).
      setTouched(false);
      onDraftChange(undefined);
      toast.success('Name style applied');
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to apply name style'));
    } finally {
      setSaving(false);
    }
  }, [draft, onDraftChange]);

  const onClear = useCallback(async () => {
    const trpc = getHomeTRPCClient();
    if (!trpc) return;

    setSaving(true);
    try {
      await trpc.users.setNameStyle.mutate({ style: null });
      setTouched(false);
      onDraftChange(undefined);
      toast.success('Name style cleared');
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to clear name style'));
    } finally {
      setSaving(false);
    }
  }, [onDraftChange]);

  const sampleCss = getNameStyleCss(draft);
  const name = getDisplayName(user);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <span className="text-xs font-semibold uppercase text-muted-foreground">
          Font
        </span>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
          <button
            type="button"
            title="Default"
            onClick={() => {
              setTouched(true);
              setFont(undefined);
            }}
            className={cn(
              'flex flex-col items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1 py-2 transition-[border-color,box-shadow] duration-100 hover:border-border',
              font === undefined && 'border-transparent ring-2 ring-primary'
            )}
          >
            <span className="text-xl leading-none text-foreground/90">Gg</span>
            <span className="max-w-full truncate text-[10px] text-muted-foreground">
              Default
            </span>
          </button>
          {NAME_STYLE_FONTS.map((slug) => (
            <button
              key={slug}
              type="button"
              title={FONT_LABELS[slug]}
              onClick={() => {
                setTouched(true);
                setFont(slug);
              }}
              className={cn(
                'flex flex-col items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1 py-2 transition-[border-color,box-shadow] duration-100 hover:border-border',
                font === slug && 'border-transparent ring-2 ring-primary'
              )}
            >
              <span
                className={cn(
                  'text-xl leading-none text-foreground/90',
                  `name-font-${slug}`
                )}
              >
                Gg
              </span>
              <span className="max-w-full truncate text-[10px] text-muted-foreground">
                {FONT_LABELS[slug]}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs font-semibold uppercase text-muted-foreground">
          Effect
        </span>
        <div className="flex flex-wrap gap-1.5">
          {NAME_STYLE_EFFECTS.map((value) => {
            // Each pill wears its own effect so the row doubles as a
            // legend — rendered with the currently drafted colors.
            const pillCss = getNameStyleCss({
              effect: value,
              color,
              ...(value === 'gradient' || value === 'pop'
                ? { color2 }
                : {})
            });
            return (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setTouched(true);
                  setEffect(value);
                }}
                className={cn(
                  'rounded-full border border-border/60 bg-muted/40 px-3 py-1 transition-[border-color,box-shadow] duration-100 hover:border-border',
                  effect === value && 'border-transparent ring-2 ring-primary'
                )}
              >
                <span
                  className={cn('text-sm font-semibold', pillCss?.className)}
                  style={pillCss?.style}
                >
                  {EFFECT_LABELS[value]}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs font-semibold uppercase text-muted-foreground">
          Color
        </span>
        <SwatchRow
          value={color}
          customLabel="Custom color"
          onPick={(value) => {
            setTouched(true);
            setColor(value);
          }}
        />
      </div>

      {usesColor2 && (
        <div className="space-y-1.5">
          <span className="text-xs font-semibold uppercase text-muted-foreground">
            {effect === 'gradient' ? 'Gradient end color' : 'Shadow color'}
          </span>
          <SwatchRow
            value={color2}
            customLabel="Custom secondary color"
            onPick={(value) => {
              setTouched(true);
              setColor2(value);
            }}
          />
        </div>
      )}

      <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2.5">
        <span
          className={cn('text-lg font-semibold', sampleCss?.className)}
          style={sampleCss?.style}
        >
          {name}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onApply} disabled={saving}>
          Apply
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onClear}
          disabled={saving || (!equipped && !touched)}
        >
          Clear
        </Button>
      </div>
    </div>
  );
});

export { NameStyleEditor };
