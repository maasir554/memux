(() => {
  try {
    if (typeof window.__memuxOverlayCleanup === "function") {
      window.__memuxOverlayCleanup();
    }
  } catch {}

  const existingHost = document.getElementById("memux-overlay-host");
  if (existingHost) {
    existingHost.remove();
  }

  const OVERLAY_CHANNEL = "memux_overlay";

  const postToBackground = async (command, payload = {}) => {
    try {
      const response = await chrome.runtime.sendMessage({
        channel: OVERLAY_CHANNEL,
        command,
        payload
      });
      if (!response?.ok) {
        throw new Error(response?.error || "MEMUX overlay request failed.");
      }
      return response.result || {};
    } catch (error) {
      const message = String(error?.message || error || "");
      if (message.toLowerCase().includes("context invalidated")) {
        throw new Error("Extension was reloaded. Click MEMUX Companion icon once again on this tab.");
      }
      throw error;
    }
  };

  const host = document.createElement("div");
  host.id = "memux-overlay-host";
  host.style.position = "fixed";
  host.style.right = "20px";
  host.style.bottom = "20px";
  host.style.zIndex = "2147483647";
  host.style.pointerEvents = "none";
  document.documentElement.appendChild(host);
  window.__memuxOverlayCleanup = () => {
    try {
      host.remove();
    } catch {}
  };

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host, * { box-sizing: border-box; font-family: "Crave Sans", "Inter", "Segoe UI", sans-serif; }
    .wrap { pointer-events: auto; display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
    .btn {
      border: 1px solid rgba(255,255,255,0.18);
      background: linear-gradient(90deg, #EEDFB5 0%, #DB96D1 36%, #E79BB8 66%, #F2C3A7 100%);
      color: #111;
      font-weight: 700;
      padding: 10px 14px;
      border-radius: 999px;
      font-size: 12px;
      letter-spacing: 0.02em;
      cursor: pointer;
      box-shadow: 0 8px 28px rgba(0,0,0,0.35);
    }
    .panel {
      width: min(360px, calc(100vw - 24px));
      border-radius: 18px;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(25, 28, 35, 0.96);
      color: #f6f7fa;
      box-shadow: 0 20px 42px rgba(0,0,0,0.45);
      overflow: hidden;
      backdrop-filter: blur(8px);
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.02);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: "Space Mono", ui-monospace, Menlo, Consolas, monospace;
      font-weight: 700;
      letter-spacing: 0.02em;
      font-size: 14px;
      background: linear-gradient(90deg, #EEDFB5 0%, #DB96D1 36%, #E79BB8 66%, #F2C3A7 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .dot {
      width: 10px; height: 10px; border-radius: 2px;
      background: linear-gradient(90deg, #EEDFB5 0%, #DB96D1 36%, #E79BB8 66%, #F2C3A7 100%);
    }
    .close {
      border: 0;
      border-radius: 8px;
      background: rgba(255,255,255,0.08);
      color: #fff;
      width: 26px;
      height: 26px;
      cursor: pointer;
      font-weight: 700;
    }
    .body { padding: 12px 14px 14px; display: grid; gap: 10px; }
    .label { font-size: 11px; color: rgba(255,255,255,0.75); letter-spacing: 0.02em; font-weight: 600; }
    .input, .select {
      width: 100%;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.16);
      background: rgba(13, 16, 22, 0.9);
      color: #fff;
      padding: 9px 10px;
      font-size: 12px;
      outline: none;
    }
    .row { display: grid; gap: 8px; }
    .tog {
      display: flex; align-items: center; gap: 8px;
      font-size: 12px; color: rgba(255,255,255,0.86);
    }
    .tog input { transform: translateY(0.5px); }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .ghost, .solid {
      border-radius: 999px;
      padding: 10px 12px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      border: 1px solid rgba(255,255,255,0.16);
      transition: opacity .12s ease;
    }
    .ghost { background: rgba(255,255,255,0.06); color: #f1f2f7; }
    .solid {
      border: none;
      background: linear-gradient(90deg, #EEDFB5 0%, #DB96D1 36%, #E79BB8 66%, #F2C3A7 100%);
      color: #111;
    }
    .full {
      width: 100%;
    }
    .ghost:disabled, .solid:disabled, .btn:disabled { opacity: .6; cursor: default; }
    .status {
      font-size: 11px;
      line-height: 1.35;
      color: rgba(255,255,255,0.82);
      background: rgba(255,255,255,0.06);
      border-radius: 10px;
      padding: 7px 8px;
      min-height: 30px;
      white-space: pre-wrap;
    }
  `;

  const wrap = document.createElement("div");
  wrap.className = "wrap";
  wrap.innerHTML = `
    <button class="btn" id="memux-open-btn">MEMUX Capture</button>
    <section class="panel" id="memux-panel" style="display:none">
      <header class="head">
        <div class="brand"><span class="dot"></span>MEMUX Overlay</div>
        <button class="close" id="memux-close-btn">x</button>
      </header>
      <div class="body">
        <div class="row">
          <div class="label">Context Space</div>
          <select class="select" id="memux-space-select"></select>
        </div>
        <div class="row">
          <div class="label">Bookmark URL</div>
          <input class="input" id="memux-url-input" />
        </div>
        <label class="tog">
          <input type="checkbox" id="memux-with-shot" />
          Auto-capture full page screenshots (top to bottom)
        </label>
        <div class="actions">
          <button class="ghost" id="memux-snip-btn">Save Screen Snip</button>
          <button class="solid" id="memux-bookmark-btn">Save Bookmark</button>
        </div>
        <button class="ghost full" id="memux-dev-extract-btn">Extract Page (Dev)</button>
        <div class="status" id="memux-status">Ready.</div>
      </div>
    </section>
  `;

  shadow.appendChild(style);
  shadow.appendChild(wrap);

  const openBtn = shadow.getElementById("memux-open-btn");
  const closeBtn = shadow.getElementById("memux-close-btn");
  const panel = shadow.getElementById("memux-panel");
  const statusEl = shadow.getElementById("memux-status");
  const spaceSelect = shadow.getElementById("memux-space-select");
  const urlInput = shadow.getElementById("memux-url-input");
  const withShot = shadow.getElementById("memux-with-shot");
  const snipBtn = shadow.getElementById("memux-snip-btn");
  const bookmarkBtn = shadow.getElementById("memux-bookmark-btn");
  const devExtractBtn = shadow.getElementById("memux-dev-extract-btn");

  if (!urlInput) return;
  urlInput.value = window.location.href;
  withShot.checked = true;

  let spacesLoaded = false;

  const setBusy = (busy) => {
    bookmarkBtn.disabled = busy;
    snipBtn.disabled = busy;
    devExtractBtn.disabled = busy;
    openBtn.disabled = busy;
  };

  const setStatus = (message) => {
    statusEl.textContent = message;
  };

  const populateSpaces = async () => {
    setStatus("Connecting to MEMUX app...");
    const result = await postToBackground("GET_CONTEXT_SPACES", {});
    const spaces = Array.isArray(result?.spaces) ? result.spaces : [];
    const defaultSpaceId = result?.default_space_id || "";
    if (!spaces.length) {
      throw new Error("No context spaces found in MEMUX.");
    }

    spaceSelect.innerHTML = "";
    for (const space of spaces) {
      const opt = document.createElement("option");
      opt.value = String(space.id);
      opt.textContent = String(space.name || "Untitled Space");
      if (defaultSpaceId && defaultSpaceId === space.id) {
        opt.selected = true;
      }
      spaceSelect.appendChild(opt);
    }
    if (!spaceSelect.value && spaces[0]) {
      spaceSelect.value = spaces[0].id;
    }
    spacesLoaded = true;
    setStatus("Connected. Ready to save.");
  };

  const captureVisibleTab = async () => {
    const res = await postToBackground("CAPTURE_VISIBLE_TAB", {});
    const dataUrl = String(res?.dataUrl || "");
    if (!dataUrl.startsWith("data:image/")) {
      throw new Error("Failed to capture current tab screenshot.");
    }
    return dataUrl;
  };

  const captureVisibleTabWithoutOverlay = async () => {
    const previousDisplay = host.style.display;
    host.style.display = "none";
    try {
      // allow one frame and a tiny timeout so overlay disappearance is painted before screenshot
      await new Promise((resolve) => window.requestAnimationFrame(() => setTimeout(resolve, 100)));
      return await captureVisibleTab();
    } finally {
      host.style.display = previousDisplay || "";
    }
  };

  const saveBookmark = async () => {
    const url = String(urlInput.value || "").trim();
    if (!url) {
      setStatus("Enter a valid URL.");
      return;
    }
    setBusy(true);
    try {
      let screenshots = [];
      if (withShot.checked) {
        const maxShots = 40;
        const scrollWaitMs = 420;
        const originalY = window.scrollY;
        const doc = document.documentElement;
        let shotIndex = 0;
        let targetY = 0;
        let previousMaxY = -1;
        let reachedBottomTwice = 0;

        try {
          while (shotIndex < maxShots) {
            const viewportHeight = Math.max(window.innerHeight || 0, 320);
            const maxY = Math.max(0, (doc.scrollHeight || 0) - viewportHeight);
            const stepPx = Math.max(280, Math.floor(viewportHeight * 0.88));

            targetY = Math.min(targetY, maxY);
            setStatus(`Auto-capturing page ${shotIndex + 1}...`);
            window.scrollTo(0, targetY);
            await new Promise((resolve) => window.setTimeout(resolve, scrollWaitMs));

            const dataUrl = await captureVisibleTabWithoutOverlay();

            shotIndex += 1;
            screenshots.push({
              dataUrl,
              name: `bookmark-auto-shot-${String(shotIndex).padStart(2, "0")}-${Date.now()}.png`,
              mimeType: "image/png"
            });

            if (targetY >= maxY - 2) {
              if (previousMaxY === maxY) {
                reachedBottomTwice += 1;
              } else {
                reachedBottomTwice = 0;
              }
              if (reachedBottomTwice >= 1) {
                break;
              }
            }

            previousMaxY = maxY;
            if (targetY >= maxY) {
              break;
            }
            targetY = targetY + stepPx;
          }
        } finally {
          host.style.display = "";
          window.scrollTo(0, originalY);
        }
      }
      setStatus(`Saving bookmark in MEMUX (${screenshots.length} screenshot${screenshots.length === 1 ? "" : "s"})...`);
      const res = await postToBackground("SAVE_BOOKMARK", {
        url,
        spaceId: String(spaceSelect.value || ""),
        screenshots
      });
      setStatus(`Bookmark queued in MEMUX.\nSource: ${res?.sourceId || "created"}`);
    } catch (error) {
      setStatus(`Bookmark failed: ${error?.message || error}`);
    } finally {
      setBusy(false);
    }
  };

  const saveSnip = async () => {
    setBusy(true);
    try {
      setStatus("Capturing visible tab...");
      const dataUrl = await captureVisibleTabWithoutOverlay();
      setStatus("Sending snip to MEMUX...");
      const res = await postToBackground("SAVE_SNIP", {
        spaceId: String(spaceSelect.value || ""),
        title: `${document.title || "Screen Snip"} (Overlay)`,
        imageDataUrl: dataUrl,
        originUrl: window.location.href
      });
      setStatus(`Snip queued in MEMUX.\nSource: ${res?.sourceId || "created"}`);
    } catch (error) {
      setStatus(`Snip failed: ${error?.message || error}`);
    } finally {
      setBusy(false);
    }
  };

  const runDevExtraction = async () => {
    setBusy(true);
    try {
      const hostname = String(window.location.hostname || "").toLowerCase();
      const isWhatsApp = hostname === "web.whatsapp.com" || hostname.endsWith(".whatsapp.com");
      const defaultExtractor = window.__MEMUX_EXTRACT_PAGE_STRUCTURE__;
      const whatsappExtractor = window.__MEMUX_EXTRACT_WHATSAPP_CHAT__;
      const extractor =
        isWhatsApp && typeof whatsappExtractor === "function"
          ? whatsappExtractor
          : defaultExtractor;

      if (typeof extractor !== "function") {
        throw new Error("Page extractor is not loaded on this tab.");
      }

      setStatus(
        isWhatsApp
          ? "Extracting WhatsApp chat messages..."
          : "Extracting structured page content..."
      );

      const extraction = extractor({});
      const nodes = Number(extraction?.node_count || extraction?.message_count || 0);
      const links = Array.isArray(extraction?.hyperlinks) ? extraction.hyperlinks.length : 0;
      const modeLabel = isWhatsApp ? "WhatsApp chat" : "page structure";
      console.info("MEMUX Dev Page Extraction", extraction);

      setStatus(`Extracted ${nodes} ${modeLabel} nodes and ${links} links.\nSaving to MEMUX Dev logs...`);
      const res = await postToBackground("SAVE_DEV_EXTRACT", {
        url: window.location.href,
        title: document.title || "",
        extraction
      });
      setStatus(`Dev extraction saved.\nRecord: ${res?.id || "created"}`);
    } catch (error) {
      setStatus(`Dev extraction failed: ${error?.message || error}`);
    } finally {
      setBusy(false);
    }
  };

  const openPanel = async () => {
    panel.style.display = "block";
    if (!spacesLoaded) {
      try {
        await populateSpaces();
      } catch (error) {
        setStatus(`MEMUX not reachable: ${error?.message || error}`);
      }
    }
  };

  openBtn.addEventListener("click", openPanel);
  closeBtn.addEventListener("click", () => {
    panel.style.display = "none";
  });
  bookmarkBtn.addEventListener("click", saveBookmark);
  snipBtn.addEventListener("click", saveSnip);
  devExtractBtn.addEventListener("click", runDevExtraction);
})();
