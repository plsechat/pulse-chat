import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { TJoinedFriendRequest, TJoinedPublicUser } from '@pulse/shared';

export interface TFriendsState {
  friends: TJoinedPublicUser[];
  requests: TJoinedFriendRequest[];
  blocked: TJoinedPublicUser[];
  loading: boolean;
}

const initialState: TFriendsState = {
  friends: [],
  requests: [],
  blocked: [],
  loading: false
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
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.loading = action.payload;
    },
    setBlocked: (state, action: PayloadAction<TJoinedPublicUser[]>) => {
      state.blocked = action.payload;
    },
    addBlocked: (state, action: PayloadAction<TJoinedPublicUser>) => {
      if (!state.blocked.find((b) => b.id === action.payload.id)) {
        state.blocked.push(action.payload);
      }
      // Tear down friendship + requests for the blocked user locally so the
      // UI matches what the server just did. Without this the user lingers
      // in the friends list and requests list until a refresh.
      state.friends = state.friends.filter((f) => f.id !== action.payload.id);
      state.requests = state.requests.filter(
        (r) =>
          r.senderId !== action.payload.id && r.receiverId !== action.payload.id
      );
    },
    removeBlocked: (state, action: PayloadAction<number>) => {
      state.blocked = state.blocked.filter((b) => b.id !== action.payload);
    }
  }
});

const friendsSliceActions = friendsSlice.actions;
const friendsSliceReducer = friendsSlice.reducer;

export { friendsSliceActions, friendsSliceReducer };
