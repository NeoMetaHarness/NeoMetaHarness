const DEFAULT_GATEWAY = 'http://127.0.0.1:4321';

function configuredGateway(): URL {
  return new URL(import.meta.env?.VITE_NEO_GATEWAY_URL ?? DEFAULT_GATEWAY);
}

/** Loopback gateways (the desktop shell's dynamic port) or the build-time configured origin. */
function trustedGateway(url: URL): boolean {
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  return loopback || url.origin === configuredGateway().origin;
}

/**
 * Runtime override is useful for local gateways with dynamically allocated ports.
 * A `?gateway=` naming any other origin is ignored, so a crafted link cannot make
 * the app send its token or trust responses from an attacker's server (SEC-15).
 */
export function gatewayUrl(): string {
  const query = new URLSearchParams(window.location.search).get('gateway');
  let url = configuredGateway();
  if (query) {
    try {
      const candidate = new URL(query);
      if (trustedGateway(candidate)) url = candidate;
    } catch { /* malformed override: keep the configured gateway */ }
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Gateway must be an HTTP(S) URL');
  return url.href.replace(/\/$/, '');
}

export function gatewayToken(): string | null {
  // Defense in depth: never release a token for an untrusted gateway origin.
  if (!trustedGateway(new URL(gatewayUrl()))) return null;
  const query = new URLSearchParams(window.location.search).get('token');
  if (query) return query;
  try {
    return localStorage.getItem('neo_desktop_token');
  } catch {
    return null;
  }
}
