import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { AvatarDecoration } from '@/components/user-avatar';
import { EmojiPicker } from '@/components/emoji-picker';
import { Tooltip } from '@/components/ui/tooltip';
import { useActiveInstanceDomain } from '@/features/app/hooks';
import { useCan } from '@/features/server/hooks';
import {
  useOwnUserId,
  useUsernames,
  useUsers
} from '@/features/server/users/hooks';
import { getFileUrl } from '@/helpers/get-file-url';
import { getInitialsFromName } from '@/helpers/get-initials-from-name';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import {
  Permission,
  type TFile,
  type TReactionUser
} from '@pulse/shared';
import { gitHubEmojis } from '@tiptap/extension-emoji';
import { SmilePlus } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import { toast } from 'sonner';

type TReactionLike = {
  userId: number;
  emoji: string;
  createdAt: number;
  file: TFile | null;
  // Reactor identity, denormalized server-side. Null only when the row's
  // user no longer exists — then we fall back to the roster/Unknown.
  user?: TReactionUser | null;
};

type TReactor = {
  id: number;
  name: string;
  avatar: TReactionUser['avatar'];
  /** Equipped avatar decoration, resolved from the live roster. */
  decoration: string | null;
};

type TMessageReactionsProps = {
  messageId: number;
  reactions: TReactionLike[];
  onToggle?: (emoji: string) => void;
  /**
   * Resolve reactor avatars in HOME id-space (serve from the home
   * instance, not the active federated one). Set on DM surfaces — mirrors
   * UserAvatar's homeScope. See feedback-context-provider-scope.
   */
  homeScope?: boolean;
};

type TAggregatedReaction = {
  emoji: string;
  count: number;
  reactors: TReactor[];
  isUserReacted: boolean;
  createdAt: number;
  file: TFile | null;
};

// Cap the hover list so a wildly-reacted message can't render a
// screen-tall tooltip; the rest collapse into a "+N more" line.
const MAX_REACTORS_SHOWN = 20;

