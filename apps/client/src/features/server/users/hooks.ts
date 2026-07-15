import type { IRootState } from '@/features/store';
import { useSelector } from 'react-redux';
import {
  homeOwnUserIdSelector,
  homeUserByIdSelector,
  isOwnUserSelector,
  ownPublicUserSelector,
  ownUserIdSelector,
  ownUserSelector,
  userByIdSelector,
  usernamesSelector,
  usersSelector,
  userStatusSelector
} from './selectors';

export const useUsers = () => useSelector(usersSelector);

export const useOwnUser = () => useSelector(ownUserSelector);

export const useOwnUserId = () => useSelector(ownUserIdSelector);
export const useHomeOwnUserId = () => useSelector(homeOwnUserIdSelector);

export const useIsOwnUser = (userId: number) =>
  useSelector((state: IRootState) => isOwnUserSelector(state, userId));

export const useUserById = (userId: number) =>
  useSelector((state: IRootState) => userByIdSelector(state, userId));

/**
 * HOME id-space user resolution — required on home-scoped surfaces (DM
 * conversations, DM sidebar, friends) whose ids never refer to the
 * ambient (possibly remote) roster. See homeUserByIdSelector.
 */
export const useHomeUserById = (userId: number) =>
  useSelector((state: IRootState) => homeUserByIdSelector(state, userId));

export const useOwnPublicUser = () =>
  useSelector((state: IRootState) => ownPublicUserSelector(state));

export const useUserStatus = (userId: number) =>
  useSelector((state: IRootState) => userStatusSelector(state, userId));

export const useUsernames = () => useSelector(usernamesSelector);
