import type { TDevices } from '@/types';
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { TServerSummary } from '@pulse/shared';

export type TActiveView = 'home' | 'server' | 'discover';

export type TFederatedServerEntry = {
  instanceDomain: string;
  instanceName: string;
  remoteUrl: string;
  server: TServerSummary;
  federationToken: string;
  tokenExpiresAt: number;
};

export interface TAppState {
  loading: boolean;
  devices: TDevices | undefined;
  modViewOpen: boolean;
  modViewUserId?: number;
  activeView: TActiveView;
  joinedServers: TServerSummary[];
  activeServerId: number | undefined;
  federatedServers: TFederatedServerEntry[];
  activeInstanceDomain: string | null;
  serverUnreadCounts: Record<number, number>;
  serverMentionCounts: Record<number, number>;
  federatedConnectionStatuses: Record<
    string,
    'connecting' | 'connected' | 'disconnected'
  >;
}

const initialState: TAppState = {
  loading: true,
  devices: undefined,
  modViewOpen: false,
  modViewUserId: undefined,
  activeView: 'home',
  joinedServers: [],
  activeServerId: undefined,
  federatedServers: [],
  activeInstanceDomain: null,
  serverUnreadCounts: {},
  serverMentionCounts: {},
  federatedConnectionStatuses: {}
};

export const appSlice = createSlice({
  name: 'app',
  initialState,
  reducers: {
    setAppLoading: (state, action: PayloadAction<boolean>) => {
      state.loading = action.payload;
    },
    setDevices: (state, action: PayloadAction<TDevices>) => {
      state.devices = action.payload;
    },
    setModViewOpen: (
      state,
      action: PayloadAction<{
        modViewOpen: boolean;
        userId?: number;
      }>
    ) => {
      state.modViewOpen = action.payload.modViewOpen;
      state.modViewUserId = action.payload.userId;
    },
    setActiveView: (state, action: PayloadAction<TActiveView>) => {
      state.activeView = action.payload;
    },
    setJoinedServers: (state, action: PayloadAction<TServerSummary[]>) => {
      state.joinedServers = action.payload;
    },
    addJoinedServer: (state, action: PayloadAction<TServerSummary>) => {
      const exists = state.joinedServers.find(
        (s) => s.id === action.payload.id
      );
      if (!exists) {
        state.joinedServers.push(action.payload);
      }
    },
    removeJoinedServer: (state, action: PayloadAction<number>) => {
      state.joinedServers = state.joinedServers.filter(
        (s) => s.id !== action.payload
      );
      if (state.activeServerId === action.payload) {
        state.activeServerId = undefined;
      }
    },
    reorderJoinedServers: (state, action: PayloadAction<number[]>) => {
      const serverMap = new Map(
        state.joinedServers.map((s) => [s.id, s])
      );
      state.joinedServers = action.payload
        .map((id) => serverMap.get(id))
        .filter((s): s is TServerSummary => !!s);
    },
    setActiveServerId: (state, action: PayloadAction<number | undefined>) => {
      state.activeServerId = action.payload;
    },
    setFederatedServers: (
      state,
      action: PayloadAction<TFederatedServerEntry[]>
    ) => {
      state.federatedServers = action.payload;
    },
    addFederatedServer: (
      state,
      action: PayloadAction<TFederatedServerEntry>
    ) => {
      const exists = state.federatedServers.find(
        (s) =>
          s.instanceDomain === action.payload.instanceDomain &&
          s.server.id === action.payload.server.id
      );
      if (!exists) {
        state.federatedServers.push(action.payload);
      }
    },
    removeFederatedServer: (
      state,
      action: PayloadAction<{
        instanceDomain: string;
        serverId: number;
      }>
    ) => {
      state.federatedServers = state.federatedServers.filter(
        (s) =>
          !(
            s.instanceDomain === action.payload.instanceDomain &&
            s.server.id === action.payload.serverId
          )
      );
    },
    setActiveInstanceDomain: (
      state,
      action: PayloadAction<string | null>
    ) => {
      state.activeInstanceDomain = action.payload;
    },
    updateFederatedToken: (
      state,
      action: PayloadAction<{
        instanceDomain: string;
        token: string;
        expiresAt: number;
      }>
    ) => {
      for (const entry of state.federatedServers) {
        if (entry.instanceDomain === action.payload.instanceDomain) {
          entry.federationToken = action.payload.token;
          entry.tokenExpiresAt = action.payload.expiresAt;
        }
      }
    },
    setServerUnreadCounts: (
      state,
      action: PayloadAction<Record<number, number>>
    ) => {
      state.serverUnreadCounts = action.payload;
    },
    setServerUnreadCount: (
      state,
      action: PayloadAction<{ serverId: number; count: number; mentionCount: number }>
    ) => {
      const { serverId, count, mentionCount } = action.payload;
      if (count === -1) {
        state.serverUnreadCounts[serverId] =
          (state.serverUnreadCounts[serverId] ?? 0) + 1;
      } else if (count > 0) {
        state.serverUnreadCounts[serverId] = count;
      } else {
        delete state.serverUnreadCounts[serverId];
      }
      // Handle mention count the same way (-1 = increment, 0 = clear)
      if (mentionCount === -1) {
        state.serverMentionCounts[serverId] =
          (state.serverMentionCounts[serverId] ?? 0) + 1;
      } else if (mentionCount > 0) {
        state.serverMentionCounts[serverId] = mentionCount;
      } else {
        delete state.serverMentionCounts[serverId];
      }
    },
    setServerMentionCounts: (
      state,
      action: PayloadAction<Record<number, number>>
    ) => {
      state.serverMentionCounts = action.payload;
    },
    setFederatedConnectionStatus: (
      state,
      action: PayloadAction<{
        instanceDomain: string;
        status: 'connecting' | 'connected' | 'disconnected';
      }>
    ) => {
      state.federatedConnectionStatuses[action.payload.instanceDomain] =
        action.payload.status;
    },
    clearFederatedConnectionStatus: (
      state,
      action: PayloadAction<string>
    ) => {
      delete state.federatedConnectionStatuses[action.payload];
    }
  }
});

const appSliceActions = appSlice.actions;
const appSliceReducer = appSlice.reducer;

export { appSliceActions, appSliceReducer };
