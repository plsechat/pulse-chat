import { useDmCall, useOwnDmCallChannelId } from '@/features/dms/hooks';
import { joinDmVoiceCall, leaveDmVoiceCall } from '@/features/dms/actions';
import { useVoice } from '@/features/server/voice/hooks';
import { useUserById } from '@/features/server/users/hooks';
import { Phone, PhoneOff } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';

type TDmCallBannerProps = {
  dmChannelId: number;
};

const DmCallBanner = memo(({ dmChannelId }: TDmCallBannerProps) => {
  const call = useDmCall(dmChannelId);
  const ownDmCallChannelId = useOwnDmCallChannelId();
  const [joining, setJoining] = useState(false);
  const { init } = useVoice();

  const isInThisCall = ownDmCallChannelId === dmChannelId;
  const userIds = call ? Object.keys(call.users).map(Number) : [];

  const handleJoin = useCallback(async () => {
    if (joining) return;
    setJoining(true);
    try {
      const result = await joinDmVoiceCall(dmChannelId);
      if (result) {
        await init(result.routerRtpCapabilities, dmChannelId);
      }
    } catch {
      toast.error('Failed to join call');
    } finally {
      setJoining(false);
    }
  }, [dmChannelId, joining, init]);

  const handleLeave = useCallback(async () => {
    try {
      await leaveDmVoiceCall();
    } catch {
      toast.error('Failed to leave call');
    }
  }, []);

  if (!call || userIds.length === 0) return null;

  return (
    <div className="flex items-center gap-3 bg-green-500/10 border-b border-green-500/20 px-4 py-2">
      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-green-500/20">
        <Phone className="h-3.5 w-3.5 text-green-500 animate-pulse" />
      </div>
      <div className="flex-1 flex items-center gap-2 text-sm">
        <span className="text-green-500 font-medium">Voice call active</span>
        <span className="text-muted-foreground/60">·</span>
        <span className="text-muted-foreground">
          {userIds.length} {userIds.length === 1 ? 'participant' : 'participants'}
        </span>
        <div className="flex items-center gap-1">
          {userIds.slice(0, 3).map((userId) => (
            <CallParticipantName key={userId} userId={userId} />
          ))}
          {userIds.length > 3 && (
            <span className="text-xs text-muted-foreground">
              +{userIds.length - 3} more
            </span>
          )}
        </div>
      </div>
      {isInThisCall ? (
        <button
          type="button"
          onClick={handleLeave}
          className="flex items-center gap-1.5 rounded-md bg-destructive/20 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/30 transition-colors"
        >
          <PhoneOff className="h-3.5 w-3.5" />
          Leave
        </button>
      ) : (
        <button
          type="button"
          onClick={handleJoin}
          disabled={joining || !!ownDmCallChannelId}
          className="flex items-center gap-1.5 rounded-md bg-emerald-600/20 px-3 py-1.5 text-xs font-medium text-emerald-400 hover:bg-emerald-600/30 transition-colors disabled:opacity-50"
        >
          <Phone className="h-3.5 w-3.5" />
          {joining ? 'Joining...' : 'Join'}
        </button>
      )}
    </div>
  );
});

const CallParticipantName = memo(({ userId }: { userId: number }) => {
  const user = useUserById(userId);
  if (!user) return null;
  return (
    <span className="text-xs text-emerald-400/70">{user.name}</span>
  );
});

export { DmCallBanner };
