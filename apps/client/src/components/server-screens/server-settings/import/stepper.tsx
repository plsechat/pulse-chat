import type { TWizardStep } from '@/features/server/import/hooks';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';
import { memo } from 'react';

const STEPS: { id: TWizardStep; label: string }[] = [
  { id: 'connect', label: 'Connect' },
  { id: 'choose', label: 'Choose' },
  { id: 'preview', label: 'Preview' },
  { id: 'options', label: 'Options' },
  { id: 'running', label: 'Import' },
  { id: 'done', label: 'Done' }
];

/** Six dots with labels; the current one is lit, the ones behind it are ticked. */
const Stepper = memo(({ current }: { current: TWizardStep }) => {
  const index = STEPS.findIndex((s) => s.id === current);

  return (
    <ol className="flex items-center gap-1 overflow-x-auto pb-1" aria-label="Import steps">
      {STEPS.map((step, i) => {
        const done = i < index;
        const active = i === index;
        return (
          <li key={step.id} className="flex items-center gap-1" aria-current={active ? 'step' : undefined}>
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                active && 'bg-primary text-primary-foreground',
                done && 'bg-primary/20 text-primary',
                !active && !done && 'bg-muted text-muted-foreground'
              )}
            >
              {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
            </span>
            <span className={cn('text-xs font-medium', active ? 'text-foreground' : 'text-muted-foreground')}>
              {step.label}
            </span>
            {i < STEPS.length - 1 && <span className="mx-1 h-px w-4 bg-border" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
});

export { Stepper };
