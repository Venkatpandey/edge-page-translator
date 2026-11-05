const apiKeyInput = document.querySelector("#api-key");
const status = document.querySelector("#status");

initialize();

async function initialize() {
  const { googleApiKey = "" } = await chrome.storage.local.get("googleApiKey");
  apiKeyInput.value = googleApiKey;
  refreshCacheStats();
  refreshAutoSection();
  refreshSitesList();
}

// ─── API key toggle ──────────────────────────────────────────────────

document.querySelector("#toggle-key").addEventListener("click", () => {
  const reveal = apiKeyInput.type === "password";
  apiKeyInput.type = reveal ? "text" : "password";
  document.querySelector("#toggle-key").textContent = reveal ? "Hide" : "Show";
});

// ─── Translate ───────────────────────────────────────────────────────

document.querySelector("#translate").addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return setStatus("Paste Google Cloud Translation API key.", true);
  await chrome.storage.local.set({ googleApiKey: key });
  const tab = await activeTab();
  const result = await chrome.runtime.sendMessage({ type: "translateActiveTab", tabId: tab.id });
  if (result.ok) {
    setStatus("Translation started. Auto-translates on navigation.");
    refreshAutoSection();
    refreshSitesList();
  } else {
    setStatus(result.error, true);
  }
});

// ─── Restore ─────────────────────────────────────────────────────────

document.querySelector("#restore").addEventListener("click", async () => {
  const tab = await activeTab();
  const result = await chrome.runtime.sendMessage({ type: "restoreActiveTab", tabId: tab.id });
  if (result.ok) {
    setStatus("Original text restored. Auto-translate stopped for this site.");
    refreshAutoSection();
    refreshSitesList();
  } else {
    setStatus(result.error, true);
  }
});

// ─── Auto-translate section ──────────────────────────────────────────

document.querySelector("#stop-auto").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab.url) return;
  try {
    const origin = new URL(tab.url).origin;
    await chrome.runtime.sendMessage({ type: "removeActiveSite", origin });
    // Also restore the page
    await chrome.runtime.sendMessage({ type: "restoreActiveTab", tabId: tab.id });
    setStatus("Auto-translate stopped for this site.");
    refreshAutoSection();
    refreshSitesList();
  } catch {
    setStatus("Could not stop auto-translate.", true);
  }
});

async function refreshAutoSection() {
  const section = document.querySelector("#auto-section");
  const info = document.querySelector("#auto-info");
  const tab = await activeTab();
  if (!tab?.url) {
    section.hidden = true;
    return;
  }

  let origin;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    section.hidden = true;
    return;
  }

  const result = await chrome.runtime.sendMessage({ type: "getActiveSites" });
  if (result?.ok && result.sites.includes(origin)) {
    info.textContent = new URL(tab.url).hostname;
    section.hidden = false;
  } else {
    section.hidden = true;
  }
}

// ─── Cache stats ─────────────────────────────────────────────────────

document.querySelector("#clear-cache").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearTranslationCache" });
  setStatus("Translation cache cleared.");
  refreshCacheStats();
});

async function refreshCacheStats() {
  const el = document.querySelector("#cache-stats");
  const result = await chrome.runtime.sendMessage({ type: "getCacheStats" });
  if (result?.ok) {
    const { entries, bytes } = result.stats;
    if (entries === 0) {
      el.textContent = "Cache is empty.";
    } else {
      el.textContent = `${entries.toLocaleString()} translations cached (${formatBytes(bytes)})`;
    }
  } else {
    el.textContent = "Cache unavailable.";
  }
}

// ─── Active sites list ──────────────────────────────────────────────

document.querySelector("#clear-sites").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "removeAllActiveSites" });
  setStatus("All auto-translate sites removed.");
  refreshAutoSection();
  refreshSitesList();
});

async function refreshSitesList() {
  const section = document.querySelector("#sites-section");
  const list = document.querySelector("#sites-list");
  const result = await chrome.runtime.sendMessage({ type: "getActiveSites" });

  if (!result?.ok || result.sites.length === 0) {
    section.hidden = true;
    return;
  }

  list.innerHTML = "";
  for (const origin of result.sites) {
    const li = document.createElement("li");
    const hostname = (() => { try { return new URL(origin).hostname; } catch { return origin; } })();

    const span = document.createElement("span");
    span.textContent = hostname;
    span.className = "site-name";

    const btn = document.createElement("button");
    btn.textContent = "✕";
    btn.className = "quiet site-remove";
    btn.title = `Stop auto-translating ${hostname}`;
    btn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "removeActiveSite", origin });
      refreshSitesList();
      refreshAutoSection();
    });

    li.append(span, btn);
    list.append(li);
  }

  section.hidden = false;
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.dataset.error = String(isError);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
