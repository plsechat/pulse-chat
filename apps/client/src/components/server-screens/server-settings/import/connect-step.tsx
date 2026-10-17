import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import type { TImportBotRequirement, TImportJobView } from '@pulse/server/types';
import { CheckCircle2, ExternalLink, Eye, EyeOff, Loader2 } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

type TRequirements = { permissions: TImportBotRequirement[]; intents: TImportBotRequirement[] };

type TConnectStepProps = {
  serverId: number;
  /** The job once the token checked out; the install link needs its bot id. */
  job: TImportJobView | null;
  busy: boolean;
  onConnect: (token: string) => Promise<boolean>;
  onNext: () => void;
};

const RequirementList = ({ title, items }: { title: string; items: TImportBotRequirement[] }) => (
  <div>
    <p className="text-sm font-medium">{title}</p>
    <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
      {items.map((item) => (
        <li key={item.name}>
          <span className="text-foreground">{item.name}</span> — {item.why}
        </li>
      ))}
    </ul>
  </div>
);

/**
 * Step 1. Three things in plain words: make a bot, switch on the two
 * intents, paste the token. "Check connection" is the only call; the
 * install link appears once we know the bot's id from it.
 */
const ConnectStep = memo(({ serverId, job, busy, onConnect, onNext }: TConnectStepProps) => {
  const [token, setToken] = useState('');
  const [reveal, setReveal] = useState(false);
  const [requirements, setRequirements] = useState<TRequirements | null>(null);
  const [installUrl, setInstallUrl] = useState<string | null>(null);

  const botId = job?.bot?.id;

  useEffect(() => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    let cancelled = false;
    trpc.import.getBotInstallUrl
      .query({ serverId, applicationId: botId })
      .then((result) => {
        if (cancelled) return;
        setRequirements({ permissions: result.permissions, intents: result.intents });
        setInstallUrl(result.url);
      })
      .catch((err) => toast.error(getTrpcError(err, 'Could not load the bot requirements')));
    return () => {
      cancelled = true;
    };
  }, [serverId, botId]);

  const check = useCallback(async () => {
    const ok = await onConnect(token.trim());
    if (ok) setToken('');
  }, [onConnect, token]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect a bot</CardTitle>
        <CardDescription>
          The import reads your community through a bot you own. It only ever reads; nothing on the other side changes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <ol className="list-decimal space-y-3 pl-5 text-sm">
          <li>
            Open the developer portal, create an application and add a bot to it. Give the bot any name — it is only used for this import.
          </li>
          <li>
            On the bot's page, switch on both <strong>privileged intents</strong> listed below, then copy its token.
          </li>
          <li>Paste the token here and check the connection. Then add the bot to your community with the link that appears.</li>
        </ol>

        {requirements && (
          <div className="grid gap-4 rounded-lg border border-border p-4 md:grid-cols-2">
            <RequirementList title="What the bot needs to be allowed" items={requirements.permissions} />
            <RequirementList title="Intents to switch on" items={requirements.intents} />
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="import-bot-token">Bot token</Label>
          <div className="flex gap-2">
            <Input
              id="import-bot-token"
              type={reveal ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the token from the Bot page"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onEnter={check}
              disabled={busy}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={reveal ? 'Hide token' : 'Show token'}
              onClick={() => setReveal((v) => !v)}
            >
              {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Stored encrypted for the import only, never shown again, and deleted when the import ends.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={check} disabled={busy || token.trim().length === 0}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            Check connection
          </Button>
          {job?.bot && (
            <span className="flex items-center gap-1.5 text-sm text-primary">
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              Connected as {job.bot.name}
            </span>
          )}
        </div>

        {job?.bot && (
          <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4">
            <p className="text-sm">
              Now add <strong>{job.bot.name}</strong> to the community you want to bring over. Approve the two
              permissions it asks for, nothing else.
            </p>
            <div className="flex flex-wrap gap-2">
              {installUrl && (
                <Button asChild variant="outline">
                  <a href={installUrl} target="_blank" rel="noreferrer noopener">
                    <ExternalLink className="mr-2 h-4 w-4" aria-hidden />
                    Add the bot to your community
                  </a>
                </Button>
              )}
              <Button onClick={onNext}>Next: choose community</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
});

export { ConnectStep };
