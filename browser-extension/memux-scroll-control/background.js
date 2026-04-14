const APP_BRIDGE_CHANNEL = "memux_app_bridge";
const OVERLAY_CHANNEL = "memux_overlay";

const APP_ORIGIN_PREFIXES = [
  "http://localhost:3000",
  "http://localhost:4173",
  "http://localhost:5173"
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(input) {
  try {
    return new URL(input).toString();
  } catch {
    return null;
  }
}

function buildUrlCandidates(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return [];
  const url = new URL(normalized);
  const withoutHash = `${url.origin}${url.pathname}${url.search}`;
  const rootPath = `${url.origin}${url.pathname}`;
  return Array.from(new Set([normalized, withoutHash, rootPath, `${url.origin}/*`]));
}

function isAppTab(tab) {
  const tabUrl = tab.url || "";
  return APP_ORIGIN_PREFIXES.some((prefix) => tabUrl.startsWith(prefix));
}

async function findMemuxAppTab() {
  const tabs = await chrome.tabs.query({});
  const appTabs = tabs.filter((tab) => isAppTab(tab));
  if (!appTabs.length) return null;
  const activeApp = appTabs.find((tab) => tab.active);
  return activeApp || appTabs[0];
}

async function sendToAppTab(tabId, payload) {
  const trySend = async () => {
    return await chrome.tabs.sendMessage(tabId, payload);
  };
  try {
    return await trySend();
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["app-bridge.js"]
    });
    return await trySend();
  }
}

async function injectPageController(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["page-controller.js"]
  });
}

async function sendToPageController(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await injectPageController(tabId);
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

async function getTargetTab({ url, tabId, openIfMissing = false }) {
  if (typeof tabId === "number") {
    const tab = await chrome.tabs.get(tabId);
    return tab;
  }

  const urlCandidates = typeof url === "string" ? buildUrlCandidates(url) : [];
  if (urlCandidates.length > 0) {
    const allTabs = await chrome.tabs.query({});
    const exact = allTabs.find((tab) => {
      if (!tab.url || isAppTab(tab)) return false;
      return urlCandidates.some((candidate) => tab.url === candidate || tab.url.startsWith(candidate));
    });
    if (exact) return exact;

    if (openIfMissing && urlCandidates[0]) {
      const created = await chrome.tabs.create({ url: urlCandidates[0], active: true });
      if (!created.id) {
        throw new Error("Failed to open target tab");
      }
      await sleep(700);
      return created;
    }

    throw new Error("Target webpage tab not found. Open the bookmarked page and try again.");
  }

  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const active = activeTabs.find((tab) => !isAppTab(tab));
  if (!active) {
    throw new Error("No target tab available for scroll control.");
  }
  return active;
}

async function handleGetState(payload) {
  const tab = await getTargetTab(payload || {});
  if (!tab.id) throw new Error("Target tab ID unavailable");
  const result = await sendToPageController(tab.id, { type: "MEMUX_SCROLL_GET_STATE" });
  if (!result?.ok || !result.state) throw new Error("Failed to read page scroll state.");
  return {
    tabId: tab.id,
    state: result.state
  };
}

async function handleScrollTo(payload) {
  const tab = await getTargetTab(payload || {});
  if (!tab.id) throw new Error("Target tab ID unavailable");

  const y = Number(payload?.y ?? 0);
  if (!Number.isFinite(y)) {
    throw new Error("Invalid y position for scroll command.");
  }

  const result = await sendToPageController(tab.id, {
    type: "MEMUX_SCROLL_TO",
    y
  });
  if (!result?.ok || !result.state) throw new Error("Failed to scroll target page.");

  return {
    tabId: tab.id,
    state: result.state
  };
}

async function handleScrollStep(payload) {
  const tab = await getTargetTab(payload || {});
  if (!tab.id) throw new Error("Target tab ID unavailable");

  const delta = Number(payload?.delta ?? 0);
  if (!Number.isFinite(delta)) {
    throw new Error("Invalid delta for scroll-step command.");
  }

  const result = await sendToPageController(tab.id, {
    type: "MEMUX_SCROLL_STEP",
    delta
  });
  if (!result?.ok || !result.state) throw new Error("Failed to step-scroll target page.");

  return {
    tabId: tab.id,
    state: result.state
  };
}

async function handleOverlayCaptureVisibleTab(sender) {
  const windowId = sender?.tab?.windowId;
  const dataUrl = typeof windowId === "number"
    ? await chrome.tabs.captureVisibleTab(windowId, { format: "png" })
    : await chrome.tabs.captureVisibleTab({ format: "png" });
  return {
    ok: true,
    dataUrl,
  };
}

async function handleOverlayRelayToApp(command, payload) {
  const appTab = await findMemuxAppTab();
  if (!appTab || typeof appTab.id !== "number") {
    throw new Error("MEMUX app tab not found. Open MEMUX first, then retry.");
  }

  const relayId = `overlay-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const response = await sendToAppTab(appTab.id, {
    channel: "memux_overlay_app_relay",
    requestId: relayId,
    command,
    payload: payload || {}
  });

  if (response?.ok === false) {
    throw new Error(response?.error || "MEMUX app command failed.");
  }
  return response?.result || {};
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.channel !== APP_BRIDGE_CHANNEL) {
    return;
  }

  const { command, payload } = message;

  const run = async () => {
    if (command === "PING") {
      return { ok: true, version: "0.1.0" };
    }
    if (command === "SCROLL_GET_STATE") {
      return await handleGetState(payload);
    }
    if (command === "SCROLL_TO") {
      return await handleScrollTo(payload);
    }
    if (command === "SCROLL_STEP") {
      return await handleScrollStep(payload);
    }
    throw new Error(`Unsupported command: ${String(command)}`);
  };

  run()
    .then((result) => sendResponse(result))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || String(error || "Extension command failed")
      });
    });

  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.channel !== OVERLAY_CHANNEL) {
    return;
  }

  const { command, payload } = message;

  const run = async () => {
    if (command === "PING") {
      return { ok: true, version: "0.1.0" };
    }
    if (command === "CAPTURE_VISIBLE_TAB") {
      return await handleOverlayCaptureVisibleTab(sender);
    }
    if (command === "GET_CONTEXT_SPACES") {
      return await handleOverlayRelayToApp("EXT_GET_CONTEXT_SPACES", payload);
    }
    if (command === "SAVE_BOOKMARK") {
      return await handleOverlayRelayToApp("EXT_SAVE_BOOKMARK", payload);
    }
    if (command === "SAVE_SNIP") {
      return await handleOverlayRelayToApp("EXT_SAVE_SNIP", payload);
    }
    if (command === "SAVE_DEV_EXTRACT") {
      return await handleOverlayRelayToApp("EXT_SAVE_DEV_EXTRACT", payload);
    }
    if (command === "AUTOFILL_FORM") {
      return await handleOverlayRelayToApp("EXT_AUTOFILL_FORM", payload);
    }
    throw new Error(`Unsupported overlay command: ${String(command)}`);
  };

  run()
    .then((result) => {
      sendResponse({
        ok: true,
        result
      });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || String(error || "Overlay command failed")
      });
    });

  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["overlay.js"]
    });
  } catch (error) {
    console.error("Failed to inject MEMUX overlay via action click:", error);
  }
});
