import { ServerEvents, type StreamKind } from '@pulse/shared';
import { observable } from '@trpc/server/observable';
import type { TSoundPlayEvent } from '../../types';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure, userSubscription } from '../../utils/trpc';

type TVoiceProducerEvent = {
  channelId: number;
  remoteId: number;
  kind: StreamKind;
};

// User-scoped voice events (delivered to server members):
const onUserJoinVoiceRoute = userSubscription(ServerEvents.USER_JOIN_VOICE);
const onUserLeaveVoiceRoute = userSubscription(ServerEvents.USER_LEAVE_VOICE);
const onUserUpdateVoiceStateRoute = userSubscription(
  ServerEvents.USER_VOICE_STATE_UPDATE
);
const onVoiceAddExternalStreamRoute = userSubscription(
  ServerEvents.VOICE_ADD_EXTERNAL_STREAM
);
const onVoiceUpdateExternalStreamRoute = userSubscription(
  ServerEvents.VOICE_UPDATE_EXTERNAL_STREAM
);
const onVoiceRemoveExternalStreamRoute = userSubscription(
  ServerEvents.VOICE_REMOVE_EXTERNAL_STREAM
);

// These events are room-scoped (only sent to users in the same voice
// runtime) and relate to actual media streaming, not UI state. The topic
// is the runtime KEY ("channel:5" / "dm:5"), never the bare id: a DM call
// and a server channel with the same id are different rooms. No runtime
// for this connection's session → an empty observable.
const onVoiceNewProducerRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    const runtime = VoiceRuntime.findByCtx(ctx);

    if (!runtime) {
      return observable<TVoiceProducerEvent>(() => () => {});
    }

    return ctx.pubsub.subscribeForChannel(
      runtime.key,
      ServerEvents.VOICE_NEW_PRODUCER
    );
  }
);

// A soundboard trigger is for the people in the room alone (they play
// the clip); the server-wide roster never sees it.
const onVoiceSoundPlayRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    const runtime = VoiceRuntime.findByCtx(ctx);

    if (!runtime) {
      return observable<TSoundPlayEvent>(() => () => {});
    }

    return ctx.pubsub.subscribeForChannel(
      runtime.key,
      ServerEvents.VOICE_SOUND_PLAY
    );
  }
);

const onVoiceProducerClosedRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    const runtime = VoiceRuntime.findByCtx(ctx);

    if (!runtime) {
      return observable<TVoiceProducerEvent>(() => () => {});
    }

    return ctx.pubsub.subscribeForChannel(
      runtime.key,
      ServerEvents.VOICE_PRODUCER_CLOSED
    );
  }
);

export {
  onUserJoinVoiceRoute,
  onUserLeaveVoiceRoute,
  onUserUpdateVoiceStateRoute,
  onVoiceAddExternalStreamRoute,
  onVoiceNewProducerRoute,
  onVoiceProducerClosedRoute,
  onVoiceRemoveExternalStreamRoute,
  onVoiceSoundPlayRoute,
  onVoiceUpdateExternalStreamRoute
};
