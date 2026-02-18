// Sender Keys for E2EE channels (Phase 2)
// Placeholder - will be implemented when channel E2EE is added

export async function generateSenderKey(
  _channelId: number,
  _userId: number
): Promise<string> {
  throw new Error('Sender Keys not yet implemented (Phase 2)');
}

export async function encryptWithSenderKey(
  _channelId: number,
  _plaintext: string
): Promise<string> {
  throw new Error('Sender Keys not yet implemented (Phase 2)');
}

export async function decryptWithSenderKey(
  _channelId: number,
  _fromUserId: number,
  _ciphertext: string
): Promise<string> {
  throw new Error('Sender Keys not yet implemented (Phase 2)');
}
