export type E2EEPlaintext = {
  content: string;
  fileKeys?: {
    fileId: string;
    key: string;
    nonce: string;
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
