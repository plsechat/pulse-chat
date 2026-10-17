import {
  useHomeUserById,
  useUserById
} from '@/features/server/users/hooks';
import { useChatScope } from '@/components/chat-primitives/chat-scope-context';
import { EventCard } from '@/components/chat-primitives/event-card';
import { ServerScreen } from '@/components/server-screens/screens';
import { parseEventSystemRow } from '@/features/events/system-rows';
import { Tooltip } from '@/components/ui/tooltip';
import { useChannelById } from '@/features/server/channels/hooks';
import { useCan } from '@/features/server/hooks';
import { openServerScreen } from '@/features/server-screens/actions';
import { getDisplayName } from '@/helpers/get-display-name';
import { parseAutomodAlert, type TAutomodAlert } from '@/helpers/automod-alert';
import { fullDateTime } from '@/helpers/time-format';
import { Permission } from '@pulse/shared';
import { format } from 'date-fns';
import { Bot, ShieldAlert } from 'lucide-react';
import { memo } from 'react';

type SystemMessageProps = {
  message: {
    userId: number;
    content: string | null;
    createdAt: number;
  };
};

/**
 * An Auto-Mod `alert_channel` row, rendered as the notice it is rather
 * than as a chat bubble from the rule's author. Moderators who manage
 * the rules get a direct link to them.
 */
const AutomodAlert = memo(
  ({ alert, date }: { alert: TAutomodAlert; date: Date }) => {
    const offender = useUserById(alert.offenderId);
    const channel = useChannelById(alert.channelId);
    const can = useCan();
    const canManage = can(Permission.MANAGE_AUTOMOD);

    return (
      <div className="flex justify-center py-2 px-4">
        <Tooltip content={format(date, fullDateTime())}>
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/40 border border-border rounded-lg px-4 py-2 max-w-lg select-none shadow-sm">
            <Bot className="h-4 w-4 shrink-0 text-primary" />
            <span>
              Auto-Mod rule <strong>{alert.ruleName}</strong> blocked a message
              from{' '}
              <strong>
                {offender ? getDisplayName(offender) : 'a member'}
              </strong>{' '}
              in <strong>#{channel?.name ?? 'a channel'}</strong>
              {canManage && (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={() =>
                      openServerScreen(ServerScreen.SERVER_SETTINGS, {
                        initialSection: 'automod'
                      })
                    }
                  >
                    Review rules
                  </button>
                </>
              )}
            </span>
          </div>
        </Tooltip>
      </div>
    );
  }
);

const SystemMessage = memo(({ message }: SystemMessageProps) => {
  // Identity-reset banners appear in DMs (home-space userId); resolve
  // against the home roster when scoped so the name is right under a
  // federated server.
  const { homeScope } = useChatScope();
  const ambientUser = useUserById(message.userId);
  const homeUser = useHomeUserById(message.userId);
  const user = homeScope ? homeUser : ambientUser;
  const date = new Date(message.createdAt);

  if (message.content === 'identity_reset') {
    return (
      <div className="flex justify-center py-2 px-4">
        <Tooltip content={format(date, fullDateTime())}>
          <div className="flex items-center gap-2 text-xs text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-2 max-w-lg select-none backdrop-blur-sm shadow-sm">
            <ShieldAlert className="h-4 w-4 shrink-0 animate-pulse" />
            <span>
              <strong>{user?.name ?? 'Unknown user'}</strong>
              {"'s encryption keys have changed. This may mean they reinstalled the app or reset their keys."}
            </span>
          </div>
        </Tooltip>
      </div>
    );
  }

  const alert = parseAutomodAlert(message.content);
  if (alert) {
    return <AutomodAlert alert={alert} date={date} />;
  }

  // Raid planner rows: the RSVP card and the "ended" summary.
  const eventRow = parseEventSystemRow(message.content);
  if (eventRow) {
    return <EventCard row={eventRow} date={date} />;
  }

  return null;
});

export { SystemMessage };
