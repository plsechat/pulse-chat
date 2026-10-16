import { getLocalStorageItem, LocalStorageKey } from '@/helpers/storage';
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  TJoinedDmChannel,
  TJoinedDmMessage,
  TJoinedPublicUser,
  TVoiceUserState,
  UserStatus
} from '@pulse/shared';

export type TDmMessagesMap = {
  [dmChannelId: number]: TJoinedDmMessage[];
};

export type TDmCallState = {
  dmChannelId: number;
  users: { [userId: number]: TVoiceUserState };
};

export type TDmCallsMap = {
  [dmChannelId: number]: TDmCallState;
};

export interface TDmsState {
  channels: TJoinedDmChannel[];
  // False until the first channel list arrives. HomeView deselects a DM
  // that is missing from the list; without this gate a reload (list
  // still in flight) bounced the restored DM straight back to Friends.
  channelsLoaded: boolean;
  selectedChannelId: number | undefined;
  messagesMap: TDmMessagesMap;
  activeCalls: TDmCallsMap;
  ownDmCallChannelId: number | undefined;
  dmTypingMap: Record<number, number[]>;
  // dmChannelIds with a fresh call_started event we haven't yet
  // accepted or dismissed. Drives the global IncomingCallModal so
  // the ring follows the user across views.
  ringingCalls: number[];
}

// The open DM survives a reload: Redux is the source of truth and the
// setSelectedDmChannelId action mirrors it to storage, so the slice
// starts from the mirror instead of a component re-syncing it on mount.
const readPersistedSelection = (): number | undefined => {
  const saved = getLocalStorageItem(LocalStorageKey.ACTIVE_DM_CHANNEL_ID);
  const id = saved ? Number(saved) : Number.NaN;
  return Number.isFinite(id) ? id : undefined;
};

const initialState: TDmsState = {
  channels: [],
  channelsLoaded: false,
  selectedChannelId: readPersistedSelection(),
  messagesMap: {},
  activeCalls: {},
  ownDmCallChannelId: undefined,
  dmTypingMap: {},
  ringingCalls: []
};

