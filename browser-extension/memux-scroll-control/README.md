# MEMUX Companion Extension

This extension provides:

1. Scroll control bridge used by MEMUX auto-capture.
2. In-page overlay (on any website) to save bookmarks and screen snips directly into MEMUX.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `browser-extension/memux-scroll-control`.
5. Refresh the MEMUX app tab (`http://localhost:5173` or your local dev URL).

## Use in MEMUX

1. Open bookmark details in Context Explorer.
2. Start **Screen Share** and select the same webpage tab.
3. Click **Auto Capture Page**.
4. MEMUX will scroll the page and capture step-by-step screenshots, then index them in background.

## Use Overlay on Any Page

1. Open any webpage (non-MEMUX tab).
2. Click floating **MEMUX Capture**.
3. If it does not appear automatically, click the extension icon (**MEMUX Companion**) once to force-inject the overlay on the current tab.
4. Choose a Context Space.
5. Use:
   - **Save Bookmark** (auto-captures full page screenshots top-to-bottom and sends with bookmark)
   - **Save Screen Snip** (captures visible tab and indexes in MEMUX)
   - **Extract Page (Dev)** (runs deterministic DOM text extraction and stores output in MEMUX Dev screen)
6. Ensure MEMUX app tab is open (`http://localhost:3000`, `4173`, or `5173`), otherwise overlay cannot sync.

## Client-Side Page Text Extractor (No Agent)

The extension now loads a deterministic page extractor on all pages.

From browser DevTools on any page:

```js
window.__MEMUX_EXTRACT_PAGE_STRUCTURE__()
```

From raw HTML string:

```js
window.__MEMUX_EXTRACT_PAGE_STRUCTURE_FROM_HTML("<html>...</html>", { baseUrl: "https://example.com" })
```

Output contains:

- `hierarchy`: structured nodes with `depth`, `tag`, `text`, `heading_level`, `href`
- `hierarchy_text`: indentation-preserved text hierarchy
- `plain_text`: flattened normalized text
- `hyperlinks`: `[{ title, href, rel, type }]`

### Dedicated WhatsApp Extractor

On `https://web.whatsapp.com/*`, the extension also loads a dedicated chat extractor:

```js
window.__MEMUX_EXTRACT_WHATSAPP_CHAT__()
```

This returns message-centric output:

- `messages`: `[{ sequence, sender, timestamp, text, confidence, data_pre_plain_text[], aria_labels[] }]`
- `message_count`
- `hierarchy` / `hierarchy_text` / `plain_text` (compatible with MEMUX dev viewer)
