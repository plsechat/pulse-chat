import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getUrlFromServer } from '@/helpers/get-file-url';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { getRandomString } from '@pulse/shared';
import type { TImportJobView } from '@pulse/server/types';
import { Copy, PartyPopper } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';
import { formatCount, STEP_LABELS, STEP_ORDER } from './format';

type TDoneStepProps = {
  serverId: number;
  job: TImportJobView;
  onStartOver: () => Promise<void>;
};

/**
 * Step 6. The summary, an invite link made on the spot, and the one
 * sentence members need to hear: sign in with the same account and
 * your messages are yours.
 */
const DoneStep = memo(({ serverId, job, onStartOver }: TDoneStepProps) => {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const createInvite = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    setCreating(true);
    try {
      const invite = await trpc.invites.add.mutate({
        serverId,
        maxUses: 0,
        expiresAt: null,
        code: getRandomString(24)
      });
      setInviteUrl(`${getUrlFromServer()}/?invite=${invite.code}`);
    } catch (err) {
      toast.error(getTrpcError(err, 'Could not create an invite'));
    } finally {
      setCreating(false);
    }
  }, [serverId]);

  const copy = useCallback(() => {
    if (!inviteUrl) return;
    navigator.clipboard.writeText(inviteUrl);
    toast.success('Invite link copied');
  }, [inviteUrl]);

  const rows = STEP_ORDER.filter((step) => job.progress.counts[step]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PartyPopper className="h-5 w-5 text-primary" aria-hidden />
          Your community is here
        </CardTitle>
        <CardDescription>
          {job.guild ? `${job.guild.name} has been brought over. ` : ''}
          Here is what arrived.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <table className="w-full">
          <tbody>
            {rows.map((step) => {
              const counts = job.progress.counts[step]!;
              return (
                <tr key={step} className="border-b border-border last:border-0">
                  <td className="py-2 pr-4 text-sm text-muted-foreground">{STEP_LABELS[step]}</td>
                  <td className="py-2 text-right text-sm font-medium tabular-nums">{formatCount(counts.done)}</td>
                  <td className="py-2 pl-4 text-xs text-muted-foreground">
                    {counts.skipped > 0 ? `${counts.skipped} skipped` : ''}
                    {step === 'messages' && job.progress.attachments.done > 0 ? ` · ${formatCount(job.progress.attachments.done)} files` : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {job.progress.errors.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {job.progress.errors.length} item{job.progress.errors.length === 1 ? '' : 's'} could not be copied — a few files or emoji, usually. The rest is in place.
          </p>
        )}

        <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4">
          <p className="text-sm font-medium">Invite your members</p>
          <p className="text-sm text-muted-foreground">
            Members who sign in with the same account they used over there automatically keep their messages — no setup on their side.
          </p>
          {inviteUrl ? (
            <div className="flex gap-2">
              <Input readOnly value={inviteUrl} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
              <Button variant="outline" size="icon" aria-label="Copy invite link" onClick={copy}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <Button onClick={createInvite} disabled={creating}>
              Create an invite link
            </Button>
          )}
        </div>

        <Button variant="outline" onClick={onStartOver}>
          Import another community
        </Button>
      </CardContent>
    </Card>
  );
});

export { DoneStep };
