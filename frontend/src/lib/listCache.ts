/**
 * PERF_AUDIT.md finding #9: no data-fetch caching layer existed anywhere
 * (every `request()` call set `cache: "no-store"`, every Supabase list call
 * was a bare one-shot query) so findings #1-#6's now-paginated list fetches
 * still paid their full round-trip cost on every navigation, including
 * flipping back to a list a user just left seconds earlier.
 *
 * This is the same module-level-cache-plus-subscriber shape `useMe.ts`
 * already uses for `/api/v1/me` (that hook's own doc comment calls out the
 * redundant-refetch problem it fixed) generalized into a small keyed cache
 * for the paginated list endpoints: a short staleTime (default 20s) means
 * back-and-forth navigation reuses the last page instantly, and
 * `invalidateListCache(prefix)` -- called after every create/edit/delete
 * mutation on a module -- forces the next read for that module to go to
 * the network instead of serving something now stale.
 */

type Entry = { value: unknown; fetchedAt: number; inFlight: Promise<unknown> | null };

const store = new Map<string, Entry>();

const DEFAULT_STALE_MS = 20_000; // 15-30s per PERF_AUDIT.md finding #9

/**
 * Returns the cached value for `key` if it's younger than `staleMs`,
 * otherwise calls `fetcher()`, caches the result, and returns it.
 * Concurrent calls for the same key while a fetch is in flight share the
 * one in-flight request instead of firing duplicate network calls.
 */
export async function cachedList<T>(key: string, fetcher: () => Promise<T>, staleMs = DEFAULT_STALE_MS): Promise<T> {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && now - hit.fetchedAt < staleMs) {
    return hit.value as T;
  }
  if (hit?.inFlight) {
    return hit.inFlight as Promise<T>;
  }
  const promise = fetcher()
    .then((value) => {
      store.set(key, { value, fetchedAt: Date.now(), inFlight: null });
      return value;
    })
    .catch((err) => {
      store.delete(key);
      throw err;
    });
  store.set(key, { value: hit?.value, fetchedAt: hit?.fetchedAt ?? 0, inFlight: promise });
  return promise;
}

/** Drops every cached entry whose key starts with `prefix` (a module name,
 * e.g. "material-consumption") -- call this right after a mutation on that
 * module so the next list read is forced fresh instead of serving a stale
 * cached page. */
export function invalidateListCache(prefix: string) {
  for (const key of store.keys()) {
    if (key.startsWith(`${prefix}:`)) store.delete(key);
  }
}

/** Stable cache key for a list call: module name + sorted params JSON. */
export function listCacheKey(module: string, params: Record<string, unknown>): string {
  const sorted = Object.keys(params)
    .sort()
    .reduce((acc, k) => {
      if (params[k] !== undefined && params[k] !== "") acc[k] = params[k];
      return acc;
    }, {} as Record<string, unknown>);
  return `${module}:${JSON.stringify(sorted)}`;
}