const MessageReactions = memo(
  ({ messageId, reactions, onToggle, homeScope = false }: TMessageReactionsProps) => {
    const ownUserId = useOwnUserId();
    const instanceDomain = useActiveInstanceDomain() ?? undefined;
    const can = useCan();
    const usernames = useUsernames();
    const users = useUsers();
    // Live roster lookup for avatar/decoration freshness. Skipped when a
    // federated server is active on a home-scoped surface — the roster
    // then holds the REMOTE id-space and would resolve the wrong people.
    const liveUserById = useMemo(() => {
      if (homeScope && instanceDomain) return new Map<number, (typeof users)[number]>();
      return new Map(users.map((u) => [u.id, u]));
    }, [users, homeScope, instanceDomain]);
    // Home-scoped files (reactor avatars AND custom-emoji images) live on
    // the HOME instance — never route them through the active federated
    // instance's public route, or they 404 to the text fallback.
    const fileDomain = homeScope ? undefined : instanceDomain;

    const handleReactionClick = useCallback(
      async (emoji: string) => {
        if (!ownUserId) return;

        if (onToggle) {
          onToggle(emoji);
          return;
        }

        const trpc = getTRPCClient();
        if (!trpc) return;

        try {
          await trpc.messages.toggleReaction.mutate({
            messageId,
            emoji
          });
        } catch (error) {
          toast.error(getTrpcError(error, 'Failed to toggle reaction'));
        }
      },
      [messageId, ownUserId, onToggle]
    );

    const renderEmoji = useCallback(
      (emojiName: string, file: TFile | null): React.ReactNode => {
        const gitHubEmoji = gitHubEmojis.find(
          (e) =>
            e.name === emojiName || e.shortcodes.includes(emojiName)
        );

        if (gitHubEmoji?.emoji) {
          return <span className="text-lg">{gitHubEmoji.emoji}</span>;
        }

        return (
          <img
            src={getFileUrl(file, fileDomain)}
            alt={`:${emojiName}:`}
            className="w-5 h-5 object-contain"
            onError={(e) => {
              // Fallback to text if image fails to load
              const target = e.target as HTMLImageElement;

              target.outerHTML = `<span class="text-xs text-muted-foreground">:${emojiName}:</span>`;
            }}
          />
        );
      },
      [fileDomain]
    );

    const aggregatedReactions = useMemo((): TAggregatedReaction[] => {
      const reactionMap = new Map<string, TAggregatedReaction>();

      reactions.forEach((reaction) => {
        if (!reactionMap.has(reaction.emoji)) {
          reactionMap.set(reaction.emoji, {
            emoji: reaction.emoji,
            count: 0,
            reactors: [],
            isUserReacted: false,
            createdAt: reaction.createdAt,
            file: reaction.file
          });
        }

        const aggregated = reactionMap.get(reaction.emoji)!;

        aggregated.count++;
        // Prefer the server-sent identity (correct in DMs, for federated
        // shadow users, and for members who have left); fall back to the
        // ambient roster, then to a placeholder.
        const live = liveUserById.get(reaction.userId);
        aggregated.reactors.push({
          id: reaction.userId,
          name:
            reaction.user?.name ??
            usernames[reaction.userId] ??
            'Unknown user',
          // Prefer the LIVE avatar (server-sent copies go stale the
          // moment someone changes theirs), fall back to the denormalized
          // reaction identity for DMs/federated/departed reactors.
          avatar: live?.avatar ?? reaction.user?.avatar ?? null,
          decoration: live?.avatarDecoration ?? null
        });

        if (ownUserId && reaction.userId === ownUserId) {
          aggregated.isUserReacted = true;
        }
      });

      // sort by first reaction createdAt desc
      return Array.from(reactionMap.values()).sort(
        (a, b) => a.createdAt - b.createdAt
      );
    }, [reactions, ownUserId, usernames, liveUserById]);

    const renderReactorList = useCallback(
      (reaction: TAggregatedReaction): React.ReactNode => {
        const shown = reaction.reactors.slice(0, MAX_REACTORS_SHOWN);
        const overflow = reaction.count - shown.length;

        return (
          <div className="flex max-w-[220px] flex-col gap-1.5">
            <div className="flex items-center justify-center gap-1.5 border-b border-border pb-1.5">
              {renderEmoji(reaction.emoji, reaction.file)}
              <span className="text-xs text-muted-foreground">
                :{reaction.emoji}:
              </span>
            </div>
            {shown.map((reactor, i) => (
              <div
                key={`${reactor.id}-${i}`}
                className="flex items-center gap-2"
              >
                {/* Sized past the >=28px decoration gate so equipped
                    decorations render (and animate) here; the name stays
                    deliberately unstyled. */}
                <div className="relative h-7 w-7 shrink-0">
                  <Avatar className="h-7 w-7 ring-0 shadow-none">
                    <AvatarImage
                      src={getFileUrl(reactor.avatar, fileDomain)}
                    />
                    <AvatarFallback className="bg-muted text-[9px] text-muted-foreground">
                      {getInitialsFromName(reactor.name)}
                    </AvatarFallback>
                  </Avatar>
                  <AvatarDecoration decoration={reactor.decoration} />
                </div>
                <span className="truncate text-xs">{reactor.name}</span>
              </div>
            ))}
            {overflow > 0 && (
              <span className="text-xs text-muted-foreground">
                +{overflow} more
              </span>
            )}
          </div>
        );
      },
      [renderEmoji, fileDomain]
    );

    if (!aggregatedReactions.length) return null;

    return (
      <div className="mt-1 flex flex-wrap gap-1.5">
        {aggregatedReactions.map((reaction) => {
          return (
            <Tooltip
              content={renderReactorList(reaction)}
              key={`reaction-${reaction.emoji}`}
              className="bg-popover text-popover-foreground border border-border shadow-lg rounded-lg px-3 py-2.5"
              showArrow={false}
            >
              <button
                type="button"
                onClick={() => handleReactionClick(reaction.emoji)}
                disabled={!onToggle && !can(Permission.REACT_TO_MESSAGES)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm transition-colors duration-150',
                  'bg-accent/40 hover:bg-accent/60',
                  reaction.isUserReacted &&
                    'border border-primary/40 bg-primary/15 hover:border-primary/60 hover:bg-primary/20',
                  !reaction.isUserReacted &&
                    'border border-transparent hover:border-border/60',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
              >
                {renderEmoji(reaction.emoji, reaction.file)}
                <span className="font-medium text-foreground/80">
                  {reaction.count}
                </span>
              </button>
            </Tooltip>
          );
        })}
        {(!!onToggle || can(Permission.REACT_TO_MESSAGES)) && (
          <EmojiPicker
            onEmojiSelect={(emoji) => handleReactionClick(emoji.name)}
          >
            <button
              type="button"
              title="Add Reaction"
              className="inline-flex items-center rounded-lg border border-transparent bg-accent/40 px-2 py-1 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 hover:bg-accent/60 transition-[opacity,background-color] duration-150"
            >
              <SmilePlus className="h-4 w-4 text-muted-foreground" />
            </button>
          </EmojiPicker>
        )}
      </div>
    );
  }
);

export { MessageReactions };
