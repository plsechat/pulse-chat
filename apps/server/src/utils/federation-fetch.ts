/**
 * Wraps fetch with `redirect: 'manual'`. Federation endpoints (peer
 * instances, federated avatar/file downloads) must respond directly;
 * redirects are an SSRF pivot vector even after the original URL has been
 * validated by `validateFederationUrl` — the redirect target is never
 * re-validated by the runtime.
 *
 * Treats 3xx and `status === 0` (opaque redirect) as errors.
 *
 * Does NOT pin DNS — DNS rebinding / TOCTOU between validation and connect
 * is a separate Phase 4 hardening item (requires a custom undici dispatcher
 * or lookup hook). For now this only closes the redirect-SSRF vector.
 */
export async function federationFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    redirect: 'manual'
  });

  if (response.status === 0) {
    // Opaque redirect (cross-origin or any redirect with redirect:'manual').
    throw new Error(`Refusing opaque redirect from ${url}`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `Refusing redirect from ${url} (status ${response.status})`
    );
  }

  return response;
}
