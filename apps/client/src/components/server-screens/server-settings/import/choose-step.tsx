import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import type { TImportGuildSummary } from '@pulse/server/types';
import { Loader2, RefreshCw, Users } from 'lucide-react';
import { memo, useEffect } from 'react';
import { formatCount } from './format';

type TChooseStepProps = {
  guilds: TImportGuildSummary[] | null;
  busy: string | null;
  onLoad: () => Promise<void>;
  onChoose: (guildId: string) => Promise<void>;
  onBack: () => void;
};

/** Step 2. Every community the bot has been added to; pick one. */
const ChooseStep = memo(({ guilds, busy, onLoad, onChoose, onBack }: TChooseStepProps) => {
  useEffect(() => {
    if (guilds === null) onLoad();
  }, [guilds, onLoad]);

  const loading = busy === 'guilds';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose your community</CardTitle>
        <CardDescription>
          These are the communities the bot has been added to. Not seeing yours? Add the bot there first, then refresh.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Looking up your communities…
          </div>
        )}

        {!loading && guilds && guilds.length === 0 && (
          <EmptyState
            icon={Users}
            title="The bot isn't in any community yet"
            description="Use the install link from the previous step, then come back and refresh."
            size="sm"
          />
        )}

        {!loading && guilds && guilds.length > 0 && (
          <ul className="grid gap-2 sm:grid-cols-2">
            {guilds.map((guild) => (
              <li key={guild.id}>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => onChoose(guild.id)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    busy === 'preview' && 'opacity-60'
                  )}
                >
                  {guild.iconUrl ? (
                    <img src={guild.iconUrl} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
                  ) : (
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-semibold">
                      {guild.name.slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{guild.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {formatCount(guild.approximateMemberCount)} members
                      {guild.approximatePresenceCount !== null && ` · ${formatCount(guild.approximatePresenceCount)} online`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onBack} disabled={busy !== null}>
            Back
          </Button>
          <Button variant="outline" onClick={onLoad} disabled={busy !== null}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            Refresh
          </Button>
          {busy === 'preview' && (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Counting what's there…
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
});

export { ChooseStep };
