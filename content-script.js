(() => {
  // If already injected on this page, the listener is registered — nothing to redo.
  if (window.__pageToEnglish) return;

  const originalText = new Map();
  const ignoredTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "CODE", "PRE", "KBD", "SAMP", "SVG"]);
  let observer;
  let translating = false;
  let pending = false;
  let stopped = false;

  window.__pageToEnglish = true;

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "translatePage") startTranslation();
    if (message.type === "restoreOriginal") restoreOriginal();
  });

  // ── SPA navigation detection ───────────────────────────────────────
  // Detect client-side route changes so translated sites stay translated
  // when the user navigates within a single-page app.
  let lastUrl = location.href;

  function onUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (stopped) return;
    // SPA navigated — old node refs are stale, re-translate fresh content.
    originalText.clear();
    window.clearTimeout(window.__pageToEnglishTimer);
    window.__pageToEnglishTimer = window.setTimeout(translateAvailableText, 600);
  }

  const _origPush = history.pushState;
  const _origReplace = history.replaceState;
  history.pushState = function (...args) { _origPush.apply(this, args); onUrlChange(); };
  history.replaceState = function (...args) { _origReplace.apply(this, args); onUrlChange(); };
  window.addEventListener("popstate", onUrlChange);
  window.addEventListener("hashchange", onUrlChange);

  // ── Core ───────────────────────────────────────────────────────────

  function startTranslation() {
    stopped = false;
    addStyles();
    showStatus("Translating page\u2026");
    observeLateContent();
    translateAvailableText();
  }

  function observeLateContent() {
    observer?.disconnect();
    observer = new MutationObserver((mutations) => {
      if (stopped) return;
      if (translating) {
        pending ||= mutations.some((m) => m.type === "childList" && m.addedNodes.length);
        return;
      }
      if (!mutations.some((m) => m.type === "childList" && m.addedNodes.length)) return;
      window.clearTimeout(window.__pageToEnglishTimer);
      window.__pageToEnglishTimer = window.setTimeout(translateAvailableText, 500);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function translateAvailableText() {
    if (translating || stopped) return;
    const nodes = collectTextNodes();
    if (!nodes.length) {
      if (!originalText.size) showStatus("No translatable text found.", true);
      return;
    }

    translating = true;
    pending = false;

    // ── Deduplicate ──────────────────────────────────────────────────
    // Nav items, footer links, repeated labels etc. often appear dozens
    // of times on one page.  Translate each unique string once, then
    // apply the result to every node that shares it.
    const textToNodes = new Map();
    for (const node of nodes) {
      const key = node.nodeValue.trim();
      const list = textToNodes.get(key);
      if (list) list.push(node);
      else textToNodes.set(key, [node]);
    }

    const uniqueTexts = [...textToNodes.keys()];
    showStatus(
      uniqueTexts.length < nodes.length
        ? `Translating ${nodes.length} blocks (${uniqueTexts.length} unique)\u2026`
        : `Translating ${nodes.length} text blocks\u2026`
    );

    try {
      const response = await chrome.runtime.sendMessage({
        type: "translateTexts",
        texts: uniqueTexts
      });
      if (!response?.ok) throw new Error(response?.error || "Translation failed.");

      // Apply each translation to every node that shares the source text
      for (let i = 0; i < uniqueTexts.length; i++) {
        for (const node of textToNodes.get(uniqueTexts[i])) {
          replaceText(node, response.translations[i]);
        }
      }

      // Cache-aware status
      const cached = response.cacheHits || 0;
      const fetched = response.apiCalls || 0;
      if (cached > 0 && fetched === 0) {
        showStatus(`Translated from cache (${cached} hits) \u2014 no API calls.`, true);
      } else if (cached > 0) {
        showStatus(`Translated. ${cached} cached, ${fetched} from API.`, true);
      } else {
        showStatus("English translation active. New content auto-translates.", true);
      }
    } catch (error) {
      showStatus(error.message || "Translation failed.", true, true);
    } finally {
      translating = false;
      if (pending && !stopped) translateAvailableText();
    }
  }

  function collectTextNodes() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (originalText.has(node) || !isEligible(node)) continue;
      nodes.push(node);
    }
    return nodes;
  }

  function isEligible(node) {
    const text = node.nodeValue.trim();
    const parent = node.parentElement;
    if (!text || text.length < 2 || text.length > 2000 || !parent) return false;
    if (ignoredTags.has(parent.tagName) || parent.closest("[contenteditable='true'], [data-page-to-english-ui]")) return false;
    if (!/[\p{L}]/u.test(text)) return false;
    if (/^(https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i.test(text)) return false;
    if (parent.closest("button, a") && text.length < 2) return false;
    return true;
  }

  function replaceText(node, translated) {
    if (!node.isConnected || originalText.has(node)) return;
    const original = node.nodeValue;
    originalText.set(node, original);
    const leading = original.match(/^\s*/)?.[0] || "";
    const trailing = original.match(/\s*$/)?.[0] || "";
    node.nodeValue = `${leading}${decodeHtml(translated)}${trailing}`;
  }

  function restoreOriginal() {
    stopped = true;
    observer?.disconnect();
    for (const [node, text] of originalText) {
      if (node.isConnected) node.nodeValue = text;
    }
    originalText.clear();
    showStatus("Original page restored.", true);
  }

  function decodeHtml(value) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = value;
    return textarea.value;
  }

  function addStyles() {
    if (document.getElementById("page-to-english-style")) return;
    const style = document.createElement("style");
    style.id = "page-to-english-style";
    style.textContent = `
      #page-to-english-status { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; max-width: 340px; padding: 12px 14px; border: 1px solid #2d3c2b; border-radius: 10px; background: #172018; color: #f6f4ea; box-shadow: 0 12px 36px rgba(0,0,0,.32); font: 13px/1.35 system-ui, sans-serif; }
      #page-to-english-status[data-error='true'] { border-color: #b85c38; }
    `;
    document.documentElement.append(style);
  }

  function showStatus(message, persistent = false, error = false) {
    let status = document.getElementById("page-to-english-status");
    if (!status) {
      status = document.createElement("div");
      status.id = "page-to-english-status";
      status.dataset.pageToEnglishUi = "true";
      document.documentElement.append(status);
    }
    status.textContent = message;
    status.dataset.error = String(error);
    if (!persistent) {
      window.clearTimeout(window.__pageToEnglishStatusTimer);
      window.__pageToEnglishStatusTimer = window.setTimeout(() => status.remove(), 5000);
    }
  }
})();
