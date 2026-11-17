/** Runtime override is useful for local gateways with dynamically allocated ports. */
export function gatewayUrl(): string {
  const query = new URLSearchParams(window.location.search).get('gateway');
  const configured = query ?? import.meta.env.VITE_NEO_GATEWAY_URL ?? 'http://127.0.0.1:4321';
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Gateway must be an HTTP(S) URL');
  return url.href.replace(/\/$/, '');
}
