import { useMemo, useRef, useState } from 'react';

type TPoint = { ts: number; v: number };
type TSeries = { label: string; color: string; points: TPoint[] };

const VIEW_W = 600;
const VIEW_H = 150;
const PAD_Y = 6;

/** Round an axis max up to a friendly step so the top label reads clean. */
const niceMax = (raw: number): number => {
  if (raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) {
    if (raw <= m * mag) return m * mag;
  }
  return 10 * mag;
};

/**
 * Small time-series chart: 2px lines (non-scaling), an area fill only
 * when there's a single series, three recessive grid hairlines, and a
 * crosshair + tooltip. Identity is never color-alone: multi-series
 * charts render a legend row, and the tooltip repeats every label.
 * All text wears text tokens; series colors live only on marks/chips.
 */
const MetricChart = ({
  title,
  series,
  format
}: {
  title: string;
  series: TSeries[];
  format: (v: number) => string;
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { t0, t1, yMax, paths, areas, count } = useMemo(() => {
    const all = series.flatMap((s) => s.points);
    const t0 = Math.min(...all.map((p) => p.ts));
    const t1 = Math.max(...all.map((p) => p.ts));
    const yMax = niceMax(Math.max(...all.map((p) => p.v)) * 1.05);
    const span = Math.max(1, t1 - t0);
    const h = VIEW_H - PAD_Y * 2;

    const x = (ts: number) => ((ts - t0) / span) * VIEW_W;
    const y = (v: number) => PAD_Y + (1 - v / yMax) * h;

    const paths = series.map((s) =>
      s.points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`)
        .join(' ')
    );
    const areas = series.map((s, i) =>
      series.length === 1 && s.points.length > 1
        ? `${paths[i]} L${VIEW_W},${VIEW_H - PAD_Y} L0,${VIEW_H - PAD_Y} Z`
        : null
    );
    return { t0, t1, yMax, paths, areas, count: series[0]?.points.length ?? 0 };
  }, [series]);

  const onMove = (e: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || count < 2) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHoverIdx(Math.round(ratio * (count - 1)));
  };

  const hover =
    hoverIdx !== null && series[0]?.points[hoverIdx] !== undefined
      ? {
          ts: series[0].points[hoverIdx]!.ts,
          xPct:
            ((series[0].points[hoverIdx]!.ts - t0) / Math.max(1, t1 - t0)) * 100
        }
      : null;

  const time = (ts: number) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="mb-2 flex items-center gap-3">
        <p className="text-xs font-medium text-foreground">{title}</p>
        {series.length > 1 && (
          <div className="flex items-center gap-3">
            {series.map((s) => (
              <span key={s.label} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {series
            .map((s) => {
              const last = s.points[s.points.length - 1];
              return last ? format(last.v) : '—';
            })
            .join(' · ')}
        </span>
      </div>

      <div
        ref={wrapRef}
        className="relative"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="h-32 w-full"
        >
          {[0.25, 0.5, 0.75].map((f) => (
            <line
              key={f}
              x1={0}
              x2={VIEW_W}
              y1={PAD_Y + (VIEW_H - PAD_Y * 2) * f}
              y2={PAD_Y + (VIEW_H - PAD_Y * 2) * f}
              stroke="var(--border)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {series.map((s, i) => (
            <g key={s.label}>
              {areas[i] && (
                <path d={areas[i]!} fill={s.color} fillOpacity={0.12} stroke="none" />
              )}
              <path
                d={paths[i]!}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
        </svg>

        {hover && (
          <>
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-foreground/30"
              style={{ left: `${hover.xPct}%` }}
            />
            <div
              className="pointer-events-none absolute top-0 z-10 rounded-md border border-border bg-popover px-2 py-1 text-[10px] shadow-md"
              style={
                hover.xPct > 55
                  ? { right: `${100 - hover.xPct + 2}%` }
                  : { left: `${hover.xPct + 2}%` }
              }
            >
              <p className="text-muted-foreground">{time(hover.ts)}</p>
              {series.map((s) => (
                <p key={s.label} className="flex items-center gap-1 text-foreground">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                  {s.label}:{' '}
                  {s.points[hoverIdx!] ? format(s.points[hoverIdx!]!.v) : '—'}
                </p>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{count > 0 ? time(t0) : ''}</span>
        <span>0 – {format(yMax)}</span>
        <span>{count > 0 ? time(t1) : ''}</span>
      </div>
    </div>
  );
};

export { MetricChart };
export type { TPoint, TSeries };
