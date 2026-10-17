import type {
  ServerEvents,
  StreamKind,
  TChannelUserPermissionsMap,
  TCommandsMapByPlugin,
  TExternalStream,
  TLogEntry,
  TThreadInfo,
  TVoiceKind,
  TVoiceUserState
} from '@pulse/shared';
import type {
  TCategory,
  TChannel,
  TEvent,
  TEventRosterCounts,
  TImportJobView,
  TJoinedDmMessage,
  TJoinedEmoji,
  TJoinedFriendRequest,
  TJoinedMessage,
  TJoinedPublicUser,
  TJoinedRole,
  TPollUpdate,
  TPublicServerSettings,
  TServerSummary
} from '../types';
import type { Unsubscribable } from '@trpc/server/observable';
import { observable, type Observable } from '@trpc/server/observable';
import { EventEmitter } from 'events';
import { config } from '../config';
import { logger } from '../logger';

const PUBSUB_LOG_RECIPIENT_CAP = 100;

type Events = {
  [ServerEvents.NEW_MESSAGE]: TJoinedMessage;
  [ServerEvents.MESSAGE_UPDATE]: TJoinedMessage;
  [ServerEvents.MESSAGE_DELETE]: {
    messageId: number;
    channelId: number;
  };
  [ServerEvents.MESSAGE_BULK_DELETE]: {
    messageIds: number[];
    channelId: number;
    purged?: boolean;
  };
  [ServerEvents.MESSAGE_TYPING]: {
    channelId: number;
    userId: number;
  };

  // serverPublicId is the globally-unique id of the server. Numeric ids are
  // instance-local and collide across federated instances, so clients prefer
  // the publicId for scoping when present (optional for older servers).
  // Published by the session bootstrap (others.openSession) to the
  // server's members: the user is now connected. Membership changes are
  // SERVER_MEMBER_JOIN / SERVER_MEMBER_LEAVE.
  [ServerEvents.USER_CONNECTED]: {
    serverId: number;
    serverPublicId?: string;
    user: TJoinedPublicUser;
  };
  [ServerEvents.USER_LEAVE]: number;
  [ServerEvents.USER_CREATE]: TJoinedPublicUser;
  [ServerEvents.USER_UPDATE]: TJoinedPublicUser;
  // Server-scoped: serverId is the server the user was removed from. Clients
  // ignore the event when serverId !== activeServerId so a kick in server A
  // doesn't corrupt the local roster of server B.
  [ServerEvents.USER_DELETE]: {
    serverId: number;
    serverPublicId?: string;
    userId: number;
  };

  [ServerEvents.CHANNEL_CREATE]: TChannel;
  [ServerEvents.CHANNEL_UPDATE]: TChannel;
  [ServerEvents.CHANNEL_DELETE]: number;
  [ServerEvents.CHANNEL_PERMISSIONS_UPDATE]: TChannelUserPermissionsMap;
  [ServerEvents.CHANNEL_READ_STATES_UPDATE]: {
    channelId: number;
    count: number;
    mentionCount: number;
  };

  // Roster events carry `kind` next to the numeric channelId: a server
  // voice channel and a DM call can share one id (independent serial
  // sequences), and the client keys its voice map by `${kind}:${id}`.
  [ServerEvents.USER_JOIN_VOICE]: {
    channelId: number;
    kind: TVoiceKind;
    userId: number;
    state: TVoiceUserState;
    startedAt: number;
  };
  [ServerEvents.USER_LEAVE_VOICE]: {
    channelId: number;
    kind: TVoiceKind;
    userId: number;
    startedAt?: number;
  };
  [ServerEvents.USER_VOICE_STATE_UPDATE]: {
    channelId: number;
    kind: TVoiceKind;
    userId: number;
    state: TVoiceUserState;
  };

  [ServerEvents.VOICE_NEW_PRODUCER]: {
    channelId: number;
    remoteId: number;
    kind: StreamKind;
  };
  [ServerEvents.VOICE_ADD_EXTERNAL_STREAM]: {
    channelId: number;
    streamId: number;
    stream: TExternalStream;
  };
  [ServerEvents.VOICE_UPDATE_EXTERNAL_STREAM]: {
    channelId: number;
    streamId: number;
    stream: TExternalStream;
  };
  [ServerEvents.VOICE_REMOVE_EXTERNAL_STREAM]: {
    channelId: number;
    streamId: number;
  };
  [ServerEvents.VOICE_PRODUCER_CLOSED]: {
    channelId: number;
    remoteId: number;
    kind: StreamKind;
  };

  [ServerEvents.PLUGIN_LOG]: TLogEntry;
  [ServerEvents.PLUGIN_COMMANDS_CHANGE]: TCommandsMapByPlugin;

  [ServerEvents.EMOJI_CREATE]: TJoinedEmoji;
  [ServerEvents.EMOJI_UPDATE]: TJoinedEmoji;
  [ServerEvents.EMOJI_DELETE]: number;

  [ServerEvents.ROLE_CREATE]: TJoinedRole;
  [ServerEvents.ROLE_UPDATE]: TJoinedRole;
  [ServerEvents.ROLE_DELETE]: number;

  [ServerEvents.SERVER_SETTINGS_UPDATE]: TPublicServerSettings;

  [ServerEvents.CATEGORY_CREATE]: TCategory;
  [ServerEvents.CATEGORY_UPDATE]: TCategory;
  [ServerEvents.CATEGORY_DELETE]: number;

  [ServerEvents.FRIEND_REQUEST_RECEIVED]: TJoinedFriendRequest;
  [ServerEvents.FRIEND_REQUEST_ACCEPTED]: TJoinedFriendRequest;
  [ServerEvents.FRIEND_REQUEST_REJECTED]: TJoinedFriendRequest;
  [ServerEvents.FRIEND_REMOVED]: { userId: number; friendId: number };

  [ServerEvents.DM_NEW_MESSAGE]: TJoinedDmMessage;
  [ServerEvents.DM_MESSAGE_UPDATE]: TJoinedDmMessage;
  [ServerEvents.DM_MESSAGE_DELETE]: {
    dmMessageId: number;
    dmChannelId: number;
  };
  [ServerEvents.DM_CHANNEL_UPDATE]: {
    dmChannelId: number;
    name: string | null;
    iconFileId: number | null;
  };
  [ServerEvents.DM_CHANNEL_DELETE]: {
    dmChannelId: number;
  };
  /**
   * Self-scoped: published to the reader only, so their other
   * devices/tabs drop the unread badge without a channel refetch.
   */
  [ServerEvents.DM_READ_STATE_UPDATE]: {
    dmChannelId: number;
    lastReadMessageId: number;
  };
  [ServerEvents.DM_MEMBER_ADD]: {
    dmChannelId: number;
    userId: number;
  };
  [ServerEvents.DM_MEMBER_REMOVE]: {
    dmChannelId: number;
    userId: number;
  };
  [ServerEvents.DM_CALL_STARTED]: {
    dmChannelId: number;
    startedBy: number;
  };
  [ServerEvents.DM_CALL_ENDED]: {
    dmChannelId: number;
  };
  [ServerEvents.DM_CALL_USER_JOINED]: {
    dmChannelId: number;
    userId: number;
    state: TVoiceUserState;
  };
  [ServerEvents.DM_CALL_USER_LEFT]: {
    dmChannelId: number;
    userId: number;
  };
  [ServerEvents.DM_CALL_DECLINED]: {
    dmChannelId: number;
    userId: number;
  };

  [ServerEvents.DM_MESSAGE_TYPING]: {
    dmChannelId: number;
    userId: number;
  };

  // Fanned out to EVERY member of the server (the joiner included): the
  // joiner's clients add `server` to their rail, the others add `user` to
  // their roster. `user` / `serverPublicId` are optional only for the
  // payload older servers (joiner-only publish) emitted.
  [ServerEvents.SERVER_MEMBER_JOIN]: {
    serverId: number;
    serverPublicId?: string;
    userId: number;
    server: TServerSummary;
    user?: TJoinedPublicUser;
  };
  [ServerEvents.SERVER_MEMBER_LEAVE]: {
    serverId: number;
    serverPublicId?: string;
    userId: number;
  };

  [ServerEvents.SERVER_UNREAD_COUNT_UPDATE]: {
    serverId: number;
    count: number;
    mentionCount: number;
  };

  [ServerEvents.MESSAGE_PIN]: {
    messageId: number;
    channelId: number;
    pinnedBy: number;
  };
  [ServerEvents.MESSAGE_UNPIN]: {
    messageId: number;
    channelId: number;
  };

  [ServerEvents.THREAD_CREATE]: TThreadInfo;
  [ServerEvents.THREAD_UPDATE]: TThreadInfo;
  [ServerEvents.THREAD_DELETE]: number;

  [ServerEvents.FEDERATION_INSTANCE_UPDATE]: {
    domain?: string;
    instanceId?: number;
    status: string;
  };

  // Delivered on a user's HOME instance when a federated peer kicked or
  // banned them from one of its servers — the propagation side of remote
  // moderation. The client drops the matching federatedServers entry and
  // shows the reason.
  [ServerEvents.FEDERATED_SERVER_REMOVED]: {
    instanceDomain: string;
    serverPublicId: string;
    serverName?: string;
    action: 'kick' | 'ban';
    reason?: string;
  };

  [ServerEvents.E2EE_SENDER_KEY_DISTRIBUTION]: {
    channelId: number;
    fromUserId: number;
  };

  // Phase E / E1 — emitted on a peer instance when one of its
  // local users has a fresh SKDM available on a federated host.
  // Receiver opens or reuses an active-server tRPC to `hostDomain`
  // and calls `e2ee.getPendingSenderKeys` to pull the actual SKDM.
  // `fromInstanceDomain` is the sender's *home* domain (which may
  // differ from `hostDomain` when the sender is themselves a
  // federated participant in the channel) — needed to resolve
  // their identity on the receiver's home for decrypt.
  [ServerEvents.E2EE_FEDERATED_SENDER_KEY_AVAILABLE]: {
    hostDomain: string;
    hostChannelPublicId: string;
    fromPublicId: string;
    fromInstanceDomain: string;
    senderKeyId: number;
  };

  [ServerEvents.E2EE_IDENTITY_RESET]: {
    userId: number;
    // The E2EE channels the recipient shares with the resetter, so it
    // re-distributes its sender keys on exactly those instead of
    // listing and re-keying every E2EE channel it has. Empty for a
    // DM-only peer (DM chains re-send lazily) and for a federated
    // rotation (DM scope only); the resetter's own tabs get the full
    // list.
    channelIds: number[];
    // Phase D / D3 — only set on federated rotations. The receiving
    // client uses this directly so it doesn't have to round-trip
    // back through federation just to learn the new key. Same-
    // instance rotations leave this undefined and the existing
    // Phase C client handler re-fetches via getIdentityPublicKey.
    newIdentityPublicKey?: string;
  };

  [ServerEvents.DM_SENDER_KEY_DISTRIBUTION]: {
    dmChannelId: number;
    fromUserId: number;
  };

  [ServerEvents.INVITE_CREATE]: {
    inviteId: number;
    serverId: number;
  };
  [ServerEvents.INVITE_DELETE]: {
    inviteId: number;
    serverId: number;
  };

  [ServerEvents.USER_NOTE_UPDATE]: {
    targetUserId: number;
  };

  [ServerEvents.USER_KICKED]: {
    serverId: number;
    serverPublicId?: string;
    reason?: string;
  };

  // Sent only to the blocker so their client can refresh the blocked list
  // and any cached state for the affected user. The blocked user receives
  // no notification — block disclosure is intentional only on the
  // outbound (DM/friend-request) error path.
  [ServerEvents.USER_BLOCK_CHANGED]: {
    blockedUserId: number;
    blocked: boolean;
  };

  // Scheduled community events: rows and roster counts go to every
  // member of the server; a reminder goes only to the signed-up members.
  [ServerEvents.EVENT_CREATE]: TEvent;
  [ServerEvents.EVENT_UPDATE]: TEvent;
  [ServerEvents.EVENT_DELETE]: { eventId: number; serverId: number };
  [ServerEvents.EVENT_SIGNUPS_UPDATE]: {
    eventId: number;
    serverId: number;
    counts: TEventRosterCounts;
  };
  [ServerEvents.EVENT_REMINDER]: {
    eventId: number;
    serverId: number;
    title: string;
    startsAt: number;
    stage: 1 | 2 | 3;
  };

  // Community import: the owner who started the job gets the full view
  // after every persisted page.
  [ServerEvents.IMPORT_PROGRESS]: TImportJobView;

  // Poll counts to every viewer of the channel (own votes travel only
  // through the vote routes' return values).
  [ServerEvents.POLL_UPDATE]: TPollUpdate;
  // "Refetch" pings for the Scheduled list and the Follows tab.
  [ServerEvents.SCHEDULED_POST_UPDATE]: { channelId: number };
  [ServerEvents.CHANNEL_FOLLOWS_UPDATE]: { channelId: number };
};

