(() => {
  if (window.__MEMUX_WHATSAPP_CHAT_EXTRACTOR_INSTALLED__) return;
  window.__MEMUX_WHATSAPP_CHAT_EXTRACTOR_INSTALLED__ = true;

  const SKIP_TAGS = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "iframe",
    "svg",
    "canvas",
    "audio",
    "video"
  ]);

  const MESSAGE_CONTAINER_SELECTOR =
    "[data-testid^='msg-container'], [data-pre-plain-text], [data-id], [role='row']";

  const QUOTED_TEST_ID_HINTS = ["quoted", "reply", "context"];

  const normalizeText = (input, preserveNewlines = false) => {
    const text = String(input || "");
    if (!text) return "";
    if (preserveNewlines) {
      return text
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
    return text
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const safeHostname = (baseUrl) => {
    try {
      return String(new URL(String(baseUrl || "")).hostname || "").toLowerCase();
    } catch {
      return "";
    }
  };

  const isWhatsAppHost = (hostname) =>
    hostname === "web.whatsapp.com" || hostname.endsWith(".whatsapp.com");

  const isVisibleElement = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.hidden) return false;
    try {
      const style = el.ownerDocument?.defaultView?.getComputedStyle(el);
      if (!style) return true;
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      return true;
    } catch {
      return true;
    }
  };

  const parsePrePlainText = (raw) => {
    const text = normalizeText(raw, false);
    if (!text) return { raw: "" };
    const match = text.match(/^\[(.*?)\]\s*(.*)$/);
    if (!match) return { raw: text };
    const timestamp = normalizeText(match[1], false);
    const rest = normalizeText(match[2], false);
    const senderMatch = rest.match(/^(.*?):\s*$/);
    return {
      raw: text,
      timestamp,
      sender: senderMatch ? normalizeText(senderMatch[1], false) : ""
    };
  };

  const parseSenderFromAriaLabel = (raw) => {
    const text = normalizeText(raw, false);
    if (!text) return "";
    const idx = text.indexOf(":");
    if (idx > 0 && idx < 64) {
      return normalizeText(text.slice(0, idx), false);
    }
    const m = text.match(/(?:from|by)\s+(.+?)(?:,|$)/i);
    if (m && m[1]) {
      return normalizeText(m[1], false);
    }
    return "";
  };

  const getMessageRoot = (doc) => (
    doc.querySelector?.("[data-testid='conversation-panel-messages']") ||
    doc.querySelector?.("#main") ||
    doc.querySelector?.("[role='main']") ||
    doc.body ||
    doc.documentElement
  );

  const getChatTitle = (doc) => {
    const candidates = [
      "[data-testid='conversation-info-header-chat-title']",
      "#main header [title]",
      "#main header span[dir='auto']",
      "#main header h1"
    ];
    for (const selector of candidates) {
      const el = doc.querySelector?.(selector);
      if (!el || !isVisibleElement(el)) continue;
      const title = normalizeText(el.getAttribute("title") || el.textContent || "", false);
      if (title) return title;
    }
    return normalizeText(doc.title || "", false);
  };

  const collectAttrValues = (container, attr) => {
    const values = [];
    const seen = new Set();
    const push = (value) => {
      const normalized = normalizeText(value || "", false);
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      values.push(normalized);
    };

    if (!container || container.nodeType !== Node.ELEMENT_NODE) return values;
    push(container.getAttribute?.(attr));

    const nodes = container.querySelectorAll
      ? container.querySelectorAll(`div[${attr}], span[${attr}]`)
      : [];
    for (const el of nodes) {
      if (!isVisibleElement(el)) continue;
      push(el.getAttribute(attr));
    }
    return values;
  };

  const isQuotedContextElement = (el, container) => {
    if (!el || !container || el === container) return false;
    let node = el;
    while (node && node !== container) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const testId = String(node.getAttribute?.("data-testid") || "").toLowerCase();
        const aria = String(node.getAttribute?.("aria-label") || "").toLowerCase();
        if (QUOTED_TEST_ID_HINTS.some((hint) => testId.includes(hint))) return true;
        if (
          aria.includes("quoted") ||
          aria.includes("reply") ||
          aria.includes("in reply to") ||
          aria.includes("original message")
        ) {
          return true;
        }
      }
      node = node.parentElement;
    }
    return false;
  };

  const collectMessageText = (container, { excludeQuoted = false } = {}) => {
    if (!container) return "";
    const chunks = [];
    const seen = new Set();
    const push = (value) => {
      const normalized = normalizeText(value, false);
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      chunks.push(normalized);
    };

    const selectors = [
      "span.selectable-text",
      "div.selectable-text",
      "[data-lexical-text='true']",
      "span[dir='auto']",
      "div[dir='auto']"
    ];
    for (const selector of selectors) {
      const nodes = container.querySelectorAll ? container.querySelectorAll(selector) : [];
      for (const el of nodes) {
        if (!isVisibleElement(el)) continue;
        if (excludeQuoted && isQuotedContextElement(el, container)) continue;
        push(el.textContent || "");
      }
    }

    if (chunks.length > 0) {
      return normalizeText(chunks.join("\n"), true);
    }

    if (!container.ownerDocument?.createTreeWalker) return "";
    const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    const fallback = [];
    while (current) {
      const parent = current.parentElement;
      if (!parent || !isVisibleElement(parent)) {
        current = walker.nextNode();
        continue;
      }
      if (excludeQuoted && isQuotedContextElement(parent, container)) {
        current = walker.nextNode();
        continue;
      }
      const tag = String(parent.tagName || "").toLowerCase();
      if (!tag || SKIP_TAGS.has(tag)) {
        current = walker.nextNode();
        continue;
      }
      const text = normalizeText(current.textContent || "", false);
      if (!text || text.length < 2) {
        current = walker.nextNode();
        continue;
      }
      if (!seen.has(text.toLowerCase())) {
        seen.add(text.toLowerCase());
        fallback.push(text);
      }
      current = walker.nextNode();
    }
    return normalizeText(fallback.join("\n"), true);
  };

  const extractReplyContext = (container) => {
    if (!container || !container.querySelectorAll) {
      return { reply_to_text: "", reply_to_sender: "" };
    }
    const blocks = [];
    const pushBlock = (el) => {
      if (!el || el === container || !container.contains(el)) return;
      if (!isVisibleElement(el)) return;
      if (blocks.includes(el)) return;
      blocks.push(el);
    };

    const selectors = [
      "[data-testid*='quoted']",
      "[data-testid*='reply']",
      "[aria-label*='quoted' i]",
      "[aria-label*='in reply to' i]",
      "[aria-label*='reply' i]"
    ];
    for (const selector of selectors) {
      const nodes = container.querySelectorAll(selector);
      for (const node of nodes) {
        pushBlock(node);
      }
    }

    let bestText = "";
    let bestSender = "";
    for (const block of blocks) {
      const text = collectMessageText(block, { excludeQuoted: false });
      if (text && text.length > bestText.length) {
        bestText = text;
      }
      const prePlain = normalizeText(block.getAttribute("data-pre-plain-text") || "", false);
      const preMeta = parsePrePlainText(prePlain);
      const senderFromAria = parseSenderFromAriaLabel(block.getAttribute("aria-label") || "");
      const sender = normalizeText(preMeta.sender || senderFromAria || "", false);
      if (sender && !bestSender) {
        bestSender = sender;
      }
    }
    return {
      reply_to_text: normalizeText(bestText, true),
      reply_to_sender: normalizeText(bestSender, false)
    };
  };

  const resolveMessageContainer = (seed, root) => {
    if (!seed || seed.nodeType !== Node.ELEMENT_NODE) return null;
    const candidate = seed.closest?.(MESSAGE_CONTAINER_SELECTOR) || seed;
    if (!candidate || candidate === root || !root.contains(candidate)) return null;
    return candidate;
  };

  const collectMessageContainers = (root) => {
    if (!root || !root.querySelectorAll) return [];
    const out = [];
    const seen = new Set();
    const seedSelectors = [
      "[data-pre-plain-text]",
      "[data-testid^='msg-container']",
      "[data-testid*='quoted']",
      "[data-testid*='reply']",
      "div[aria-label][role='row']",
      "div[aria-label][tabindex='-1']",
      "span.selectable-text",
      "div.selectable-text",
      "[data-lexical-text='true']",
      "span[aria-label]",
      "div[aria-label]"
    ];
    for (const selector of seedSelectors) {
      for (const seed of root.querySelectorAll(selector)) {
        if (!isVisibleElement(seed)) continue;
        const container = resolveMessageContainer(seed, root);
        if (!container || !isVisibleElement(container)) continue;
        if (seen.has(container)) continue;
        seen.add(container);
        out.push(container);
      }
    }
    return out;
  };

  const collectHyperlinks = (root, baseUrl) => {
    const links = [];
    const seen = new Set();
    const anchors = root?.querySelectorAll ? root.querySelectorAll("a[href]") : [];
    for (const a of anchors) {
      if (!isVisibleElement(a)) continue;
      let href = normalizeText(a.getAttribute("href") || "", false);
      if (!href) continue;
      try {
        href = new URL(href, baseUrl).href;
      } catch {}
      const title = normalizeText(a.getAttribute("title") || a.getAttribute("aria-label") || a.textContent || href, false);
      const key = `${title}__${href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        title: title || href,
        href,
        rel: normalizeText(a.getAttribute("rel") || "", false),
        type: normalizeText(a.getAttribute("type") || "", false)
      });
    }
    return links;
  };

  const collectImages = (root, baseUrl) => {
    const images = [];
    const seen = new Set();
    const nodes = root?.querySelectorAll ? root.querySelectorAll("img") : [];
    for (const img of nodes) {
      if (!isVisibleElement(img)) continue;
      let src = normalizeText(img.currentSrc || img.getAttribute("src") || "", false);
      if (!src) continue;
      try {
        src = new URL(src, baseUrl).href;
      } catch {}
      const key = `${src}__${img.width}x${img.height}`;
      if (seen.has(key)) continue;
      seen.add(key);
      images.push({
        src,
        alt: normalizeText(img.getAttribute("alt") || "", false),
        title: normalizeText(img.getAttribute("title") || img.getAttribute("aria-label") || "", false),
        width: Number(img.width || 0),
        height: Number(img.height || 0)
      });
    }
    return images;
  };

  const shorten = (value, maxLen = 140) => {
    const text = normalizeText(value || "", true);
    if (!text) return "";
    if (text.length <= maxLen) return text;
    return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
  };

  const extractFromDocument = (doc = document, options = {}) => {
    const baseUrl =
      String(options.baseUrl || "") ||
      String(doc.location?.href || "") ||
      String(window.location?.href || "");
    const hostname = safeHostname(baseUrl);
    const isWhatsApp = isWhatsAppHost(hostname);
    if (!isWhatsApp && options.force !== true) {
      throw new Error("Dedicated WhatsApp extractor can only run on web.whatsapp.com (use force=true to override).");
    }

    const root = getMessageRoot(doc);
    const containers = collectMessageContainers(root);
    const messages = [];
    const seen = new Set();

    for (let i = 0; i < containers.length; i += 1) {
      const container = containers[i];
      const prePlainValues = collectAttrValues(container, "data-pre-plain-text");
      const ariaLabels = collectAttrValues(container, "aria-label");
      const primaryPre = prePlainValues[0] || "";
      const meta = parsePrePlainText(primaryPre);
      const senderFromLabel = parseSenderFromAriaLabel(ariaLabels[0] || "");
      const senderFromAnyPre = prePlainValues
        .map((raw) => parsePrePlainText(raw).sender || "")
        .find(Boolean) || "";
      const timestampFromAnyPre = prePlainValues
        .map((raw) => parsePrePlainText(raw).timestamp || "")
        .find(Boolean) || "";
      const sender = normalizeText(meta.sender || senderFromAnyPre || senderFromLabel || "", false);
      const timestamp = normalizeText(meta.timestamp || timestampFromAnyPre || "", false);
      const replyContext = extractReplyContext(container);
      const mainText =
        collectMessageText(container, { excludeQuoted: true }) ||
        collectMessageText(container, { excludeQuoted: false });
      const text = mainText || normalizeText(ariaLabels[0] || "", false);
      if (!text) continue;

      const normalizedText = normalizeText(text, true);
      const combinedKey = `${sender}|${timestamp}|${normalizedText.toLowerCase()}|${normalizeText(replyContext.reply_to_text, true).toLowerCase()}`;
      if (seen.has(combinedKey)) continue;
      seen.add(combinedKey);

      const confidence = sender && timestamp && normalizedText
        ? "high"
        : (normalizedText && (sender || ariaLabels.length > 0) ? "medium" : "low");

      messages.push({
        sequence: messages.length + 1,
        sender,
        timestamp,
        text: normalizedText,
        main_text: normalizedText,
        reply_to_text: replyContext.reply_to_text,
        reply_to_sender: replyContext.reply_to_sender,
        confidence,
        data_pre_plain_text: prePlainValues,
        aria_labels: ariaLabels
      });
    }

    const hierarchy = messages.map((msg) => ({
      depth: 0,
      tag: "message",
      text: msg.sender ? `${msg.sender}: ${msg.text}` : msg.text,
      href: "",
      heading_level: null,
      sender: msg.sender,
      timestamp: msg.timestamp,
      confidence: msg.confidence,
      reply_to_text: msg.reply_to_text || "",
      reply_to_sender: msg.reply_to_sender || ""
    }));

    const hierarchy_text = hierarchy
      .map((node) => {
        const replySnippet = shorten(node.reply_to_text, 160);
        const replySender = normalizeText(node.reply_to_sender || "", false);
        const replyPart = replySnippet
          ? ` (reply_to${replySender ? `:${replySender}` : ""}: ${replySnippet})`
          : "";
        return `- [${node.tag}] ${node.text}${replyPart}`;
      })
      .join("\n");
    const plain_text = messages
      .map((msg) => {
        const base = msg.sender ? `${msg.sender}: ${msg.text}` : msg.text;
        const replySnippet = shorten(msg.reply_to_text, 180);
        if (!replySnippet) return base;
        const replySender = normalizeText(msg.reply_to_sender || "", false);
        return `${base}\n-> reply_to${replySender ? `:${replySender}` : ""}: ${replySnippet}`;
      })
      .join("\n");

    const hyperlinks = collectHyperlinks(root, baseUrl);
    const images = collectImages(root, baseUrl);

    return {
      extractor: "whatsapp_chat_v1",
      url: baseUrl,
      hostname,
      title: normalizeText(doc.title || "", false),
      chat_title: getChatTitle(doc),
      extracted_at: new Date().toISOString(),
      root_tag: String(root?.tagName || "").toLowerCase() || "document",
      message_count: messages.length,
      node_count: hierarchy.length,
      messages,
      hierarchy,
      hierarchy_text,
      plain_text,
      hyperlinks,
      images,
      image_count: images.length
    };
  };

  window.MEMUXWhatsAppExtractor = {
    extractFromDocument
  };

  window.__MEMUX_EXTRACT_WHATSAPP_CHAT__ = (options = {}) => extractFromDocument(document, options);

  if (chrome?.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.command !== "EXTRACT_WHATSAPP_CHAT") return;
      try {
        const result = extractFromDocument(document, message.payload || {});
        sendResponse({ ok: true, result });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
      return true;
    });
  }

  console.info("MEMUX WhatsApp chat extractor ready");
})();
