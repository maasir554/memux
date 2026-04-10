(() => {
  const REQUEST_CHANNEL = "MEMUX_EXTENSION_REQUEST";
  const RESPONSE_CHANNEL = "MEMUX_EXTENSION_RESPONSE";
  const APP_COMMAND_CHANNEL = "MEMUX_APP_COMMAND";
  const APP_COMMAND_RESULT_CHANNEL = "MEMUX_APP_COMMAND_RESULT";

  if (window.__memuxBridgeInstalled) {
    return;
  }
  window.__memuxBridgeInstalled = true;

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const payload = event.data;
    if (!payload || payload.channel !== REQUEST_CHANNEL || !payload.requestId) return;

    try {
      const result = await chrome.runtime.sendMessage({
        channel: "memux_app_bridge",
        requestId: payload.requestId,
        command: payload.command,
        payload: payload.payload || {}
      });

      window.postMessage({
        channel: RESPONSE_CHANNEL,
        requestId: payload.requestId,
        ok: true,
        result: result || {}
      }, "*");
    } catch (error) {
      const message = error && error.message ? error.message : String(error || "Unknown extension error");
      window.postMessage({
        channel: RESPONSE_CHANNEL,
        requestId: payload.requestId,
        ok: false,
        error: message
      }, "*");
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.channel !== "memux_overlay_app_relay") {
      return;
    }

    const requestId = String(
      message.requestId || `memux-app-relay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );

    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onResult);
      sendResponse({
        ok: false,
        error: "Timed out waiting for MEMUX app response."
      });
    }, 20000);

    const onResult = (event) => {
      if (event.source !== window) return;
      const payload = event.data;
      if (!payload || payload.channel !== APP_COMMAND_RESULT_CHANNEL || payload.requestId !== requestId) {
        return;
      }
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onResult);
      sendResponse({
        ok: payload.ok !== false,
        result: payload.result || {},
        error: payload.error || null
      });
    };

    window.addEventListener("message", onResult);
    window.postMessage({
      channel: APP_COMMAND_CHANNEL,
      requestId,
      command: message.command,
      payload: message.payload || {}
    }, "*");

    return true;
  });

  console.info("MEMUX content script loaded");
})();
