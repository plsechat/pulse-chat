export enum ServerEvents {
  NEW_MESSAGE = "newMessage",
  MESSAGE_UPDATE = "messageUpdate",
  MESSAGE_DELETE = "messageDelete",
  MESSAGE_BULK_DELETE = "messageBulkDelete",
  MESSAGE_TYPING = "messageTyping",

  USER_JOIN = "userJoin",
  USER_LEAVE = "userLeave",

  CHANNEL_CREATE = "channelCreate",
  CHANNEL_UPDATE = "channelUpdate",
  CHANNEL_DELETE = "channelDelete",
  CHANNEL_PERMISSIONS_UPDATE = "channelPermissionsUpdate",
  CHANNEL_READ_STATES_UPDATE = "channelReadStatesUpdate",

  USER_JOIN_VOICE = "userJoinVoice",
  USER_LEAVE_VOICE = "userLeaveVoice",
  USER_VOICE_STATE_UPDATE = "userVoiceStateUpdate",

  VOICE_ADD_EXTERNAL_STREAM = "voiceAddExternalStream",
  VOICE_UPDATE_EXTERNAL_STREAM = "voiceUpdateExternalStream",
  VOICE_REMOVE_EXTERNAL_STREAM = "voiceRemoveExternalStream",
  VOICE_NEW_PRODUCER = "voiceNewProducer",
  VOICE_PRODUCER_CLOSED = "voiceProducerClosed",

  EMOJI_CREATE = "emojiCreate",
  EMOJI_UPDATE = "emojiUpdate",
  EMOJI_DELETE = "emojiDelete",

  ROLE_CREATE = "roleCreate",
  ROLE_UPDATE = "roleUpdate",
  ROLE_DELETE = "roleDelete",

  USER_CREATE = "userCreate",
  USER_UPDATE = "userUpdate",
  USER_DELETE = "userDelete",

  SERVER_SETTINGS_UPDATE = "serverSettingsUpdate",

  PLUGIN_LOG = "pluginLog",
  PLUGIN_COMMANDS_CHANGE = "pluginCommandsChange",

  CATEGORY_CREATE = "categoryCreate",
  CATEGORY_UPDATE = "categoryUpdate",
  CATEGORY_DELETE = "categoryDelete",

  FRIEND_REQUEST_RECEIVED = "friendRequestReceived",
  FRIEND_REQUEST_ACCEPTED = "friendRequestAccepted",
  FRIEND_REQUEST_REJECTED = "friendRequestRejected",
  FRIEND_REMOVED = "friendRemoved",

  DM_NEW_MESSAGE = "dmNewMessage",
  DM_MESSAGE_UPDATE = "dmMessageUpdate",
  DM_MESSAGE_DELETE = "dmMessageDelete",
  DM_CHANNEL_UPDATE = "dmChannelUpdate",
  DM_CHANNEL_DELETE = "dmChannelDelete",
  DM_MEMBER_ADD = "dmMemberAdd",
  DM_MEMBER_REMOVE = "dmMemberRemove",
  DM_CALL_STARTED = "dmCallStarted",
  DM_CALL_ENDED = "dmCallEnded",
  DM_CALL_USER_JOINED = "dmCallUserJoined",
  DM_CALL_USER_LEFT = "dmCallUserLeft",
  DM_MESSAGE_TYPING = "dmMessageTyping",

  SERVER_MEMBER_JOIN = "serverMemberJoin",
  SERVER_MEMBER_LEAVE = "serverMemberLeave",
  SERVER_UNREAD_COUNT_UPDATE = "serverUnreadCountUpdate",

  MESSAGE_PIN = "messagePin",
  MESSAGE_UNPIN = "messageUnpin",

  THREAD_CREATE = "threadCreate",
  THREAD_UPDATE = "threadUpdate",
  THREAD_DELETE = "threadDelete",

  FEDERATION_INSTANCE_UPDATE = "federationInstanceUpdate",

  E2EE_SENDER_KEY_DISTRIBUTION = "e2eeSenderKeyDistribution",
  E2EE_IDENTITY_RESET = "e2eeIdentityReset",

  INVITE_CREATE = "inviteCreate",
  INVITE_DELETE = "inviteDelete",

  USER_NOTE_UPDATE = "userNoteUpdate",

  USER_KICKED = "userKicked",
}

export type TNewMessage = {
  content: string;
  channelId: number;
};
