import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  TJoinedDmChannel,
  TJoinedDmMessage,
  TVoiceUserState
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
  selectedChannelId: number | undefined;
  messagesMap: TDmMessagesMap;
  activeCalls: TDmCallsMap;
  ownDmCallChannelId: number | undefined;
  dmTypingMap: Record<number, number[]>;
  loading: boolean;
}

const initialState: TDmsState = {
  channels: [],
  selectedChannelId: undefined,
  messagesMap: {},
  activeCalls: {},
  ownDmCallChannelId: undefined,
  dmTypingMap: {},
  loading: false
};

export const dmsSlice = createSlice({
  name: 'dms',
  initialState,
  reducers: {
    resetState: () => initialState,
    setChannels: (state, action: PayloadAction<TJoinedDmChannel[]>) => {
      state.channels = action.payload;
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
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.loading = action.payload;
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
    }
  }
});

const dmsSliceActions = dmsSlice.actions;
const dmsSliceReducer = dmsSlice.reducer;

export { dmsSliceActions, dmsSliceReducer };
