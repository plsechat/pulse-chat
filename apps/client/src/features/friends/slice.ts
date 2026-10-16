import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  TJoinedFriendRequest,
  TJoinedPublicUser
} from '@pulse/server/types';

export interface TFriendsState {
  friends: TJoinedPublicUser[];
  requests: TJoinedFriendRequest[];
  blocked: TJoinedPublicUser[];
}

const initialState: TFriendsState = {
  friends: [],
  requests: [],
  blocked: []
};

export const friendsSlice = createSlice({
  name: 'friends',
  initialState,
  reducers: {
    resetState: () => initialState,
    setFriends: (state, action: PayloadAction<TJoinedPublicUser[]>) => {
      state.friends = action.payload;
    },
    addFriend: (state, action: PayloadAction<TJoinedPublicUser>) => {
      if (!state.friends.find((f) => f.id === action.payload.id)) {
        state.friends.push(action.payload);
      }
    },
    removeFriend: (state, action: PayloadAction<number>) => {
      state.friends = state.friends.filter((f) => f.id !== action.payload);
    },
    setRequests: (state, action: PayloadAction<TJoinedFriendRequest[]>) => {
      state.requests = action.payload;
    },
    addRequest: (state, action: PayloadAction<TJoinedFriendRequest>) => {
      if (!state.requests.find((r) => r.id === action.payload.id)) {
        state.requests.push(action.payload);
      }
    },
    removeRequest: (state, action: PayloadAction<number>) => {
      state.requests = state.requests.filter((r) => r.id !== action.payload);
    },
    updateFriend: (
      state,
      action: PayloadAction<{
        userId: number;
        data: Partial<TJoinedPublicUser>;
      }>
    ) => {
      const friend = state.friends.find(
        (f) => f.id === action.payload.userId
      );
      if (friend) {
        Object.assign(friend, action.payload.data);
      }
    },
    setBlocked: (state, action: PayloadAction<TJoinedPublicUser[]>) => {
      state.blocked = action.payload;
    }
  }
});

const friendsSliceActions = friendsSlice.actions;
const friendsSliceReducer = friendsSlice.reducer;

export { friendsSliceActions, friendsSliceReducer };
