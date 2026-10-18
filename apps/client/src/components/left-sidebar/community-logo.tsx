import {
  useConnectedInstanceDomain,
  usePublicServerSettings,
  useServerName
} from '@/features/server/hooks';
import { getFileUrl } from '@/helpers/get-file-url';
import { memo } from 'react';

/**
 * The community header's logo tile: the CONNECTED community's own logo,
 * served by the instance that owns it, or the community's initial.
 *
 * `state.server.info.logo` is deliberately not a fallback — it is the
 * home /info payload's FIRST community, so it is a stranger's logo for
 * every other home community and for every federated one (whose file
 * also lives on the peer, not on the home host). The connected domain
 * flips with setInitialData, so a federated tab never shows the
 * previous community's logo under the new community's name.
 */
const CommunityLogo = memo(() => {
  const serverName = useServerName();
  const logo = usePublicServerSettings()?.logo ?? null;
  const connectedInstanceDomain = useConnectedInstanceDomain();

  return (
    <span className="squircle flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden bg-background/60 text-sm font-bold text-foreground ring-1 ring-white/10">
      {logo ? (
        <img
          src={getFileUrl(logo, connectedInstanceDomain)}
          alt=""
          className="h-full w-full object-cover"
        />
      ) : (
        (serverName ?? '?').charAt(0).toUpperCase()
      )}
    </span>
  );
});

export { CommunityLogo };