class PubSub {
  private ee: EventEmitter;
  private userListeners: Map<
    number,
    Map<string, Set<(data: Events[keyof Events]) => void>>
  > = new Map();
  // Keyed by the voice runtime key ("channel:5" / "dm:5"), never by the
  // bare numeric id: a DM call and a server voice channel with the same
  // id are different rooms, and sharing a topic leaked one room's
  // producer events (and participant ids) into the other.
  private channelListeners: Map<
    string,
    Map<string, Set<(data: Events[keyof Events]) => void>>
  > = new Map();

  constructor() {
    this.ee = new EventEmitter();

    this.ee.setMaxListeners(50);
  }

  public publish<TTopic extends keyof Events>(
    topic: TTopic,
    payload: Events[TTopic]
  ): void {
    this.ee.emit(topic, payload);
  }

  public publishFor<TTopic extends keyof Events>(
    userIds: number | number[],
    topic: TTopic,
    payload: Events[TTopic]
  ): void {
    const targetUserIds = Array.isArray(userIds) ? userIds : [userIds];

    if (config.server.debug && targetUserIds.length <= PUBSUB_LOG_RECIPIENT_CAP) {
      // Volume guard: skip the line for fan-outs above the cap so a
      // server-wide broadcast doesn't bury the rest of the trace.
      logger.debug(
        '[pubsub] %s recipients=%d',
        String(topic),
        targetUserIds.length
      );
    }

    for (const userId of targetUserIds) {
      const userTopics = this.userListeners.get(userId);

      if (!userTopics) continue;

      const listeners = userTopics.get(topic);

      if (!listeners) continue;

      for (const listener of listeners) {
        listener(payload);
      }
    }
  }

