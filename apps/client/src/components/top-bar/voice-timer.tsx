import type { IRootState } from '@/features/store';
import type { TVoiceKind } from '@/features/server/voice/keys';
import { voiceSessionStartedAtSelector } from '@/features/server/voice/selectors';
import { useSelector } from 'react-redux';
import { memo, useEffect, useState } from 'react';

const formatDuration = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n: number) => n.toString().padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }

  return `${pad(minutes)}:${pad(seconds)}`;
};

type TVoiceTimerProps = {
  channelId: number;
  kind?: TVoiceKind;
};

const VoiceTimer = memo(({ channelId, kind = 'channel' }: TVoiceTimerProps) => {
  const startedAt = useSelector((state: IRootState) =>
    voiceSessionStartedAtSelector(state, channelId, kind)
  );
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startedAt) {
      setElapsed(0);
      return;
    }

    setElapsed(Math.max(0, Date.now() - startedAt));

    const interval = setInterval(() => {
      setElapsed(Math.max(0, Date.now() - startedAt));
    }, 1000);

    return () => clearInterval(interval);
  }, [startedAt]);

  if (!startedAt) return null;

  return (
    <span className="text-[10px] text-green-400 tabular-nums ml-auto shrink-0">
      {formatDuration(elapsed)}
    </span>
  );
});

VoiceTimer.displayName = 'VoiceTimer';

export { VoiceTimer };
