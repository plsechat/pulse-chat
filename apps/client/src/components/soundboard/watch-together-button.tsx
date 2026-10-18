import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover';
import {
  useCurrentVoiceChannelId,
  useCurrentVoiceKind
} from '@/features/server/channels/hooks';
import { usePluginCommands } from '@/features/server/plugins/hooks';
import { WATCH_TOGETHER_PLUGIN_ID } from '@/features/server/voice/watch-together';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getVoiceTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { MonitorPlay } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';

type TWatchTogetherButtonProps = {
  buttonClassName?: string;
  side?: 'top' | 'bottom';
};

/**
 * The voice-controls entry to the watch-together plugin: a small form
 * that runs the plugin's `/watch <address>` command for the current
 * room. Only rendered while the plugin has its command registered on
 * this instance (the commands map the server publishes) and the user
 * is in a server voice channel; the command itself is still gated by
 * the server (plugin commands enabled for the community, the Execute
 * plugin commands permission).
 */
const WatchTogetherButton = memo(
  ({ buttonClassName, side = 'top' }: TWatchTogetherButtonProps) => {
    const channelId = useCurrentVoiceChannelId();
    const kind = useCurrentVoiceKind();
    const commands = usePluginCommands();
    const [open, setOpen] = useState(false);
    const [url, setUrl] = useState('');
    const [busy, setBusy] = useState(false);

    const available = (commands[WATCH_TOGETHER_PLUGIN_ID] ?? []).some(
      (c) => c.name === 'watch'
    );

    const submit = useCallback(async () => {
      const address = url.trim();
      if (!address || busy) return;
      const trpc = getVoiceTRPCClient();
      if (!trpc) return;

      setBusy(true);
      try {
        await trpc.plugins.executeCommand.mutate({
          pluginId: WATCH_TOGETHER_PLUGIN_ID,
          commandName: 'watch',
          args: { url: address }
        });
        setUrl('');
        setOpen(false);
        toast.success('Playing for everyone in the room');
      } catch (error) {
        toast.error(getTrpcError(error, 'Could not start playback'));
      } finally {
        setBusy(false);
      }
    }, [url, busy]);

    if (!available || !channelId || kind !== 'channel') return null;

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              'rounded-md transition-all duration-200',
              open
                ? 'bg-sky-500/15 text-sky-400'
                : 'bg-secondary hover:bg-secondary/80 text-muted-foreground hover:text-foreground',
              buttonClassName
            )}
            title="Watch together"
            aria-label="Watch together"
            data-testid="watch-together-button"
          >
            <MonitorPlay className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent side={side} align="end" className="w-80 p-3 space-y-2">
          <div className="text-sm font-medium">Watch together</div>
          <p className="text-xs text-muted-foreground">
            Paste a YouTube link, the address of a video file (.mp4,
            .webm, …) or an HLS playlist (.m3u8). Everyone in the room
            plays it in step. Pages of other video sites cannot be played.
          </p>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onEnter={() => void submit()}
            placeholder="https://youtube.com/watch?v=… or https://…/video.mp4"
            className="h-8 text-sm"
            aria-label="Media address"
            autoFocus
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void submit()} disabled={busy || !url.trim()}>
              Play for everyone
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    );
  }
);

export { WatchTogetherButton };