export const dmsSlice = createSlice({
  name: 'dms',
  initialState,
  reducers: {
    resetState: () => initialState,
    setChannels: (state, action: PayloadAction<TJoinedDmChannel[]>) => {
      state.channels = action.payload;
      state.channelsLoaded = true;
    },
    addOrUpdateChannel: (state, action: PayloadAction<TJoinedDmChannel>) => {
      const idx = state.channels.findIndex(
        (c) => c.id === action.payload.id
      );
      if (idx === -1) {
        state.channels.unshift(action.payload);
      } else {
        state.channels[idx] = action.payload;
      }
    },
    removeChannel: (state, action: PayloadAction<number>) => {
      state.channels = state.channels.filter((c) => c.id !== action.payload);
      if (state.selectedChannelId === action.payload) {
        state.selectedChannelId = undefined;
      }
      delete state.messagesMap[action.payload];
      delete state.dmTypingMap[action.payload];
      // Its call goes with the channel: no runtime survives the row.
      delete state.activeCalls[action.payload];
      if (state.ownDmCallChannelId === action.payload) {
        state.ownDmCallChannelId = undefined;
      }
      state.ringingCalls = state.ringingCalls.filter(
        (id) => id !== action.payload
      );
    },
    // Presence transitions arrive as USER_JOIN/USER_LEAVE/USER_UPDATE
    // events; without mirroring them onto the cached member projections
    // the DM sidebar/panel would only refresh status on a full refetch.
    updateMemberPresence: (
      state,
      action: PayloadAction<{ userId: number; status?: UserStatus }>
    ) => {
      for (const channel of state.channels) {
        const member = channel.members.find(
          (m) => m.id === action.payload.userId
        );
        if (member) {
          member.status = action.payload.status;
        }
      }
    },
    // Full-profile mirror for USER_UPDATE: without it, cosmetics
    // (nameplate/decoration/name style), avatar, and name changes on a
    // DM partner who is neither a friend nor a co-member stay stale
    // until a full refetch — the cached projection is that partner's
    // ONLY live representation. Matched by publicId when both sides
    // carry one (numeric ids collide across federated instances).
    updateMemberProfile: (
      state,
      action: PayloadAction<TJoinedPublicUser>
    ) => {
      const patch = action.payload;
      for (const channel of state.channels) {
        const idx = channel.members.findIndex((m) =>
          patch.publicId && m.publicId
            ? m.publicId === patch.publicId
            : m.id === patch.id
        );
        if (idx !== -1) {
          const prev = channel.members[idx];
          channel.members[idx] = {
            ...prev,
            ...patch,
            // Profile-only USER_UPDATEs omit status — never wipe
            // presence with undefined.
            status: patch.status ?? prev.status
          };
        }
      }
    },
    setSelectedChannelId: (
      state,
      action: PayloadAction<number | undefined>
    ) => {
      state.selectedChannelId = action.payload;
    },
    addMessages: (
      state,
      action: PayloadAction<{
        dmChannelId: number;
        messages: TJoinedDmMessage[];
        opts?: { prepend?: boolean };
      }>
    ) => {
      const { dmChannelId, messages, opts } = action.payload;
      const existing = state.messagesMap[dmChannelId] ?? [];

      const existingIds = new Set(existing.map((m) => m.id));
      const filtered = messages.filter((m) => !existingIds.has(m.id));

      let merged: TJoinedDmMessage[];
      if (opts?.prepend) {
        merged = [...filtered, ...existing];
      } else {
        merged = [...existing, ...filtered];
      }

      state.messagesMap[dmChannelId] = merged.sort(
        (a, b) => a.createdAt - b.createdAt
      );
    },
    updateMessage: (
      state,
      action: PayloadAction<TJoinedDmMessage>
    ) => {
      const messages = state.messagesMap[action.payload.dmChannelId];
      if (!messages) return;

      const idx = messages.findIndex((m) => m.id === action.payload.id);
      if (idx === -1) return;

      messages[idx] = action.payload;
    },
    deleteMessage: (
      state,
      action: PayloadAction<{ dmChannelId: number; dmMessageId: number }>
    ) => {
      const messages = state.messagesMap[action.payload.dmChannelId];
      if (!messages) return;

      state.messagesMap[action.payload.dmChannelId] = messages.filter(
        (m) => m.id !== action.payload.dmMessageId
      );
    },
    updateChannelLastMessage: (
      state,
      action: PayloadAction<{
        dmChannelId: number;
        lastMessage: TJoinedDmMessage;
      }>
    ) => {
      const channel = state.channels.find(
        (c) => c.id === action.payload.dmChannelId
      );
      if (channel) {
        channel.lastMessage = action.payload.lastMessage;
      }
    },
    dmCallStarted: (
      state,
      action: PayloadAction<{ dmChannelId: number; startedBy: number }>
    ) => {
      const { dmChannelId } = action.payload;
      if (!state.activeCalls[dmChannelId]) {
        state.activeCalls[dmChannelId] = { dmChannelId, users: {} };
      }
    },
    dmCallEnded: (
      state,
      action: PayloadAction<{ dmChannelId: number }>
    ) => {
      delete state.activeCalls[action.payload.dmChannelId];
      if (state.ownDmCallChannelId === action.payload.dmChannelId) {
        state.ownDmCallChannelId = undefined;
      }
    },
    dmCallUserJoined: (
      state,
      action: PayloadAction<{
        dmChannelId: number;
        userId: number;
        state: TVoiceUserState;
      }>
    ) => {
      const { dmChannelId, userId } = action.payload;
      if (!state.activeCalls[dmChannelId]) {
        state.activeCalls[dmChannelId] = { dmChannelId, users: {} };
      }
      state.activeCalls[dmChannelId].users[userId] = action.payload.state;
    },
    dmCallUserLeft: (
      state,
      action: PayloadAction<{ dmChannelId: number; userId: number }>
    ) => {
      const { dmChannelId, userId } = action.payload;
      const call = state.activeCalls[dmChannelId];
      if (call) {
        delete call.users[userId];
      }
    },
    setOwnDmCallChannelId: (
      state,
      action: PayloadAction<number | undefined>
    ) => {
      state.ownDmCallChannelId = action.payload;
    },
    // A fresh dms.getActiveCalls snapshot, taken on every (re)connect. The
    // socket close that precedes a reconnect evicts us from voice
    // server-side, and a call can end entirely while we are away — so a
    // call we still think we are in, but whose roster no longer lists us,
    // is dead. Dropping it here is what makes the banner's Leave button
    // and the home-view "in call" state stop describing a session that
    // does not exist (the reconnect rejoin re-enters it when it can).
    reconcileActiveCalls: (
      state,
      action: PayloadAction<{
        calls: {
          dmChannelId: number;
          users: { userId: number; state: TVoiceUserState }[];
        }[];
        ownUserId: number | undefined;
      }>
    ) => {
      const next: TDmCallsMap = {};
      for (const call of action.payload.calls) {
        next[call.dmChannelId] = {
          dmChannelId: call.dmChannelId,
          users: Object.fromEntries(
            call.users.map((u) => [u.userId, u.state])
          )
        };
      }
      state.activeCalls = next;

      const own = state.ownDmCallChannelId;
      if (own === undefined) return;
      const roster = next[own]?.users;
      const stillIn =
        roster !== undefined &&
        action.payload.ownUserId !== undefined &&
        action.payload.ownUserId in roster;
      if (!stillIn) {
        state.ownDmCallChannelId = undefined;
      }
    },
    // DM_READ_STATE_UPDATE from another device/tab of the same user.
    // Clear when the marker covers the newest message we know about;
    // otherwise recount from loaded messages (a message arrived after
    // the other device read), or leave the badge alone if none loaded.
    applyReadState: (
      state,
      action: PayloadAction<{ dmChannelId: number; lastReadMessageId: number }>
    ) => {
      const { dmChannelId, lastReadMessageId } = action.payload;
      const channel = state.channels.find((c) => c.id === dmChannelId);
      if (!channel) return;

      if (!channel.lastMessage || channel.lastMessage.id <= lastReadMessageId) {
        channel.unreadCount = 0;
        return;
      }

      const loaded = state.messagesMap[dmChannelId];
      if (loaded) {
        channel.unreadCount = loaded.filter(
          (m) => m.id > lastReadMessageId
        ).length;
      }
    },
    clearChannelUnread: (state, action: PayloadAction<number>) => {
      const channel = state.channels.find((c) => c.id === action.payload);
      if (channel) {
        channel.unreadCount = 0;
      }
    },
    incrementChannelUnread: (state, action: PayloadAction<number>) => {
      const channel = state.channels.find((c) => c.id === action.payload);
      if (channel) {
        channel.unreadCount = (channel.unreadCount ?? 0) + 1;
      }
    },
    clearAllUnread: (state) => {
      for (const channel of state.channels) {
        channel.unreadCount = 0;
      }
    },
    addDmTypingUser: (
      state,
      action: PayloadAction<{ dmChannelId: number; userId: number }>
    ) => {
      const { dmChannelId, userId } = action.payload;
      if (!state.dmTypingMap[dmChannelId]) {
        state.dmTypingMap[dmChannelId] = [];
      }
      if (!state.dmTypingMap[dmChannelId].includes(userId)) {
        state.dmTypingMap[dmChannelId].push(userId);
      }
    },
    removeDmTypingUser: (
      state,
      action: PayloadAction<{ dmChannelId: number; userId: number }>
    ) => {
      const { dmChannelId, userId } = action.payload;
      if (state.dmTypingMap[dmChannelId]) {
        state.dmTypingMap[dmChannelId] = state.dmTypingMap[dmChannelId].filter(
          (id) => id !== userId
        );
      }
    },
    addRingingCall: (state, action: PayloadAction<number>) => {
      if (!state.ringingCalls.includes(action.payload)) {
        state.ringingCalls.push(action.payload);
      }
    },
    removeRingingCall: (state, action: PayloadAction<number>) => {
      state.ringingCalls = state.ringingCalls.filter(
        (id) => id !== action.payload
      );
    }
  }
});

const dmsSliceActions = dmsSlice.actions;
const dmsSliceReducer = dmsSlice.reducer;

export { dmsSliceActions, dmsSliceReducer };
