import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { useActiveInstanceDomain } from '@/features/app/hooks';
import { sendDmMessage } from '@/features/dms/actions';
import { useDmChannels } from '@/features/dms/hooks';
import { useChannels } from '@/features/server/channels/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { stripToPlainText } from '@/helpers/strip-to-plain-text';
import { tiptapHtmlToTokens } from '@/lib/converters/tiptap-to-tokens';
import { FORWARD_MESSAGE_EVENT } from '@/lib/events';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Check, Hash, Loader2, Search } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

/**
 * Forward a message to DMs and/or channels — opened from the message
 * context menu via FORWARD_MESSAGE_EVENT (module-event pattern, same as
 * mention-user: the context menu unmounts when it closes, so it can't own
 * the dialog itself).
 *
 * Scope notes:
 * - Targets are HOME DMs plus TEXT channels of the ACTIVE server. Channels
 *   on other instances need their own socket — out of scope here.
 * - E2EE targets are excluded: forwarding raw tokens through the plain
 *   send path would either fail or, worse, write plaintext into an
 *   encrypted channel. The list says so rather than hiding them silently.
 * - Attachments are not forwarded (content only).
 */

type TTarget =
  | { kind: 'dm'; id: number; label: string; avatarUserId?: number }
  | { kind: 'channel'; id: number; label: string };

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const ForwardMessageDialog = memo(() => {
  const [content, setContent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  const ownUserId = useOwnUserId();
  const dmChannels = useDmChannels();
  const channels = useChannels();
  const activeInstanceDomain = useActiveInstanceDomain();

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ content: string | null }>).detail;
      if (!detail?.content) return;
      setContent(detail.content);
      setQuery('');
      setNote('');
      setSelected(new Set());
      setOpen(true);
    };
    window.addEventListener(FORWARD_MESSAGE_EVENT, handler);
    return () => window.removeEventListener(FORWARD_MESSAGE_EVENT, handler);
  }, []);

  const excludedE2ee = useMemo(
    () =>
      dmChannels.filter((c) => c.e2ee).length +
      channels.filter((c) => c.type === 'TEXT' && c.e2ee).length,
    [dmChannels, channels]
  );

  const targets = useMemo<TTarget[]>(() => {
    const dms: TTarget[] = dmChannels
      .filter((c) => !c.e2ee)
      .map((c) => {
        const others = c.members.filter((m) => m.id !== ownUserId);
        const label =
          c.isGroup && c.name
            ? c.name
            : others.map((m) => getDisplayName(m)).join(', ') || 'Empty DM';
        return {
          kind: 'dm' as const,
          id: c.id,
          label,
          avatarUserId: others[0]?.id
        };
      });
    // Channels on a federated instance ride a different socket than the
    // one messages.send talks to — active LOCAL server only.
    const chs: TTarget[] = activeInstanceDomain
      ? []
      : channels
          .filter((c) => c.type === 'TEXT' && !c.e2ee)
          .map((c) => ({ kind: 'channel' as const, id: c.id, label: c.name }));
    return [...chs, ...dms];
  }, [dmChannels, channels, ownUserId, activeInstanceDomain]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter((t) => t.label.toLowerCase().includes(q));
  }, [targets, query]);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSend = useCallback(async () => {
    if (!content || selected.size === 0) return;
    setSending(true);
    const noteTokens = note.trim()
      ? tiptapHtmlToTokens(`<p>${escapeHtml(note.trim())}</p>`)
      : null;
    let ok = 0;
    let failed = 0;

    for (const key of selected) {
      const [kind, idStr] = key.split(':');
      const id = Number(idStr);
      try {
        if (kind === 'dm') {
          if (noteTokens) await sendDmMessage(id, noteTokens);
          await sendDmMessage(id, content);
        } else {
          const trpc = getTRPCClient();
          if (!trpc) throw new Error('Not connected');
          if (noteTokens) {
            await trpc.messages.send.mutate({
              content: noteTokens,
              channelId: id
            });
          }
          await trpc.messages.send.mutate({ content, channelId: id });
        }
        ok++;
      } catch (err) {
        failed++;
        const label = targets.find((t) => `${t.kind}:${t.id}` === key)?.label;
        toast.error(
          getTrpcError(err, `Failed to forward to ${label ?? 'target'}`)
        );
      }
    }

    setSending(false);
    if (ok > 0) {
      toast.success(
        ok === 1 ? 'Message forwarded' : `Message forwarded to ${ok} places`
      );
    }
    if (failed === 0) setOpen(false);
  }, [content, selected, note, targets]);

  const preview = useMemo(
    () => (content ? stripToPlainText(content).slice(0, 140) : ''),
    [content]
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md p-0 gap-0">
        <DialogHeader className="p-4 pb-2">
          <DialogTitle>Forward To</DialogTitle>
          <DialogDescription>
            Select where you want to share this message.
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>

        <div className="max-h-72 min-h-32 overflow-y-auto px-2.5 py-1">
          {visible.length === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No destinations match
            </p>
          )}
          {visible.map((t) => {
            const key = `${t.kind}:${t.id}`;
            const isSelected = selected.has(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggle(key)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-100',
                  isSelected ? 'bg-accent' : 'hover:bg-accent/50'
                )}
              >
                {t.kind === 'channel' ? (
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                    <Hash className="h-4 w-4 text-muted-foreground" />
                  </span>
                ) : t.avatarUserId ? (
                  <UserAvatar
                    userId={t.avatarUserId}
                    className="h-8 w-8 shrink-0"
                    homeScope
                  />
                ) : (
                  <span className="h-8 w-8 shrink-0 rounded-full bg-muted" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {t.kind === 'channel' ? `#${t.label}` : t.label}
                </span>
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors duration-100',
                    isSelected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border'
                  )}
                >
                  {isSelected && <Check className="h-3.5 w-3.5" />}
                </span>
              </button>
            );
          })}
          {excludedE2ee > 0 && (
            <p className="px-2.5 py-2 text-[11px] text-muted-foreground/70">
              {excludedE2ee} encrypted destination
              {excludedE2ee === 1 ? '' : 's'} hidden — forwarding into
              end-to-end encrypted chats isn't supported yet.
            </p>
          )}
        </div>

        {preview && (
          <div className="mx-4 border-l-2 border-border pl-3 py-1">
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {preview}
            </p>
          </div>
        )}

        <div className="flex items-center gap-2 p-4 pt-3">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add an optional message…"
            className="min-w-0 flex-1 rounded-lg bg-secondary px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
          />
          <Button
            onClick={handleSend}
            disabled={selected.size === 0 || sending}
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
});

ForwardMessageDialog.displayName = 'ForwardMessageDialog';

export { ForwardMessageDialog };
