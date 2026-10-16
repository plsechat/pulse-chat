import type { TPinnedCard } from '@/components/channel-view/voice/hooks/use-pin-card-controller';
import { LocalStorageKey } from '@/helpers/storage';
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  TChannelUserPermissionsMap,
  TCommandsMapByPlugin,
  TExternalStream,
  TExternalStreamsMap,
  TLastReadMessageIdMap,
  TMentionStateMap,
  TReadStateMap,
  TVoiceMap,
  TVoiceUserState
} from '@pulse/shared';
import type {
  TCategory,
  TChannel,
  TJoinedEmoji,
  TJoinedMessage,
  TJoinedPublicUser,
  TJoinedRole,
  TPublicServerSettings,
  TServerInfo
} from '@pulse/server/types';
import {
  mergeMessageWindow,
  replaceMessageWindow,
  windowOrDefault,
  type TMergeMessagesOpts,
  type TMessageWindowMap
} from '../message-window';
import type {
  TDisconnectInfo,
  TMessagesMap,
  TServerPreviewMeta
} from './types';
import {
  dmVoiceEntries,
  rekeyServerVoiceMap,
  voiceMapKey,
  type TClientVoiceMap,
  type TVoiceKind
} from './voice/keys';

/**
 * ID-keying convention (federation ID-collision fix):
 *
 * Numeric ids (channel.id, user.id, ...) are INSTANCE-LOCAL — two federated
 * instances can both have a channel/server/user with id 1. State in this
 * slice keyed by numeric id is safe ONLY because it is scoped to a single
 * instance's live view: setInitialData replaces it wholesale on every
 * server/instance switch, so it can never hold two instances' data at once.
 *
 * Anything that CROSSES instances or SURVIVES a server switch must be keyed
 * or matched by a globally-unique publicId instead: the active server
 * (`serverId` below IS the server's publicId), the persisted voice session
 * (`currentVoiceChannelPublicId`), joined-server entries and roster event
 * scoping (see features/app + users/subscriptions), and all federation
 * addressing. Keep new state on the correct side of this line.
 */
export interface IServerState {
  connected: boolean;
  reconnecting: boolean;
  reconnectAttempt: number;
  disconnectInfo?: TDisconnectInfo;
  /** publicId of the currently connected server (NOT the numeric id). */
  serverId?: string;
  categories: TCategory[];
  channels: TChannel[];
  emojis: TJoinedEmoji[];
  ownUserId: number | undefined;
  selectedChannelId: number | undefined;
  currentVoiceChannelId: number | undefined;
  // Whether currentVoiceChannelId names a server voice channel or a DM
  // call — the two id spaces overlap, so the id alone is ambiguous.
  currentVoiceKind: TVoiceKind | undefined;
  currentVoiceServerId: number | undefined;
  // Globally-unique publicId of the channel the user is in voice on. Voice
  // persists across server/instance navigation, so voice-active UI must match
  // on this (unique) id — not the instance-local numeric currentVoiceChannelId,
  // which collides with a federated server's channel of the same numeric id.
  currentVoiceChannelPublicId: string | undefined;
  // Same for the SERVER hosting the voice session (drives the server-rail
  // voice badge): the numeric currentVoiceServerId collides across federated
  // instances and would light up the wrong rail icon.
  currentVoiceServerPublicId: string | undefined;
  // Instance hosting the live voice session (undefined = home), pinned
  // when the join succeeds. getVoiceTRPCClient routes every voice
  // mutation/subscription by this, not by the instance in focus — the
  // user keeps browsing other servers mid-call and the call must keep
  // talking to the server it was joined on.
  voiceInstanceDomain: string | undefined;
  messagesMap: TMessagesMap;
  // What lies beyond each edge of the loaded window per channel — see
  // features/message-window.ts. Lives beside messagesMap and is reset
  // wherever messagesMap is.
  messageWindowMap: TMessageWindowMap;
  users: TJoinedPublicUser[];
  roles: TJoinedRole[];
  publicSettings: TPublicServerSettings | undefined;
  info: TServerInfo | undefined;
  loadingInfo: boolean;
  typingMap: {
    [channelId: number]: number[];
  };
  // Keyed by `${kind}:${id}` (voiceMapKey) — see voice/keys.ts.
  voiceMap: TClientVoiceMap;
  externalStreamsMap: TExternalStreamsMap;
  ownVoiceState: TVoiceUserState;
  pinnedCard: TPinnedCard | undefined;
  channelPermissions: TChannelUserPermissionsMap;
  readStatesMap: {
    [channelId: number]: number | undefined;
  };
  mentionStatesMap: {
    [channelId: number]: number | undefined;
  };
  lastReadMessageIdMap: {
    [channelId: number]: number | null | undefined;
  };
  pluginCommands: TCommandsMapByPlugin;
  activeThreadId: number | undefined;
  highlightedMessageId: number | undefined;
  usersLoaded: boolean;
  emojisLoaded: boolean;
  // Instance-level federation facts for THIS connection (set by
  // setInitialData). isInstanceOwner: the connected user owns the
  // instance's first server (the operator) — gates the Federation
  // settings. federatableServersAllowed: the operator lets other server
  // owners mark their servers federatable.
  isInstanceOwner: boolean;
  federatableServersAllowed: boolean;
  // Read-only preview session (servers.preview): true while the slice
  // holds a non-member snapshot of a server. Cleared by any real join
  // (setInitialData) or by leaving the preview.
  previewMode: boolean;
  previewMeta: TServerPreviewMeta | undefined;
}

