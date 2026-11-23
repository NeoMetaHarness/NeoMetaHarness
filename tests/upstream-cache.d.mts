/**
 * NMH_UPSTREAM_CACHE, checked to hold the `<pin>@<ref>` folder of each named pin (refs from upstream.lock.json).
 * Throws a message naming the variable when it is unset, missing or incomplete.
 */
export function requireUpstreamCache(test: string, pins?: string[]): string;
