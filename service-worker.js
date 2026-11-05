import { lookupAll, storeAll, clearCache, getStats } from "./translation-cache.js";

const TRANSLATE_URL = "https://translation.googleapis.com/language/translate/v2";
const MAX_CHARS_PER_REQUEST = 4200;
const MAX_ITEMS_PER_REQUEST = 100;
const MAX_PARALLEL_REQUESTS = 4;

const ACTIVE_SITES_KEY = "autoTranslateSites";

// ─── Auto-translate: track enabled origins ───────────────────────────

async function getActiveSites() {
  const data = await chrome.storage.local.get(ACTIVE_SITES_KEY);
  return new Set(data[ACTIVE_SITES_KEY] || []);
}

async function addActiveSite(origin) {
  const sites = await getActiveSites();
  sites.add(origin);
  await chrome.storage.local.set({ [ACTIVE_SITES_KEY]: [...sites] });
}

async function removeActiveSite(origin) {
  const sites = await getActiveSites();
  sites.delete(origin);
  await chrome.storage.local.set({ [ACTIVE_SITES_KEY]: [...sites] });
}

// ─── Auto-translate on navigation ────────────────────────────────────
// When a tab finishes loading and its origin is in the active-sites list,
// inject the content script and trigger translation automatically.

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;

  let origin;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return;
  }

  // Skip non-http(s) pages (chrome://, edge://, about:, etc.)
  if (!origin.startsWith("http")) return;

  const sites = await getActiveSites();
  if (!sites.has(origin)) return;

  // Verify we still have an API key
  const { googleApiKey } = await chrome.storage.local.get("googleApiKey");
  if (!googleApiKey?.trim()) return;

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
    await chrome.tabs.sendMessage(tabId, { type: "translatePage" });
  } catch {
    // Tab may have been closed or is a restricted page – silently skip.
  }
});

// ─── Message handling ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "translateTexts") {
    translateTexts(message.texts).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message.type === "translateActiveTab") {
    handleTranslateActiveTab(message.tabId).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message.type === "restoreActiveTab") {
    handleRestoreActiveTab(message.tabId).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message.type === "clearTranslationCache") {
    clearCache().then(() => sendResponse({ ok: true })).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message.type === "getCacheStats") {
    getStats().then((stats) => sendResponse({ ok: true, stats })).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message.type === "getActiveSites") {
    getActiveSites().then((sites) => sendResponse({ ok: true, sites: [...sites] })).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message.type === "removeActiveSite") {
    removeActiveSite(message.origin).then(() => sendResponse({ ok: true })).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message.type === "removeAllActiveSites") {
    chrome.storage.local.set({ [ACTIVE_SITES_KEY]: [] })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

// ─── Translate active tab (adds origin to auto-translate list) ───────

async function handleTranslateActiveTab(tabId) {
  const { googleApiKey } = await chrome.storage.local.get("googleApiKey");
  if (!googleApiKey?.trim()) {
    return { ok: false, error: "Add Google Cloud Translation API key first." };
  }

  // Get the tab URL and register this origin for auto-translation
  const tab = await chrome.tabs.get(tabId);
  if (tab.url) {
    try {
      const origin = new URL(tab.url).origin;
      if (origin.startsWith("http")) {
        await addActiveSite(origin);
      }
    } catch { /* ignore invalid URLs */ }
  }

  await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
  await chrome.tabs.sendMessage(tabId, { type: "translatePage" });
  return { ok: true };
}

// ─── Restore active tab (removes origin from auto-translate list) ────

async function handleRestoreActiveTab(tabId) {
  // Remove origin from auto-translate list
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) {
      const origin = new URL(tab.url).origin;
      await removeActiveSite(origin);
    }
  } catch { /* ignore */ }

  try {
    await chrome.tabs.sendMessage(tabId, { type: "restoreOriginal" });
    return { ok: true };
  } catch {
    return { ok: false, error: "No translated page in this tab." };
  }
}

// ─── Core translation (with cache) ──────────────────────────────────

async function translateTexts(texts) {
  const { googleApiKey } = await chrome.storage.local.get("googleApiKey");
  if (!googleApiKey?.trim()) {
    return { ok: false, error: "Google Cloud Translation API key missing." };
  }

  if (!Array.isArray(texts) || texts.length === 0) return { ok: true, translations: [] };

  // ── Cache lookup ────────────────────────────────────────────────────
  const { hits, misses } = await lookupAll(texts);

  // All texts already cached — return immediately, zero API calls.
  if (misses.length === 0) {
    const translations = texts.map((_, i) => hits.get(i));
    return { ok: true, translations, cacheHits: texts.length, apiCalls: 0 };
  }

  // ── Translate only the misses ──────────────────────────────────────
  const missTexts = misses.map((i) => texts[i]);
  const groups = splitIntoGroups(missTexts);
  const translatedGroups = await mapWithConcurrency(groups, MAX_PARALLEL_REQUESTS, async (group) => {
    const response = await fetch(`${TRANSLATE_URL}?key=${encodeURIComponent(googleApiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: group, target: "en", format: "text" })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error?.message || `Google Translation failed (${response.status}).`);
    }
    const translated = payload?.data?.translations?.map((item) => item.translatedText);
    if (!translated || translated.length !== group.length) {
      throw new Error("Google Translation returned incomplete result.");
    }
    return translated;
  });

  const missTranslations = translatedGroups.flat();

  // ── Store new translations in cache ────────────────────────────────
  const pairs = missTexts.map((source, i) => ({ source, translated: missTranslations[i] }));
  await storeAll(pairs);

  // ── Merge cached + fresh results in original order ─────────────────
  const translations = new Array(texts.length);
  for (const [index, value] of hits) {
    translations[index] = value;
  }
  for (let i = 0; i < misses.length; i++) {
    translations[misses[i]] = missTranslations[i];
  }

  return {
    ok: true,
    translations,
    cacheHits: hits.size,
    apiCalls: misses.length,
  };
}

function splitIntoGroups(texts) {
  const groups = [];
  let group = [];
  let length = 0;
  for (const text of texts) {
    if (group.length && (length + text.length > MAX_CHARS_PER_REQUEST || group.length >= MAX_ITEMS_PER_REQUEST)) {
      groups.push(group);
      group = [];
      length = 0;
    }
    group.push(text);
    length += text.length;
  }
  if (group.length) groups.push(group);
  return groups;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
