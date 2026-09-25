import { CACHE_MAX_ENTRIES } from '../shared/constants.mjs';

/**
 * Small LRU of parsed coverage documents.
 * A 7 MB coverage.json becomes one indexed object, typically 15–30 MB of heap
 * while it stays cached. At most CACHE_MAX_ENTRIES runs are retained.
 * The key includes size and mtime, so a run still being written is re-read
 * on the next request. Payloads are not copied a second time.
 */
export function createCache({ maxEntries = CACHE_MAX_ENTRIES } = {}) {
  const entries = new Map();
  const stats = { hits: 0, misses: 0, evictions: 0 };
  return {
    stats,
    get(key, stamp) {
      const found = entries.get(key);
      if (!found) {
        stats.misses += 1;
        return null;
      }
      if (found.size !== stamp.size || found.mtimeMs !== stamp.mtimeMs) {
        entries.delete(key);
        stats.misses += 1;
        return null;
      }
      entries.delete(key);
      entries.set(key, found);
      stats.hits += 1;
      return found.value;
    },
    set(key, stamp, value) {
      if (entries.has(key)) entries.delete(key);
      entries.set(key, { size: stamp.size, mtimeMs: stamp.mtimeMs, value });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
        stats.evictions += 1;
      }
    },
    clear() {
      entries.clear();
    },
  };
}