const initialState: IServerState = {
  connected: false,
  reconnecting: false,
  reconnectAttempt: 0,
  disconnectInfo: undefined,
  serverId: undefined,
  ownUserId: undefined,
  categories: [],
  channels: [],
  emojis: [],
  selectedChannelId: undefined,
  currentVoiceChannelId: undefined,
  currentVoiceKind: undefined,
  currentVoiceServerId: undefined,
  currentVoiceChannelPublicId: undefined,
  currentVoiceServerPublicId: undefined,
  voiceInstanceDomain: undefined,
  messagesMap: {},
  messageWindowMap: {},
  users: [],
  roles: [],
  publicSettings: undefined,
  info: undefined,
  loadingInfo: false,
  typingMap: {},
  voiceMap: {},
  externalStreamsMap: {},
  ownVoiceState: {
    micMuted: false,
    soundMuted: false,
    webcamEnabled: false,
    sharingScreen: false,
    serverMuted: false,
    serverDeafened: false
  },
  pinnedCard: undefined,
  channelPermissions: {},
  readStatesMap: {},
  mentionStatesMap: {},
  lastReadMessageIdMap: {},
  pluginCommands: {},
  activeThreadId: undefined,
  highlightedMessageId: undefined,
  usersLoaded: false,
  emojisLoaded: false,
  isInstanceOwner: false,
  federatableServersAllowed: false,
  previewMode: false,
  previewMeta: undefined
};

/**
 * Drop the parts of ownVoiceState that only exist for the duration of one
 * voice session. The server seeds every join from its own defaults (voice
 * runtime addUser), so webcam/screen-share and the moderator overrides are
 * always false on the SFU after a rejoin — if the client kept them, the
 * sidebar buttons would run split-brain (share icon lit with nothing
 * flowing, a stale "muted by a moderator" refusal on the mic). micMuted and
 * soundMuted are user preferences the client sends with the join request,
 * so they deliberately survive.
 */
const clearSessionVoiceFlags = (state: IServerState) => {
  // The session is over on every path that reaches here, so the instance
  // pin goes with it — the next join pins afresh.
  state.voiceInstanceDomain = undefined;
  state.ownVoiceState = {
    ...state.ownVoiceState,
    webcamEnabled: false,
    sharingScreen: false,
    serverMuted: false,
    serverDeafened: false
  };
};

