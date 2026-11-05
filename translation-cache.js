/**
 * Translation Cache
 *
 * Persists translations in chrome.storage.local keyed by source text.
 * All translations target English, so the key is just the trimmed source string.
 *
 * Storage layout:
 *   "tc:entries"  → { [sourceText]: { t: translatedText, ts: lastUsedTimestamp } }
 *   "tc:meta"     → { size: numberOfEntries, bytes: estimatedBytes }
 *
 * The cache is size-limited (entry count + byte estimate). When the limit is
 * exceeded the least-recently-used entries are evicted. Writes are batched so
 * a single page translation results in one storage write.
 *
 * Sensitive-site guard: the content script never runs on pages the user hasn't
 * explicitly triggered, and translations are generic text→English mappings that
 * carry no page context, so the cache is safe by design. The user can clear it
 * at any time from the popup.
 */

const CACHE_STORAGE_KEY = "tc:entries";
const CACHE_META_KEY = "tc:meta";

// Defaults – can be adjusted.
const MAX_ENTRIES = 50_000;
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB (fits in default 10 MB storage quota)

// In-memory mirror – loaded once, written back in batches.
let _entries = null; // Map<source, { t, ts }>
let _dirty = false;
let _flushTimer = null;
let _loadingPromise = null;

// ─── Bootstrap ───────────────────────────────────────────────────────

async function _ensureLoaded() {
  if (_entries !== null) return;
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = (async () => {
    try {
      const data = await chrome.storage.local.get(CACHE_STORAGE_KEY);
      const raw = data[CACHE_STORAGE_KEY];
      _entries = new Map(raw ? Object.entries(raw) : []);
    } catch {
      _entries = new Map();
    }
  })();
  return _loadingPromise;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Look up cached translations for an array of source texts.
 * Returns { hits: Map<index, translatedText>, misses: number[] }.
 */
export async function lookupAll(texts) {
  await _ensureLoaded();
  const hits = new Map();
  const misses = [];
  const now = Date.now();

  for (let i = 0; i < texts.length; i++) {
    const key = texts[i].trim();
    const entry = _entries.get(key);
    if (entry) {
      hits.set(i, entry.t);
      // Touch timestamp (LRU)
      entry.ts = now;
      _dirty = true;
    } else {
      misses.push(i);
    }
  }

  _scheduleDirtyFlush();
  return { hits, misses };
}

/**
 * Store fresh translations. `pairs` is an array of { source, translated }.
 */
export async function storeAll(pairs) {
  await _ensureLoaded();
  const now = Date.now();

  for (const { source, translated } of pairs) {
    const key = source.trim();
    // Skip storing if the API returned the exact same text (already English)
    // or the text is very short / numeric-only – not worth caching noise.
    if (key === translated.trim()) continue;
    _entries.set(key, { t: translated, ts: now });
  }

  _dirty = true;
  _evictIfNeeded();
  // Flush immediately – service workers can be killed at any time,
  // so we can't rely solely on the deferred timer for new data.
  await _flush();
}

/**
 * Clear the entire cache.
 */
export async function clearCache() {
  _entries = new Map();
  _dirty = false;
  clearTimeout(_flushTimer);
  await chrome.storage.local.remove([CACHE_STORAGE_KEY, CACHE_META_KEY]);
}

/**
 * Return cache statistics.
 */
export async function getStats() {
  await _ensureLoaded();
  let bytes = 0;
  for (const [key, val] of _entries) {
    bytes += key.length + val.t.length;
  }
  return {
    entries: _entries.size,
    maxEntries: MAX_ENTRIES,
    bytes,
    maxBytes: MAX_BYTES,
  };
}

// ─── Internals ───────────────────────────────────────────────────────

function _evictIfNeeded() {
  // Quick byte estimate
  let bytes = 0;
  for (const [key, val] of _entries) {
    bytes += key.length + val.t.length;
  }

  if (_entries.size <= MAX_ENTRIES && bytes <= MAX_BYTES) return;

  // Sort by ts ascending (oldest first) and drop until within limits
  const sorted = [..._entries.entries()].sort((a, b) => a[1].ts - b[1].ts);
  let i = 0;

  while (i < sorted.length && (_entries.size > MAX_ENTRIES || bytes > MAX_BYTES)) {
    const [key, val] = sorted[i++];
    bytes -= key.length + val.t.length;
    _entries.delete(key);
  }
}

function _scheduleDirtyFlush() {
  if (!_dirty || _flushTimer) return;
  // Batch writes: flush after 2 seconds of inactivity
  _flushTimer = setTimeout(() => _flush(), 2000);
}

async function _flush() {
  _flushTimer = null;
  if (!_dirty || !_entries) return;
  _dirty = false;

  const obj = Object.fromEntries(_entries);
  let bytes = 0;
  for (const [key, val] of _entries) {
    bytes += key.length + val.t.length;
  }

  await chrome.storage.local.set({
    [CACHE_STORAGE_KEY]: obj,
    [CACHE_META_KEY]: { size: _entries.size, bytes },
  });
}
