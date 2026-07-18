import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tooltip } from '@/components/ui/tooltip';
import { useActiveInstanceDomain } from '@/features/app/hooks';
import { useCan } from '@/features/server/hooks';
import { useOwnUserId, useUsernames } from '@/features/server/users/hooks';
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
    // Home-scoped avatars are files on the HOME instance — never route
    // them through the active federated instance's public route.
    const avatarDomain = homeScope ? undefined : instanceDomain;

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
            src={getFileUrl(file, instanceDomain)}
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
      [instanceDomain]
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
        aggregated.reactors.push({
          id: reaction.userId,
          name:
            reaction.user?.name ??
            usernames[reaction.userId] ??
            'Unknown user',
          avatar: reaction.user?.avatar ?? null
        });

        if (ownUserId && reaction.userId === ownUserId) {
          aggregated.isUserReacted = true;
        }
      });

      // sort by first reaction createdAt desc
      return Array.from(reactionMap.values()).sort(
        (a, b) => a.createdAt - b.createdAt
      );
    }, [reactions, ownUserId, usernames]);

    const renderReactorList = useCallback(
      (reaction: TAggregatedReaction): React.ReactNode => {
        const shown = reaction.reactors.slice(0, MAX_REACTORS_SHOWN);
        const overflow = reaction.count - shown.length;

        return (
          <div className="flex max-w-[220px] flex-col gap-1.5">
            <div className="flex items-center gap-1.5 border-b border-background/20 pb-1">
              {renderEmoji(reaction.emoji, reaction.file)}
              <span className="text-xs font-medium">reacted with</span>
            </div>
            {shown.map((reactor, i) => (
              <div
                key={`${reactor.id}-${i}`}
                className="flex items-center gap-2"
              >
                <Avatar className="h-5 w-5 ring-0 shadow-none">
                  <AvatarImage
                    src={getFileUrl(reactor.avatar, avatarDomain)}
                  />
                  <AvatarFallback className="bg-background/20 text-[9px] text-background">
                    {getInitialsFromName(reactor.name)}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate text-xs">{reactor.name}</span>
              </div>
            ))}
            {overflow > 0 && (
              <span className="text-xs text-background/70">
                +{overflow} more
              </span>
            )}
          </div>
        );
      },
      [renderEmoji, avatarDomain]
    );

    if (!aggregatedReactions.length) return null;

    return (
      <div className="mt-1 flex flex-wrap gap-1.5">
        {aggregatedReactions.map((reaction) => {
          return (
            <Tooltip
              content={renderReactorList(reaction)}
              key={`reaction-${reaction.emoji}`}
            >
              <button
                type="button"
                onClick={() => handleReactionClick(reaction.emoji)}
                disabled={!onToggle && !can(Permission.REACT_TO_MESSAGES)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-sm transition-all duration-150',
                  'bg-accent/40 hover:bg-accent/60',
                  'hover:scale-105 active:scale-95',
                  reaction.isUserReacted &&
                    'border border-primary bg-primary/10 hover:bg-primary/20',
                  !reaction.isUserReacted && 'border border-transparent',
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
      </div>
    );
  }
);

export { MessageReactions };
