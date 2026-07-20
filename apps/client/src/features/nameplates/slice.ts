import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { TJoinedNameplate } from '@pulse/shared';

export interface TNameplatesState {
  /**
   * Custom nameplate packs of the ACTIVE server (home or federated) —
   * co-members' equipped 'custom:<id>' values resolve against these.
   * Pack ids are instance-local, so the list is cleared on every server
   * switch before the replacement fetch lands.
   */
  packs: TJoinedNameplate[];
  loaded: boolean;
}

const initialState: TNameplatesState = {
  packs: [],
  loaded: false
};

export const nameplatesSlice = createSlice({
  name: 'nameplates',
  initialState,
  reducers: {
    resetState: () => initialState,
    setPacks: (state, action: PayloadAction<TJoinedNameplate[]>) => {
      state.packs = action.payload;
      state.loaded = true;
    }
  }
});

const nameplatesSliceActions = nameplatesSlice.actions;
const nameplatesSliceReducer = nameplatesSlice.reducer;

export { nameplatesSliceActions, nameplatesSliceReducer };
