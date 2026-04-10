(() => {
  if (window.__memuxPageControllerInstalled) {
    return;
  }
  window.__memuxPageControllerInstalled = true;

  const getState = () => {
    const doc = document.documentElement;
    const body = document.body;
    const viewportHeight = Math.max(window.innerHeight || 0, doc?.clientHeight || 0, 1);
    const scrollHeight = Math.max(
      doc?.scrollHeight || 0,
      body?.scrollHeight || 0,
      doc?.offsetHeight || 0,
      body?.offsetHeight || 0,
      viewportHeight
    );
    const scrollY = Math.max(window.scrollY || window.pageYOffset || 0, 0);
    const maxScrollY = Math.max(0, scrollHeight - viewportHeight);

    return {
      url: window.location.href,
      title: document.title || "",
      scrollY,
      viewportHeight,
      scrollHeight,
      maxScrollY,
      canScrollDown: scrollY < maxScrollY - 2
    };
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;

    if (message.type === "MEMUX_SCROLL_GET_STATE") {
      sendResponse({ ok: true, state: getState() });
      return;
    }

    if (message.type === "MEMUX_SCROLL_TO") {
      const state = getState();
      const requestedY = Number(message.y ?? 0);
      const clampedY = Math.max(0, Math.min(state.maxScrollY, Number.isFinite(requestedY) ? requestedY : 0));
      window.scrollTo({ top: clampedY, left: 0, behavior: "instant" });

      requestAnimationFrame(() => {
        sendResponse({ ok: true, state: getState() });
      });
      return true;
    }

    if (message.type === "MEMUX_SCROLL_STEP") {
      const state = getState();
      const requestedDelta = Number(message.delta ?? state.viewportHeight);
      const delta = Number.isFinite(requestedDelta) ? requestedDelta : state.viewportHeight;
      const targetY = state.scrollY + delta;
      const clampedY = Math.max(0, Math.min(state.maxScrollY, targetY));
      window.scrollTo({ top: clampedY, left: 0, behavior: "instant" });

      requestAnimationFrame(() => {
        sendResponse({ ok: true, state: getState() });
      });
      return true;
    }
  });
})();
