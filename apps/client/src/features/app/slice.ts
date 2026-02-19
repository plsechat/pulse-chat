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
  activeInstanceDomain: null
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
    }
  }
});

const appSliceActions = appSlice.actions;
const appSliceReducer = appSlice.reducer;

export { appSliceActions, appSliceReducer };
