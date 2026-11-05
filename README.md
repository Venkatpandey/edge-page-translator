# Page to English — Edge Extension

> 🎨 **Vibe coded** with AI — tested and working.

Translate any website to English with one click. Uses your own Google Cloud Translation API key. Translations are cached locally so repeat visits, scrolling, and navigating within a site cost zero API calls.

## Features

- **One-click translation** — click the extension icon, paste your API key, hit Translate
- **Auto-translate** — once enabled on a site, every new page on that origin translates automatically in the background
- **Smart caching** — translations persist in your Edge profile (up to 50,000 entries / 8 MB). Menus, footers, nav items, and other repeated text are translated once and reused everywhere
- **Text deduplication** — if "Home" appears 30 times on a page, it's sent to the API once
- **SPA support** — detects client-side navigation (React, Vue, etc.) and re-translates new content from cache
- **Mutation observer** — lazy-loaded content (infinite scroll, accordions) is picked up and translated as it appears
- **Safe defaults** — prices, URLs, emails, code blocks, form fields, and SVG content stay untouched

## Setup

### 1. Get a Google Cloud Translation API key

1. Create a [Google Cloud project](https://console.cloud.google.com/) with billing enabled
2. Enable **Cloud Translation API**
3. Create an API key — restrict it to **Cloud Translation API** only
4. Set a budget alert or daily quota to avoid surprise charges

### 2. Install the extension

1. Open `edge://extensions` in Microsoft Edge
2. Turn on **Developer mode** (bottom-left toggle)
3. Click **Load unpacked** and select this folder
4. Pin **Page to English** to the toolbar

### 3. Use it

1. Navigate to any non-English website
2. Click the extension icon
3. Paste your API key (saved once, stored in your Edge profile)
4. Click **Translate this page**

That's it. The site is now auto-translating — navigate to other pages on the same site and they translate automatically. The status toast in the bottom-right tells you how many translations came from cache vs API.

### Controls

| Button | What it does |
|---|---|
| **Translate this page** | Translates current page and enables auto-translate for this site |
| **Show original page** | Restores original text and stops auto-translate for this site |
| **Stop auto-translate for this site** | Removes this site from background auto-translate |
| **Clear translation cache** | Wipes all cached translations |
| **Stop all** | Removes every site from auto-translate |

## How caching works

```
Page text → deduplicate → cache lookup → API (misses only) → cache store → apply to DOM
```

- **Key**: trimmed source text (target is always English)
- **Storage**: `chrome.storage.local` — stays in your Edge profile across sessions
- **Limits**: 50,000 entries / 8 MB, LRU eviction (oldest-used entries dropped first)
- **Cross-page**: cached translations are reused across all sites — "Home" translated on site A is instantly available on site B

### What gets cached well

- Navigation menus, footers, headers, breadcrumbs
- Button labels, form labels, error messages
- Repeated product category names
- Common phrases across pages of the same site

### Cache stats

The popup shows current cache size (e.g. "2,450 translations cached (342.1 KB)"). Use **Clear translation cache** to wipe everything.

## Privacy and security

- Translations are generic `text → English` mappings with no page context attached
- Cached data lives in your Edge profile's extension storage — anyone with access to your profile can read it
- **Do not translate** pages with sensitive content: banking, medical records, private messages, passwords
- The **Clear translation cache** button wipes all stored translations immediately
- Your API key is stored locally and never leaves the browser except in Google API requests
- Restrict your API key to Cloud Translation API only and set a spending limit

## File overview

| File | Role |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `service-worker.js` | Background worker — handles API calls, caching, auto-translate site tracking |
| `translation-cache.js` | LRU cache module — in-memory mirror with `chrome.storage.local` persistence |
| `content-script.js` | Injected into pages — collects text nodes, deduplicates, applies translations |
| `popup.html/js/css` | Extension popup UI — translate/restore buttons, cache stats, site management |

## Limits

- Google Cloud Translation API charges apply — caching significantly reduces costs
- Text inside images, canvas, PDF viewers, cross-origin iframes, and closed Shadow DOM cannot be reached
- Translation quality varies for brand names, product names, and specialist terminology

## Verify

```sh
node --check service-worker.js
node --check content-script.js
node --check popup.js
node --check translation-cache.js
```

Then load the unpacked extension and test on a non-English site. Check that text translates, prices stay unchanged, navigating within the site auto-translates, and **Show original page** restores everything.
