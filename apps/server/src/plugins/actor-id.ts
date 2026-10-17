/**
 * The auth-side id shape of a plugin's actor account. Kept free of
 * imports so the user projections can label those rows without
 * pulling the actor module (and its db/publisher graph) into theirs.
 */
const PLUGIN_ACTOR_AUTH_PREFIX = 'plugin:';

/** Whether a users row is a plugin's actor account (by its auth-side id). */
const isPluginActorAuthId = (supabaseId: string): boolean =>
  supabaseId.startsWith(PLUGIN_ACTOR_AUTH_PREFIX);

export { isPluginActorAuthId, PLUGIN_ACTOR_AUTH_PREFIX };