export const serverSlice = createSlice({
  name: 'server',
  initialState,
  reducers: {
    resetState: (state) => {
      Object.assign(state, {
        ...initialState,
        info: state.info
      });
    },
    /**
     * Drop the active server's snapshot (channels, roles, read states,
     * messages, roster …) while keeping the connection fields and the
     * user's own voice session. Used when leaving a federated server's
     * context for the home view: the remote snapshot otherwise stayed
     * live — its unread counts in the tab title, its ids under every
     * ambient call — while nothing on screen referred to it. Voice is
     * kept because it is only ended by an explicit leave; the roster map
     * goes with the snapshot exactly as it does on a server switch.
     */
    resetStateKeepVoice: (state) => {
      Object.assign(state, {
        ...initialState,
        info: state.info,
        loadingInfo: state.loadingInfo,
        connected: state.connected,
        reconnecting: state.reconnecting,
        reconnectAttempt: state.reconnectAttempt,
        disconnectInfo: state.disconnectInfo,
        currentVoiceChannelId: state.currentVoiceChannelId,
        currentVoiceKind: state.currentVoiceKind,
        currentVoiceServerId: state.currentVoiceServerId,
        currentVoiceChannelPublicId: state.currentVoiceChannelPublicId,
        currentVoiceServerPublicId: state.currentVoiceServerPublicId,
        voiceInstanceDomain: state.voiceInstanceDomain,
        ownVoiceState: state.ownVoiceState,
        pinnedCard: state.pinnedCard
      });
    },
    setConnected: (state, action: PayloadAction<boolean>) => {
      state.connected = action.payload;
    },
    setReconnecting: (state, action: PayloadAction<boolean>) => {
      state.reconnecting = action.payload;
      if (!action.payload) {
        state.reconnectAttempt = 0;
      }
    },
    setReconnectAttempt: (state, action: PayloadAction<number>) => {
      state.reconnectAttempt = action.payload;
    },

    setInfo: (state, action: PayloadAction<TServerInfo | undefined>) => {
      state.info = action.payload;
    },
    setLoadingInfo: (state, action: PayloadAction<boolean>) => {
      state.loadingInfo = action.payload;
    },
    setDisconnectInfo: (
      state,
      action: PayloadAction<TDisconnectInfo | undefined>
    ) => {
      state.disconnectInfo = action.payload;
    },
    setInitialData: (
      state,
      action: PayloadAction<{
        serverId: string;
        categories: TCategory[];
        channels: TChannel[];
        ownUserId: number;
        roles: TJoinedRole[];
        publicSettings?: TPublicServerSettings | undefined;
        channelPermissions: TChannelUserPermissionsMap;
        readStates: TReadStateMap;
        mentionStates?: TMentionStateMap;
        lastReadMessageIds?: TLastReadMessageIdMap;
        isInstanceOwner?: boolean;
        federatableServersAllowed?: boolean;
      }>
    ) => {
      state.connected = true;
      state.categories = action.payload.categories;
      state.channels = action.payload.channels;
      state.roles = action.payload.roles;
      state.ownUserId = action.payload.ownUserId;
      state.publicSettings = action.payload.publicSettings;
      state.serverId = action.payload.serverId;
      state.channelPermissions = action.payload.channelPermissions;
      state.readStatesMap = action.payload.readStates;
      state.mentionStatesMap = action.payload.mentionStates ?? {};
      state.lastReadMessageIdMap = action.payload.lastReadMessageIds ?? {};
      state.isInstanceOwner = action.payload.isInstanceOwner ?? false;
      state.federatableServersAllowed =
        action.payload.federatableServersAllowed ?? false;
      // Any real join ends a preview session
      state.previewMode = false;
      state.previewMeta = undefined;
      // Clear deferred state from previous server (will be populated by separate fetches)
      state.users = [];
      state.emojis = [];
      // The server's channel rosters are replaced by the deferred fetch;
      // DM calls belong to the home account, not the server, and
      // survive the switch (the call panel/banner still needs them).
      state.voiceMap = dmVoiceEntries(state.voiceMap);
      state.externalStreamsMap = {};
      state.usersLoaded = false;
      state.emojisLoaded = false;
      // Clear transient state from previous server
      state.messagesMap = {};
      state.messageWindowMap = {};
      state.typingMap = {};
      state.activeThreadId = undefined;

      // Restore the last-selected channel for this server (if it still exists)
      let restoredChannelId: number | undefined;
      try {
        const raw = localStorage.getItem(LocalStorageKey.SERVER_CHANNEL_MAP);
        if (raw) {
          const map = JSON.parse(raw) as Record<string, number>;
          const savedId = map[action.payload.serverId];
          if (
            savedId !== undefined &&
            action.payload.channels.some((c) => c.id === savedId)
          ) {
            restoredChannelId = savedId;
          }
        }
      } catch {
        // ignore corrupt localStorage
      }
      state.selectedChannelId = restoredChannelId;

      // Preserve currentVoiceChannelId so voice persists across server navigation
      // Voice is only disconnected when the user explicitly leaves
    },
    // Dispatched AFTER setInitialData populated the slice with the
    // preview snapshot (see features/server/preview/actions.ts).
    setPreviewMeta: (state, action: PayloadAction<TServerPreviewMeta>) => {
      state.previewMode = true;
      state.previewMeta = action.payload;
    },
    clearPreview: (state) => {
      state.previewMode = false;
      state.previewMeta = undefined;
    },
    addMessages: (
      state,
      action: PayloadAction<{
        channelId: number;
        messages: TJoinedMessage[];
        opts?: TMergeMessagesOpts;
      }>
    ) => {
      const { channelId, messages, opts } = action.payload;
      // Dedupe, chronological order and the 300-message cap live in
      // mergeMessageWindow; the window flags it returns say which edge
      // was trimmed.
      const result = mergeMessageWindow(
        state.messagesMap[channelId] ?? [],
        messages,
        opts ?? {},
        state.messageWindowMap[channelId]
      );
      state.messagesMap[channelId] = result.messages;
      state.messageWindowMap[channelId] = result.window;
    },
    /**
     * A freshly fetched LATEST page: re-attaches the channel to the live
     * tail (initial load, "Jump to Present"). See replaceMessageWindow
     * for what of the existing array survives.
     */
    replaceMessages: (
      state,
      action: PayloadAction<{
        channelId: number;
        messages: TJoinedMessage[];
        hasOlder: boolean;
      }>
    ) => {
      const { channelId, messages, hasOlder } = action.payload;
      const result = replaceMessageWindow(
        state.messagesMap[channelId] ?? [],
        messages,
        hasOlder
      );
      state.messagesMap[channelId] = result.messages;
      state.messageWindowMap[channelId] = result.window;
    },
    /** Partial update of a channel's window flags (from a page result). */
    setMessageWindow: (
      state,
      action: PayloadAction<{
        channelId: number;
        hasOlder?: boolean;
        hasNewer?: boolean;
      }>
    ) => {
      const { channelId, hasOlder, hasNewer } = action.payload;
      const current = windowOrDefault(state.messageWindowMap[channelId]);
      state.messageWindowMap[channelId] = {
        hasOlder: hasOlder ?? current.hasOlder,
        hasNewer: hasNewer ?? current.hasNewer
      };
    },
    updateMessage: (
      state,
      action: PayloadAction<{ channelId: number; message: TJoinedMessage }>
    ) => {
      const messages = state.messagesMap[action.payload.channelId];

      if (!messages) return;

      const messageIndex = messages.findIndex(
        (message) => message.id === action.payload.message.id
      );

      if (messageIndex === -1) return;

      messages[messageIndex] = action.payload.message;
    },
    deleteMessage: (
      state,
      action: PayloadAction<{ channelId: number; messageId: number }>
    ) => {
      const messages = state.messagesMap[action.payload.channelId];

      if (!messages) return;

      state.messagesMap[action.payload.channelId] = messages.filter(
        (m) => m.id !== action.payload.messageId
      );
    },
    bulkDeleteMessages: (
      state,
      action: PayloadAction<{ channelId: number; messageIds: number[] }>
    ) => {
      const messages = state.messagesMap[action.payload.channelId];

      if (!messages) return;

      const idsToDelete = new Set(action.payload.messageIds);
      state.messagesMap[action.payload.channelId] = messages.filter(
        (m) => !idsToDelete.has(m.id)
      );
    },
    purgeChannelMessages: (
      state,
      action: PayloadAction<{ channelId: number }>
    ) => {
      state.messagesMap[action.payload.channelId] = [];
      delete state.messageWindowMap[action.payload.channelId];
    },
    clearAllMessages: (state) => {
      state.messagesMap = {};
      state.messageWindowMap = {};
    },
    clearTypingUsers: (state, action: PayloadAction<number>) => {
      delete state.typingMap[action.payload];
    },
    addTypingUser: (
      state,
      action: PayloadAction<{ channelId: number; userId: number }>
    ) => {
      const { channelId, userId } = action.payload;
      const typingUsers = state.typingMap[channelId] || [];

      if (!typingUsers.includes(userId)) {
        typingUsers.push(userId);
        state.typingMap[channelId] = typingUsers;
      }
    },
    removeTypingUser: (
      state,
      action: PayloadAction<{ channelId: number; userId: number }>
    ) => {
      const { channelId, userId } = action.payload;
      const typingUsers = state.typingMap[channelId] || [];

      state.typingMap[channelId] = typingUsers.filter((id) => id !== userId);
    },

    // USERS ------------------------------------------------------------

    setUsers: (state, action: PayloadAction<TJoinedPublicUser[]>) => {
      state.users = action.payload;
    },
    setUsersLoaded: (state, action: PayloadAction<boolean>) => {
      state.usersLoaded = action.payload;
    },
    updateUser: (
      state,
      action: PayloadAction<{
        userId: number;
        user: Partial<TJoinedPublicUser>;
      }>
    ) => {
      const index = state.users.findIndex(
        (u) => u.id === action.payload.userId
      );

      if (index === -1) return;

      state.users[index] = {
        ...state.users[index],
        ...action.payload.user
      };
    },
    addUser: (state, action: PayloadAction<TJoinedPublicUser>) => {
      const exists = state.users.find((u) => u.id === action.payload.id);

      if (exists) return;

      state.users.push(action.payload);
    },
    removeUser: (state, action: PayloadAction<number>) => {
      state.users = state.users.filter((u) => u.id !== action.payload);
    },

    // SERVER SETTINGS ------------------------------------------------------------

    setPublicSettings: (
      state,
      action: PayloadAction<TPublicServerSettings | undefined>
    ) => {
      state.publicSettings = action.payload;

      // Sync name/description into server info so the UI updates in realtime
      if (action.payload && state.info) {
        state.info.name = action.payload.name;
        state.info.description = action.payload.description ?? '';
      }
    },

    // ROLES ------------------------------------------------------------


    updateRole: (
      state,
      action: PayloadAction<{
        roleId: number;
        role: Partial<TJoinedRole>;
      }>
    ) => {
      const index = state.roles.findIndex(
        (r) => r.id === action.payload.roleId
      );

      if (index === -1) return;

      state.roles[index] = {
        ...state.roles[index],
        ...action.payload.role
      };
    },
    addRole: (state, action: PayloadAction<TJoinedRole>) => {
      const exists = state.roles.find((r) => r.id === action.payload.id);

      if (exists) return;

      state.roles.push(action.payload);
    },
    removeRole: (state, action: PayloadAction<{ roleId: number }>) => {
      state.roles = state.roles.filter((r) => r.id !== action.payload.roleId);
    },

    // CHANNELS ------------------------------------------------------------


    updateChannel: (
      state,
      action: PayloadAction<{ channelId: number; channel: Partial<TChannel> }>
    ) => {
      const index = state.channels.findIndex(
        (c) => c.id === action.payload.channelId
      );

      if (index === -1) return;

      state.channels[index] = {
        ...state.channels[index],
        ...action.payload.channel
      };
    },
    addChannel: (state, action: PayloadAction<TChannel>) => {
      const exists = state.channels.find((c) => c.id === action.payload.id);

      if (exists) return;

      state.channels.push(action.payload);
    },
    removeChannel: (state, action: PayloadAction<{ channelId: number }>) => {
      state.channels = state.channels.filter(
        (c) => c.id !== action.payload.channelId
      );
    },
    setSelectedChannelId: (
      state,
      action: PayloadAction<number | undefined>
    ) => {
      // Leaving a channel counts everything loaded there as seen: the
      // "New messages" divider on the NEXT visit should mark messages
      // that arrived after this point, not the connect-time snapshot.
      const prev = state.selectedChannelId;
      if (prev != null && prev !== action.payload) {
        const prevMessages = state.messagesMap[prev];
        if (prevMessages?.length) {
          const newestId = prevMessages[prevMessages.length - 1]!.id;
          const prevRead = state.lastReadMessageIdMap[prev];
          if (prevRead == null || newestId > prevRead) {
            state.lastReadMessageIdMap[prev] = newestId;
          }
        }
      }

      state.selectedChannelId = action.payload;
      state.activeThreadId = undefined;

      if (action.payload) {
        // reset unread count on select
        // for now this is good enough
        state.readStatesMap[action.payload] = 0;
        state.mentionStatesMap[action.payload] = 0;
      }
    },
    // A bare number is a server voice channel; a DM call passes its kind
    // explicitly. undefined ends the session whichever kind it was.
    setCurrentVoiceChannelId: (
      state,
      action: PayloadAction<
        number | { channelId: number; kind: TVoiceKind } | undefined
      >
    ) => {
      const session =
        typeof action.payload === 'number'
          ? { channelId: action.payload, kind: 'channel' as const }
          : action.payload;
      state.currentVoiceChannelId = session?.channelId;
      state.currentVoiceKind = session?.kind;
      if (session === undefined) {
        clearSessionVoiceFlags(state);
      }
      // Capture the channel's globally-unique publicId at join time (while the
      // owning server's channels are loaded). It's preserved across server
      // switches, so the voice-active highlight matches by publicId, not the
      // colliding numeric id. Server channels only; DM voice leaves it unset.
      const voiceChannel =
        session?.kind === 'channel'
          ? state.channels.find((c) => c.id === session.channelId)
          : undefined;
      state.currentVoiceChannelPublicId = voiceChannel?.publicId ?? undefined;
    },
    setCurrentVoiceServerId: (
      state,
      action: PayloadAction<
        number | undefined | { id: number; publicId: string | undefined }
      >
    ) => {
      const payload = action.payload;
      if (payload !== undefined && typeof payload === 'object') {
        // A reconnect rejoin restores a session on a server that is not
        // necessarily the one in focus, so the hosting server's publicId
        // travels with the restore instead of being read off the
        // connected server (which would light up the wrong rail icon).
        state.currentVoiceServerId = payload.id;
        state.currentVoiceServerPublicId = payload.publicId;
        return;
      }
      state.currentVoiceServerId = payload;
      // Capture the hosting server's globally-unique publicId alongside the
      // numeric id. User-driven voice joins always happen while the hosting
      // server is the connected one, so state.serverId (its publicId) is
      // correct here and survives later server/instance switches.
      state.currentVoiceServerPublicId =
        payload != null ? state.serverId : undefined;
    },
    setVoiceInstanceDomain: (
      state,
      action: PayloadAction<string | undefined>
    ) => {
      state.voiceInstanceDomain = action.payload;
    },
    setChannelPermissions: (
      state,
      action: PayloadAction<TChannelUserPermissionsMap>
    ) => {
      state.channelPermissions = action.payload;
    },
    setChannelReadState: (
      state,
      action: PayloadAction<{ channelId: number; count: number | undefined }>
    ) => {
      const { channelId, count } = action.payload;

      state.readStatesMap[channelId] = count;
    },
    setChannelMentionState: (
      state,
      action: PayloadAction<{ channelId: number; count: number | undefined }>
    ) => {
      const { channelId, count } = action.payload;

      state.mentionStatesMap[channelId] = count;
    },

    // EMOJIS ------------------------------------------------------------

    setEmojis: (state, action: PayloadAction<TJoinedEmoji[]>) => {
      state.emojis = action.payload;
    },
    setEmojisLoaded: (state, action: PayloadAction<boolean>) => {
      state.emojisLoaded = action.payload;
    },
    updateEmoji: (
      state,
      action: PayloadAction<{ emojiId: number; emoji: Partial<TJoinedEmoji> }>
    ) => {
      const index = state.emojis.findIndex(
        (e) => e.id === action.payload.emojiId
      );
      if (index === -1) return;
      state.emojis[index] = {
        ...state.emojis[index],
        ...action.payload.emoji
      };
    },
    addEmoji: (state, action: PayloadAction<TJoinedEmoji>) => {
      const exists = state.emojis.find((e) => e.id === action.payload.id);

      if (exists) return;
      state.emojis.push(action.payload);
    },
    removeEmoji: (state, action: PayloadAction<{ emojiId: number }>) => {
      state.emojis = state.emojis.filter(
        (e) => e.id !== action.payload.emojiId
      );
    },

    // CATEGORIES ------------------------------------------------------------


    addCategory: (state, action: PayloadAction<TCategory>) => {
      const exists = state.categories.find((c) => c.id === action.payload.id);

      if (exists) return;

      state.categories.push(action.payload);
    },
    updateCategory: (
      state,
      action: PayloadAction<{
        categoryId: number;
        category: Partial<TCategory>;
      }>
    ) => {
      const index = state.categories.findIndex(
        (c) => c.id === action.payload.categoryId
      );

      if (index === -1) return;

      state.categories[index] = {
        ...state.categories[index],
        ...action.payload.category
      };
    },
    removeCategory: (state, action: PayloadAction<{ categoryId: number }>) => {
      state.categories = state.categories.filter(
        (c) => c.id !== action.payload.categoryId
      );
    },

    // VOICE ------------------------------------------------------------

    setDeferredVoiceState: (
      state,
      action: PayloadAction<{
        voiceMap: TVoiceMap;
        externalStreamsMap: TExternalStreamsMap;
      }>
    ) => {
      // The snapshot is the server's channels only (keyed by bare id);
      // DM-call entries are the home account's and stay.
      state.voiceMap = {
        ...dmVoiceEntries(state.voiceMap),
        ...rekeyServerVoiceMap(action.payload.voiceMap)
      };
      state.externalStreamsMap = action.payload.externalStreamsMap;

      // Reset voice state if the user is no longer in voice on this server
      // (e.g. after reconnect where the server removed the user from voice).
      // Compare by publicId — state.serverId IS the connected server's
      // publicId. (The old `currentVoiceServerId === Number(state.serverId)`
      // comparison was inert: Number(uuid) is NaN, so this cleanup never
      // fired.) Only runs while viewing the voice-hosting server, so a
      // session on another instance is never clobbered by this fetch.
      if (
        state.currentVoiceKind === 'channel' &&
        state.currentVoiceServerPublicId !== undefined &&
        state.currentVoiceServerPublicId === state.serverId
      ) {
        const ownId = state.ownUserId;
        if (ownId !== undefined) {
          const stillInVoice = Object.values(action.payload.voiceMap).some(
            (ch) => ch && ownId in ch.users
          );
          if (!stillInVoice) {
            state.currentVoiceChannelId = undefined;
            state.currentVoiceKind = undefined;
            state.currentVoiceServerId = undefined;
            state.currentVoiceChannelPublicId = undefined;
            state.currentVoiceServerPublicId = undefined;
            clearSessionVoiceFlags(state);
          }
        }
      }
    },

    addUserToVoiceChannel: (
      state,
      action: PayloadAction<{
        channelId: number;
        kind: TVoiceKind;
        userId: number;
        state: TVoiceUserState;
        startedAt?: number;
      }>
    ) => {
      const { channelId, kind, userId, state: userState, startedAt } =
        action.payload;
      const key = voiceMapKey(kind, channelId);

      const session = state.voiceMap[key] ?? { users: {} };
      state.voiceMap[key] = session;

      session.users[userId] = userState;

      if (startedAt !== undefined) {
        session.startedAt = startedAt;
      }
    },
    removeUserFromVoiceChannel: (
      state,
      action: PayloadAction<{
        channelId: number;
        kind: TVoiceKind;
        userId: number;
        startedAt?: number;
      }>
    ) => {
      const { channelId, kind, userId, startedAt } = action.payload;
      const session = state.voiceMap[voiceMapKey(kind, channelId)];

      if (!session) return;

      delete session.users[userId];

      if (startedAt !== undefined) {
        session.startedAt = startedAt;
      } else {
        // No startedAt means session ended (no users left)
        delete session.startedAt;
      }
    },
    updateVoiceUserState: (
      state,
      action: PayloadAction<{
        channelId: number;
        kind: TVoiceKind;
        userId: number;
        newState: Partial<TVoiceUserState>;
      }>
    ) => {
      const { channelId, kind, userId, newState } = action.payload;
      const session = state.voiceMap[voiceMapKey(kind, channelId)];

      if (!session) return;
      if (!session.users[userId]) return;

      session.users[userId] = {
        ...session.users[userId],
        ...newState
      };
    },
    updateOwnVoiceState: (
      state,
      action: PayloadAction<Partial<TVoiceUserState>>
    ) => {
      state.ownVoiceState = {
        ...state.ownVoiceState,
        ...action.payload
      };
    },
    setPinnedCard: (state, action: PayloadAction<TPinnedCard | undefined>) => {
      state.pinnedCard = action.payload;
    },
    addExternalStreamToChannel: (
      state,
      action: PayloadAction<{
        channelId: number;
        streamId: number;
        stream: TExternalStream;
      }>
    ) => {
      const { channelId, streamId, stream } = action.payload;

      if (!state.externalStreamsMap[channelId]) {
        state.externalStreamsMap[channelId] = {};
      }

      state.externalStreamsMap[channelId][streamId] = stream;
    },
    updateExternalStreamInChannel: (
      state,
      action: PayloadAction<{
        channelId: number;
        streamId: number;
        stream: TExternalStream;
      }>
    ) => {
      const { channelId, streamId, stream } = action.payload;

      if (!state.externalStreamsMap[channelId]) return;
      if (!state.externalStreamsMap[channelId][streamId]) return;

      state.externalStreamsMap[channelId][streamId] = stream;
    },
    removeExternalStreamFromChannel: (
      state,
      action: PayloadAction<{ channelId: number; streamId: number }>
    ) => {
      const { channelId, streamId } = action.payload;

      if (!state.externalStreamsMap[channelId]) return;

      delete state.externalStreamsMap[channelId][streamId];
    },

    // PLUGINS ------------------------------------------------------------

    setPluginCommands: (state, action: PayloadAction<TCommandsMapByPlugin>) => {
      state.pluginCommands = action.payload;
    },


    // THREADS ------------------------------------------------------------

    setActiveThreadId: (
      state,
      action: PayloadAction<number | undefined>
    ) => {
      state.activeThreadId = action.payload;
    },

    setHighlightedMessageId: (
      state,
      action: PayloadAction<number | undefined>
    ) => {
      state.highlightedMessageId = action.payload;
    }
  }
});

const serverSliceActions = serverSlice.actions;
const serverSliceReducer = serverSlice.reducer;

export { serverSliceActions, serverSliceReducer };
