export type E2EEPlaintext = {
  content: string;
  fileKeys?: {
    fileId: string;
    key: string;
    nonce: string;
    mimeType: string;
    /**
     * Real filename, encrypted in transit. Server stores a placeholder
     * UUID name in `files.original_name`; this field is the only place
     * the real name lives. Always present on uploads sent post-E8.
     */
    originalName?: string;
    /**
     * Real extension (with leading dot, e.g. `.png`). Server stores a
     * placeholder `.bin` in `files.extension`; this is the real one.
     * Always present on uploads sent post-E8.
     */
    extension?: string;
  }[];
};

export type PreKeyBundle = {
  identityPublicKey: string;
  registrationId: number;
  signedPreKey: {
    keyId: number;
    publicKey: string;
    signature: string;
  };
  oneTimePreKey: {
    keyId: number;
    publicKey: string;
  } | null;
};

export type SenderKeyDistribution = {
  channelId: number;
  fromUserId: number;
  distributionMessage: string;
};
