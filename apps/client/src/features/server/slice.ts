import type { TPinnedCard } from '@/components/channel-view/voice/hooks/use-pin-card-controller';
import { LocalStorageKey } from '@/helpers/storage';
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  TCategory,
  TChannel,
  TChannelUserPermissionsMap,
  TCommandInfo,
  TCommandsMapByPlugin,
  TExternalStream,
  TExternalStreamsMap,
  TJoinedEmoji,
  TJoinedMessage,
  TJoinedPublicUser,
  TJoinedRole,
  TLastReadMessageIdMap,
  TMentionStateMap,
  TPublicServerSettings,
  TReadStateMap,
  TServerInfo,
  TVoiceMap,
  TVoiceUserState
} from '@pulse/shared';
import type { TDisconnectInfo, TMessagesMap } from './types';

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
  connecting: boolean;
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
  messagesMap: TMessagesMap;
  users: TJoinedPublicUser[];
  roles: TJoinedRole[];
  publicSettings: TPublicServerSettings | undefined;
  info: TServerInfo | undefined;
  loadingInfo: boolean;
  typingMap: {
    [channelId: number]: number[];
  };
  voiceMap: TVoiceMap;
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
}

const initialState: IServerState = {
  connected: false,
  connecting: false,
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
  currentVoiceServerId: undefined,
  currentVoiceChannelPublicId: undefined,
  currentVoiceServerPublicId: undefined,
  messagesMap: {},
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
    sharingScreen: false
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
  emojisLoaded: false
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
    setConnected: (state, action: PayloadAction<boolean>) => {
      state.connected = action.payload;
      state.connecting = false;
    },
    setConnecting: (state, action: PayloadAction<boolean>) => {
      state.connecting = action.payload;
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
    setServerId: (state, action: PayloadAction<string | undefined>) => {
      state.serverId = action.payload;
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
      }>
    ) => {
      state.connected = true;
      state.connecting = false;
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
      // Clear deferred state from previous server (will be populated by separate fetches)
      state.users = [];
      state.emojis = [];
      state.voiceMap = {};
      state.externalStreamsMap = {};
      state.usersLoaded = false;
      state.emojisLoaded = false;
      // Clear transient state from previous server
      state.messagesMap = {};
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
    addMessages: (
      state,
      action: PayloadAction<{
        channelId: number;
        messages: TJoinedMessage[];
        opts?: { prepend?: boolean };
      }>
    ) => {
      const { channelId, messages, opts } = action.payload;
      const existing = state.messagesMap[channelId] ?? [];

      // dedupe: only add new IDs
      const existingIds = new Set(existing.map((m) => m.id));
      const filtered = messages.filter((m) => !existingIds.has(m.id));

      let merged: TJoinedMessage[];
      if (opts?.prepend) {
        merged = [...filtered, ...existing];
      } else {
        merged = [...existing, ...filtered];
      }

      // store in chronological asc order (oldest → newest)
      state.messagesMap[channelId] = merged.sort(
        (a, b) => a.createdAt - b.createdAt
      );
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
    },
    clearAllMessages: (state) => {
      state.messagesMap = {};
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

    setRoles: (state, action: PayloadAction<TJoinedRole[]>) => {
      state.roles = action.payload;
    },
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

    setChannels: (state, action: PayloadAction<TChannel[]>) => {
      state.channels = action.payload;
    },
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
      state.selectedChannelId = action.payload;
      state.activeThreadId = undefined;

      if (action.payload) {
        // reset unread count on select
        // for now this is good enough
        state.readStatesMap[action.payload] = 0;
        state.mentionStatesMap[action.payload] = 0;
      }
    },
    setCurrentVoiceChannelId: (
      state,
      action: PayloadAction<number | undefined>
    ) => {
      state.currentVoiceChannelId = action.payload;
      // Capture the channel's globally-unique publicId at join time (while the
      // owning server's channels are loaded). It's preserved across server
      // switches, so the voice-active highlight matches by publicId, not the
      // colliding numeric id. Server channels only; DM voice leaves it unset.
      const voiceChannel =
        action.payload != null
          ? state.channels.find((c) => c.id === action.payload)
          : undefined;
      state.currentVoiceChannelPublicId = voiceChannel?.publicId ?? undefined;
    },
    setCurrentVoiceServerId: (
      state,
      action: PayloadAction<number | undefined>
    ) => {
      state.currentVoiceServerId = action.payload;
      // Capture the hosting server's globally-unique publicId alongside the
      // numeric id. Voice joins always happen while the hosting server is
      // the connected one, so state.serverId (its publicId) is correct here
      // and survives later server/instance switches.
      state.currentVoiceServerPublicId =
        action.payload != null ? state.serverId : undefined;
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

    setCategories: (state, action: PayloadAction<TCategory[]>) => {
      state.categories = action.payload;
    },
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
      state.voiceMap = action.payload.voiceMap;
      state.externalStreamsMap = action.payload.externalStreamsMap;

      // Reset voice state if the user is no longer in voice on this server
      // (e.g. after reconnect where the server removed the user from voice).
      // Compare by publicId — state.serverId IS the connected server's
      // publicId. (The old `currentVoiceServerId === Number(state.serverId)`
      // comparison was inert: Number(uuid) is NaN, so this cleanup never
      // fired.) Only runs while viewing the voice-hosting server, so a
      // session on another instance is never clobbered by this fetch.
      if (
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
            state.currentVoiceServerId = undefined;
            state.currentVoiceChannelPublicId = undefined;
            state.currentVoiceServerPublicId = undefined;
          }
        }
      }
    },

    addUserToVoiceChannel: (
      state,
      action: PayloadAction<{
        channelId: number;
        userId: number;
        state: TVoiceUserState;
        startedAt?: number;
      }>
    ) => {
      const { channelId, userId, state: userState, startedAt } = action.payload;

      if (!state.voiceMap[channelId]) {
        state.voiceMap[channelId] = { users: {} };
      }

      state.voiceMap[channelId].users[userId] = userState;

      if (startedAt !== undefined) {
        state.voiceMap[channelId].startedAt = startedAt;
      }
    },
    removeUserFromVoiceChannel: (
      state,
      action: PayloadAction<{ channelId: number; userId: number; startedAt?: number }>
    ) => {
      const { channelId, userId, startedAt } = action.payload;

      if (!state.voiceMap[channelId]) return;

      delete state.voiceMap[channelId].users[userId];

      if (startedAt !== undefined) {
        state.voiceMap[channelId].startedAt = startedAt;
      } else {
        // No startedAt means session ended (no users left)
        delete state.voiceMap[channelId].startedAt;
      }
    },
    updateVoiceUserState: (
      state,
      action: PayloadAction<{
        channelId: number;
        userId: number;
        newState: Partial<TVoiceUserState>;
      }>
    ) => {
      const { channelId, userId, newState } = action.payload;

      if (!state.voiceMap[channelId]) return;
      if (!state.voiceMap[channelId].users[userId]) return;

      state.voiceMap[channelId].users[userId] = {
        ...state.voiceMap[channelId].users[userId],
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
    addPluginCommand: (state, action: PayloadAction<TCommandInfo>) => {
      const { pluginId } = action.payload;

      if (!state.pluginCommands[pluginId]) {
        state.pluginCommands[pluginId] = [];
      }

      const exists = state.pluginCommands[pluginId].find(
        (c) => c.name === action.payload.name
      );

      if (exists) return;

      state.pluginCommands[pluginId].push(action.payload);
    },
    removePluginCommand: (
      state,
      action: PayloadAction<{ commandName: string }>
    ) => {
      const { commandName } = action.payload;

      for (const pluginId in state.pluginCommands) {
        state.pluginCommands[pluginId] = state.pluginCommands[pluginId].filter(
          (c) => c.name !== commandName
        );
      }
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
