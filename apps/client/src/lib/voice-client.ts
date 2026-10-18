/**
 * Which tRPC client a voice call goes through.
 *
 * A voice session is pinned to the instance that hosts it when the join
 * succeeds; the ACTIVE instance (whatever the user is browsing) keeps
 * changing underneath it. Routing voice calls by the active instance sent
 * mic/sound/webcam toggles, closeProducer, restartIce, updateState and
 * leave to whichever server was in focus — "User is not in a voice
 * channel" on that one, and the real session left alive on the other.
 *
 * `undefined` = home. A remote that is not connected resolves to null,
 * never to the home client: a voice mutation on the wrong instance is a
 * write to the wrong server (the same rule getTRPCClient follows for
 * instance-scoped data). Callers already guard null.
 *
 * Kept free of imports so the resolver is testable without the module
 * replacements the connection harness installs over lib/trpc.
 */
export const resolveVoiceTRPCClient = <T>(
  voiceInstanceDomain: string | undefined,
  getRemoteClient: (instanceDomain: string) => T | null,
  getHomeClient: () => T | null
): T | null =>
  voiceInstanceDomain ? getRemoteClient(voiceInstanceDomain) : getHomeClient();
