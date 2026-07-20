import { t } from '../../utils/trpc';
import { closeProducerRoute } from './close-producer';
import { connectConsumerTransportRoute } from './connect-consumer-transport';
import { connectProducerTransportRoute } from './connect-producer-transport';
import { disconnectUserRoute } from './disconnect-user';
import { moderateMemberRoute } from './moderate-member';
import { consumeRoute } from './consume';
import { createConsumerTransportRoute } from './create-consumer-transport';
import { createProducerTransportRoute } from './create-producer-transport';
import {
  onUserJoinVoiceRoute,
  onUserLeaveVoiceRoute,
  onUserUpdateVoiceStateRoute,
  onVoiceAddExternalStreamRoute,
  onVoiceNewProducerRoute,
  onVoiceProducerClosedRoute,
  onVoiceRemoveExternalStreamRoute,
  onVoiceUpdateExternalStreamRoute
} from './events';
import { getProducersRoute } from './get-producers';
import { getStreamPreviewRoute } from './get-stream-preview';
import { joinVoiceRoute } from './join';
import { leaveVoiceRoute } from './leave';
import { produceRoute } from './produce';
import { restartIceRoute } from './restart-ice';
import { updateVoiceStateRoute } from './update-state';
import { updateStreamPreviewRoute } from './update-stream-preview';

export const voiceRouter = t.router({
  join: joinVoiceRoute,
  leave: leaveVoiceRoute,
  disconnectUser: disconnectUserRoute,
  moderateMember: moderateMemberRoute,
  updateState: updateVoiceStateRoute,
  updateStreamPreview: updateStreamPreviewRoute,
  getStreamPreview: getStreamPreviewRoute,
  createProducerTransport: createProducerTransportRoute,
  connectProducerTransport: connectProducerTransportRoute,
  createConsumerTransport: createConsumerTransportRoute,
  connectConsumerTransport: connectConsumerTransportRoute,
  closeProducer: closeProducerRoute,
  produce: produceRoute,
  consume: consumeRoute,
  getProducers: getProducersRoute,
  restartIce: restartIceRoute,
  onJoin: onUserJoinVoiceRoute,
  onLeave: onUserLeaveVoiceRoute,
  onUpdateState: onUserUpdateVoiceStateRoute,
  onNewProducer: onVoiceNewProducerRoute,
  onProducerClosed: onVoiceProducerClosedRoute,
  onAddExternalStream: onVoiceAddExternalStreamRoute,
  onUpdateExternalStream: onVoiceUpdateExternalStreamRoute,
  onRemoveExternalStream: onVoiceRemoveExternalStreamRoute
});