  public subscribe<TTopic extends keyof Events>(
    topic: TTopic
  ): Observable<Events[TTopic], unknown> {
    return observable((observer) => {
      const listener = (data: Events[TTopic]) => {
        observer.next(data);
      };

      this.ee.on(topic, listener);

      const ee = this.ee;

      const unsubscribable: Unsubscribable = {
        unsubscribe() {
          ee.off(topic, listener);
        }
      };

      return unsubscribable;
    });
  }

  public subscribeFor<TTopic extends keyof Events>(
    userId: number,
    topic: TTopic
  ): Observable<Events[TTopic], unknown> {
    return observable((observer) => {
      const listener = (data: Events[TTopic]) => {
        observer.next(data);
      };

      if (!this.userListeners.has(userId)) {
        this.userListeners.set(userId, new Map());
      }

      const userTopics = this.userListeners.get(userId)!;

      if (!userTopics.has(topic)) {
        userTopics.set(topic, new Set());
      }

      userTopics
        .get(topic)!
        .add(listener as (data: Events[keyof Events]) => void);

      const unsubscribable: Unsubscribable = {
        unsubscribe: () => {
          const userTopics = this.userListeners.get(userId);

          if (!userTopics) return;

          const listeners = userTopics.get(topic);

          if (!listeners) return;

          listeners.delete(listener as (data: Events[keyof Events]) => void);

          if (listeners.size === 0) {
            userTopics.delete(topic);
          }

          if (userTopics.size === 0) {
            this.userListeners.delete(userId);
          }
        }
      };

      return unsubscribable;
    });
  }

