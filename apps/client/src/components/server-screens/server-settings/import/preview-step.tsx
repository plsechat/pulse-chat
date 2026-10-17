import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { TImportJobView, TImportPreview } from '@pulse/server/types';
import { AlertTriangle } from 'lucide-react';
import { memo } from 'react';
import { formatCount, formatDuration } from './format';

type TPreviewStepProps = {
  job: TImportJobView;
  preview: TImportPreview | null;
  busy: string | null;
  onReload: () => Promise<void>;
  onBack: () => void;
  onNext: () => void;
};

const Row = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <tr className="border-b border-border last:border-0">
    <td className="py-2 pr-4 text-sm text-muted-foreground">{label}</td>
    <td className="py-2 text-right text-sm font-medium tabular-nums">{value}</td>
    <td className="py-2 pl-4 text-xs text-muted-foreground">{hint ?? ''}</td>
  </tr>
);

/**
 * Step 3. What comes over, as a table, with the estimate called an
 * estimate and every warning spelled out before the owner commits.
 */
const PreviewStep = memo(({ job, preview, busy, onReload, onBack, onNext }: TPreviewStepProps) => {
  const guild = preview?.guild ?? job.guild;

  return (
    <Card>
      <CardHeader>
        <CardTitle>What comes over</CardTitle>
        <CardDescription>
          {guild ? `Here is what ${guild.name} contains. ` : ''}
          Nothing is copied yet — you pick the details next.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!preview && (
          <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
            The counts were taken earlier. Load them again to see them here.
            <div className="mt-3">
              <Button variant="outline" size="sm" onClick={onReload} disabled={busy !== null}>
                Load the counts
              </Button>
            </div>
          </div>
        )}

        {preview && (
          <>
            <table className="w-full">
              <tbody>
                <Row label="Categories" value={formatCount(preview.counts.categories)} />
                <Row
                  label="Channels"
                  value={formatCount(preview.counts.channels.text + preview.counts.channels.voice + preview.counts.channels.forum)}
                  hint={`${preview.counts.channels.text} text · ${preview.counts.channels.voice} voice · ${preview.counts.channels.forum} forum${preview.counts.channels.skipped > 0 ? ` · ${preview.counts.channels.skipped} skipped` : ''}`}
                />
                <Row label="Roles" value={formatCount(preview.counts.roles)} />
                <Row label="Custom emoji" value={formatCount(preview.counts.emojis)} />
                <Row label="Members" value={formatCount(preview.counts.members)} />
                <Row label="Threads" value={formatCount(preview.counts.threads)} hint="active now; archived ones are found during the run" />
                <Row label="Messages" value={`~${formatCount(preview.counts.estimatedMessages)}`} hint="estimate" />
                <Row label="Upcoming events" value={formatCount(preview.counts.scheduledEvents)} />
                <Row label="Time to bring everything over" value={formatDuration(preview.estimatedSeconds)} hint="estimate; you can close this screen meanwhile" />
              </tbody>
            </table>

            {preview.warnings.length > 0 && (
              <Alert>
                <AlertTriangle className="h-4 w-4" aria-hidden />
                <AlertTitle>Good to know</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc space-y-1 pl-4">
                    {preview.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                  {preview.unreadableChannels.length > 0 && (
                    <p className="mt-2">
                      Channels the bot cannot read: {preview.unreadableChannels.map((name) => `#${name}`).join(', ')}
                    </p>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onBack} disabled={busy !== null}>
            Back
          </Button>
          <Button onClick={onNext} disabled={busy !== null || !preview}>
            Next: options
          </Button>
        </div>
      </CardContent>
    </Card>
  );
});

export { PreviewStep };
