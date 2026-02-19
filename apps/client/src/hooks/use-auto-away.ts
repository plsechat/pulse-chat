import { getTRPCClient } from '@/lib/trpc';
import { UserStatus } from '@pulse/shared';
import { useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import { ownPublicUserSelector } from '@/features/server/users/selectors';
import type { IRootState } from '@/features/store';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

const ACTIVITY_EVENTS = [
  'mousemove',
  'keydown',
  'mousedown',
  'scroll',
  'touchstart'
] as const;

export const useAutoAway = () => {
  const ownUser = useSelector((state: IRootState) =>
    ownPublicUserSelector(state)
  );
  const currentStatus = ownUser?.status ?? UserStatus.OFFLINE;

  const isAutoIdleRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const statusRef = useRef(currentStatus);
  statusRef.current = currentStatus;

  type SetableStatus = UserStatus.ONLINE | UserStatus.IDLE | UserStatus.DND | UserStatus.INVISIBLE;

  useEffect(() => {
    const setStatus = (status: SetableStatus) => {
      const trpc = getTRPCClient();
      trpc.users.setStatus.mutate({ status }).catch(() => {});
    };

    const goIdle = () => {
      // Only auto-idle if user is currently ONLINE
      if (statusRef.current !== UserStatus.ONLINE) return;
      isAutoIdleRef.current = true;
      setStatus(UserStatus.IDLE);
    };

    const resetTimer = () => {
      clearTimeout(timerRef.current);

      // If we auto-set idle and user is active again, restore ONLINE
      if (isAutoIdleRef.current && statusRef.current === UserStatus.IDLE) {
        isAutoIdleRef.current = false;
        setStatus(UserStatus.ONLINE);
      }

      // Only schedule idle timeout if user is ONLINE
      if (
        statusRef.current === UserStatus.ONLINE ||
        (isAutoIdleRef.current && statusRef.current === UserStatus.IDLE)
      ) {
        timerRef.current = setTimeout(goIdle, IDLE_TIMEOUT_MS);
      }
    };

    // Start the initial timer
    timerRef.current = setTimeout(goIdle, IDLE_TIMEOUT_MS);

    for (const event of ACTIVITY_EVENTS) {
      document.addEventListener(event, resetTimer, { passive: true });
    }

    return () => {
      clearTimeout(timerRef.current);
      for (const event of ACTIVITY_EVENTS) {
        document.removeEventListener(event, resetTimer);
      }
    };
  }, []);

  // If user manually changes status (e.g. DND, INVISIBLE), clear auto-idle flag
  useEffect(() => {
    if (
      currentStatus !== UserStatus.IDLE ||
      !isAutoIdleRef.current
    ) {
      isAutoIdleRef.current = false;
    }
  }, [currentStatus]);
};
