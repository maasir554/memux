const REQUEST_CHANNEL = "MEMUX_EXTENSION_REQUEST";
const RESPONSE_CHANNEL = "MEMUX_EXTENSION_RESPONSE";

const DEFAULT_TIMEOUT_MS = 8000;

export interface ExtensionScrollState {
  url: string;
  title: string;
  scrollY: number;
  viewportHeight: number;
  scrollHeight: number;
  maxScrollY: number;
  canScrollDown: boolean;
}

export interface ExtensionScrollResult {
  tabId: number;
  state: ExtensionScrollState;
}

interface ScrollTargetPayload {
  url?: string;
  tabId?: number;
  openIfMissing?: boolean;
}

interface ScrollToPayload extends ScrollTargetPayload {
  y: number;
}

function requireBrowserWindow(): Window {
  if (typeof window === "undefined") {
    throw new Error("MEMUX extension bridge is available only in browser runtime.");
  }
  return window;
}

function extensionErrorMessage(raw: unknown): string {
  if (typeof raw === "string" && raw.trim()) return raw;
  return "MEMUX extension is not available. Load browser-extension/memux-scroll-control as an unpacked extension and refresh the app tab.";
}

async function sendExtensionRequest<T>(command: string, payload: Record<string, any>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const win = requireBrowserWindow();
  const requestId = `memux-ext-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  return await new Promise<T>((resolve, reject) => {
    const timer = win.setTimeout(() => {
      cleanup();
      reject(new Error(extensionErrorMessage(undefined)));
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      if (event.source !== win) return;
      const data = event.data;
      if (!data || data.channel !== RESPONSE_CHANNEL || data.requestId !== requestId) return;

      cleanup();

      if (data.ok === false) {
        reject(new Error(extensionErrorMessage(data.error)));
        return;
      }

      resolve((data.result || data) as T);
    };

    const cleanup = () => {
      win.clearTimeout(timer);
      win.removeEventListener("message", onMessage as EventListener);
    };

    win.addEventListener("message", onMessage as EventListener);
    win.postMessage({
      channel: REQUEST_CHANNEL,
      requestId,
      command,
      payload
    }, "*");
  });
}

export const memuxExtensionBridge = {
  async ping(): Promise<{ ok: boolean; version?: string }> {
    return await sendExtensionRequest<{ ok: boolean; version?: string }>("PING", {});
  },

  async getScrollState(payload: ScrollTargetPayload): Promise<ExtensionScrollResult> {
    const res = await sendExtensionRequest<ExtensionScrollResult>("SCROLL_GET_STATE", payload || {});
    if (!res?.state || typeof res.tabId !== "number") {
      throw new Error("Invalid scroll-state response from extension.");
    }
    return res;
  },

  async scrollTo(payload: ScrollToPayload): Promise<ExtensionScrollResult> {
    const res = await sendExtensionRequest<ExtensionScrollResult>("SCROLL_TO", payload);
    if (!res?.state || typeof res.tabId !== "number") {
      throw new Error("Invalid scroll response from extension.");
    }
    return res;
  }
};
