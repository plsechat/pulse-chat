import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requestConfirmation } from '@/features/dialogs/actions';
import { cn } from '@/lib/utils';
import type { TImportJobView, TImportStep } from '@pulse/server/types';
import { AlertCircle, Check, Loader2, Pause, Play, RotateCcw, XCircle } from 'lucide-react';
import { memo, useCallback } from 'react';
import { formatCount, STEP_LABELS, STEP_ORDER } from './format';

type TRunningStepProps = {
  job: TImportJobView;
  busy: string | null;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onCancel: () => Promise<void>;
  onRetry: () => Promise<void>;
};

const stepState = (job: TImportJobView, step: TImportStep): 'done' | 'active' | 'waiting' => {
  if (job.progress.stepsDone.includes(step)) return 'done';
  if (job.step === step) return 'active';
  return 'waiting';
};

const StepRow = ({ job, step }: { job: TImportJobView; step: TImportStep }) => {
  const state = stepState(job, step);
  const counts = job.progress.counts[step];
  const live = state === 'active' && job.status === 'running';
  const total = counts?.total ?? null;
  const percent = counts && total ? Math.min(100, Math.round((counts.done / total) * 100)) : null;

  return (
    <li className="flex items-center gap-3 py-2">
      <span
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
          state === 'done' && 'bg-primary/20 text-primary',
          state === 'active' && 'bg-primary text-primary-foreground',
          state === 'waiting' && 'bg-muted text-muted-foreground'
        )}
      >
        {state === 'done' ? (
          <Check className="h-3.5 w-3.5" aria-hidden />
        ) : live ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-sm', state === 'waiting' ? 'text-muted-foreground' : 'text-foreground')}>
          {STEP_LABELS[step]}
        </span>
        {percent !== null && state === 'active' && (
          <span className="mt-1 block h-1 w-full overflow-hidden rounded bg-muted" aria-hidden>
            <span className="block h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
          </span>
        )}
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">
        {counts
          ? `${formatCount(counts.done)}${total !== null ? ` / ${formatCount(total)}` : ''}${counts.skipped > 0 ? ` · ${counts.skipped} skipped` : ''}`
          : ''}
        {step === 'messages' && (job.progress.attachments.done > 0 || job.progress.attachments.failed > 0)
          ? ` · ${formatCount(job.progress.attachments.done)} files${job.progress.attachments.failed > 0 ? `, ${job.progress.attachments.failed} failed` : ''}`
          : ''}
      </span>
    </li>
  );
};

const STATUS_COPY: Record<TImportJobView['status'], { title: string; description: string }> = {
  pending: { title: 'Getting ready', description: 'The import is about to start.' },
  running: { title: 'Importing…', description: 'You can close this screen; the import keeps going and picks up where it left off after a restart.' },
  paused: { title: 'Paused', description: 'Nothing is being copied right now. Resume whenever you like.' },
  failed: { title: 'The import stopped', description: 'Something went wrong. Everything imported so far is kept; retry continues from there.' },
  cancelled: { title: 'Cancelled', description: 'The import was cancelled. What had arrived stays.' },
  done: { title: 'Done', description: '' }
};

/** Step 5. Live per-step progress, the controls, and the errors with a retry. */
const RunningStep = memo(({ job, busy, onPause, onResume, onCancel, onRetry }: TRunningStepProps) => {
  const copy = STATUS_COPY[job.status];

  const confirmCancel = useCallback(async () => {
    const yes = await requestConfirmation({
      title: 'Cancel the import?',
      message: 'What has already been brought over stays. The bot connection is deleted; you would start again from the first step.',
      confirmLabel: 'Cancel the import',
      cancelLabel: 'Keep going',
      variant: 'danger'
    });
    if (yes) await onCancel();
  }, [onCancel]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>
          {job.guild ? `${job.guild.name} → this server. ` : ''}
          {copy.description}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {job.status === 'failed' && job.error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" aria-hidden />
            <AlertTitle>What went wrong</AlertTitle>
            <AlertDescription>{job.error}</AlertDescription>
          </Alert>
        )}

        <ol className="divide-y divide-border rounded-lg border border-border px-3">
          {STEP_ORDER.map((step) => (
            <StepRow key={step} job={job} step={step} />
          ))}
        </ol>

        <div className="flex flex-wrap gap-2">
          {job.status === 'running' && (
            <Button variant="outline" onClick={onPause} disabled={busy !== null}>
              <Pause className="mr-2 h-4 w-4" aria-hidden /> Pause
            </Button>
          )}
          {job.status === 'paused' && (
            <Button onClick={onResume} disabled={busy !== null}>
              <Play className="mr-2 h-4 w-4" aria-hidden /> Resume
            </Button>
          )}
          {job.status === 'failed' && (
            <Button onClick={onRetry} disabled={busy !== null}>
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden /> Retry from where it stopped
            </Button>
          )}
          {(job.status === 'running' || job.status === 'paused' || job.status === 'failed') && (
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={confirmCancel} disabled={busy !== null}>
              <XCircle className="mr-2 h-4 w-4" aria-hidden /> Cancel
            </Button>
          )}
        </div>

        {job.progress.errors.length > 0 && (
          <details className="rounded-lg border border-border p-3 text-sm">
            <summary className="cursor-pointer font-medium">
              {job.progress.errors.length} thing{job.progress.errors.length === 1 ? '' : 's'} could not be copied
            </summary>
            <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto text-xs text-muted-foreground">
              {job.progress.errors.map((error, i) => (
                <li key={`${error.at}-${i}`}>
                  <span className="text-foreground">{STEP_LABELS[error.step]}</span> · {error.ref}: {error.message}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              These are skipped, not fatal. A retry after a stop goes over them again.
            </p>
          </details>
        )}
      </CardContent>
    </Card>
  );
});

export { RunningStep };