  public publishForChannel<TTopic extends keyof Events>(
    runtimeKey: string,
    topic: TTopic,
    payload: Events[TTopic]
  ): void {
    const channelTopics = this.channelListeners.get(runtimeKey);

    if (!channelTopics) return;

    const listeners = channelTopics.get(topic);

    if (!listeners) return;

    for (const listener of listeners) {
      listener(payload);
    }
  }

  public subscribeForChannel<TTopic extends keyof Events>(
    runtimeKey: string,
    topic: TTopic
  ): Observable<Events[TTopic], unknown> {
    return observable((observer) => {
      const listener = (data: Events[TTopic]) => {
        observer.next(data);
      };

      if (!this.channelListeners.has(runtimeKey)) {
        this.channelListeners.set(runtimeKey, new Map());
      }

      const channelTopics = this.channelListeners.get(runtimeKey)!;

      if (!channelTopics.has(topic)) {
        channelTopics.set(topic, new Set());
      }

      channelTopics
        .get(topic)!
        .add(listener as (data: Events[keyof Events]) => void);

      const unsubscribable: Unsubscribable = {
        unsubscribe: () => {
          const channelTopics = this.channelListeners.get(runtimeKey);

          if (!channelTopics) return;

          const listeners = channelTopics.get(topic);

          if (!listeners) return;

          listeners.delete(listener as (data: Events[keyof Events]) => void);

          if (listeners.size === 0) {
            channelTopics.delete(topic);
          }

          if (channelTopics.size === 0) {
            this.channelListeners.delete(runtimeKey);
          }
        }
      };

      return unsubscribable;
    });
  }
}

export const pubsub = new PubSub();
