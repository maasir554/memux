(() => {
  if (window.__MEMUX_PAGE_STRUCTURE_EXTRACTOR_INSTALLED__) return;
  window.__MEMUX_PAGE_STRUCTURE_EXTRACTOR_INSTALLED__ = true;

  let EXTRACT_RUNTIME = {
    dynamicMode: false,
    relaxAriaHidden: false,
    hostname: "",
    isWhatsApp: false
  };

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

  const TEXT_TAGS = new Set([
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "li", "blockquote", "pre", "code",
    "figcaption", "summary", "dt", "dd",
    "th", "td", "caption", "a",
    "input", "textarea", "select"
  ]);
  const IMAGE_TAGS = new Set(["img"]);

  const CONTAINER_TAGS = new Set(["main", "article", "section", "nav", "aside", "header", "footer", "div"]);
  const FALLBACK_TEXT_TAGS = new Set([
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "li", "blockquote", "pre", "code",
    "td", "th", "caption", "a", "button", "label", "span",
    "input", "textarea", "select"
  ]);
  const BLOCK_BREAK_TAGS = new Set([
    "article", "section", "nav", "aside", "header", "footer", "main",
    "div", "p", "li", "blockquote", "pre", "figure", "figcaption",
    "table", "tr", "ul", "ol", "dl", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6"
  ]);

  const DYNAMIC_TEXT_SELECTORS = [
    "span.selectable-text",
    "div.selectable-text",
    "[data-lexical-text='true']",
    "[data-testid='conversation-panel-messages'] span",
    "[data-testid='conversation-panel-messages'] div[aria-label]",
    "[data-testid='conversation-panel-messages'] span[aria-label]",
    "[data-testid='conversation-panel-messages'] div[data-pre-plain-text]",
    "[data-testid='conversation-panel-messages'] span[data-pre-plain-text]",
    "[role='textbox']",
    "[contenteditable='true']"
  ];

  const WHATSAPP_ATTR_SELECTORS = [
    "div[data-pre-plain-text]",
    "span[data-pre-plain-text]",
    "div[aria-label]",
    "span[aria-label]"
  ];

  const parseHostname = (baseUrl) => {
    try {
      return String(new URL(String(baseUrl || "")).hostname || "").toLowerCase();
    } catch {
      return "";
    }
  };

  const isLikelyDynamicChatHost = (hostname) => {
    if (!hostname) return false;
    return hostname === "web.whatsapp.com" || hostname.endsWith(".whatsapp.com");
  };

  const parseWhatsAppPrePlainText = (raw) => {
    const text = normalizeText(raw || "", false);
    if (!text) return { raw: "" };
    const m = text.match(/^\[(.*?)\]\s*(.*)$/);
    if (!m) return { raw: text };
    const bracketMeta = normalizeText(m[1], false);
    const tail = normalizeText(m[2], false);
    if (!tail) {
      return {
        raw: text,
        timestamp: bracketMeta
      };
    }
    const senderMatch = tail.match(/^(.*?):\s*$/);
    const sender = senderMatch ? normalizeText(senderMatch[1], false) : "";
    return {
      raw: text,
      timestamp: bracketMeta,
      sender
    };
  };

  const parseSenderFromAriaLabel = (raw) => {
    const text = normalizeText(raw || "", false);
    if (!text) return "";
    const colonIdx = text.indexOf(":");
    if (colonIdx > 0 && colonIdx < 64) {
      return normalizeText(text.slice(0, colonIdx), false);
    }
    const m = text.match(/^(?:message from|from)\s+(.+?)$/i);
    if (m && m[1]) {
      return normalizeText(m[1], false);
    }
    return "";
  };

  const collectWhatsAppAttributeValues = (container) => {
    const prePlainTexts = [];
    const ariaLabels = [];
    const seenPre = new Set();
    const seenAria = new Set();

    const pushPre = (value) => {
      const normalized = normalizeText(value || "", false);
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (seenPre.has(key)) return;
      seenPre.add(key);
      prePlainTexts.push(normalized);
    };

    const pushAria = (value) => {
      const normalized = normalizeText(value || "", false);
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (seenAria.has(key)) return;
      seenAria.add(key);
      ariaLabels.push(normalized);
    };

    if (!container || container.nodeType !== Node.ELEMENT_NODE) {
      return { prePlainTexts, ariaLabels };
    }

    pushPre(container.getAttribute?.("data-pre-plain-text"));
    pushAria(container.getAttribute?.("aria-label"));

    for (const selector of WHATSAPP_ATTR_SELECTORS) {
      const elements = container.querySelectorAll ? container.querySelectorAll(selector) : [];
      for (const el of elements) {
        if (!isVisibleElement(el)) continue;
        pushPre(el.getAttribute("data-pre-plain-text"));
        pushAria(el.getAttribute("aria-label"));
      }
    }

    return { prePlainTexts, ariaLabels };
  };

  const collectContainerReadableText = (container) => {
    if (!container) return "";
    const chunks = [];
    const seen = new Set();
    const preferredSelectors = [
      "span.selectable-text",
      "div.selectable-text",
      "[data-lexical-text='true']"
    ];

    for (const selector of preferredSelectors) {
      for (const el of container.querySelectorAll(selector)) {
        if (!isVisibleElement(el)) continue;
        const text = getNodeText(el, false);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        chunks.push(text);
      }
    }

    if (chunks.length > 0) {
      return normalizeText(chunks.join("\n"), false);
    }

    if (!container.ownerDocument?.createTreeWalker) {
      return "";
    }

    const fallback = [];
    const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      const parent = current.parentElement;
      if (!parent || !isVisibleElement(parent)) {
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
      const key = text.toLowerCase();
      if (seen.has(key)) {
        current = walker.nextNode();
        continue;
      }
      seen.add(key);
      fallback.push(text);
      current = walker.nextNode();
    }

    return normalizeText(fallback.join("\n"), false);
  };

  const buildWhatsAppMessageHierarchy = (root) => {
    if (!root || !root.querySelectorAll) return [];
    const nodes = [];
    const seen = new Set();
    const containers = root.querySelectorAll(
      "[data-pre-plain-text], div[aria-label], span[aria-label], div[data-pre-plain-text], span[data-pre-plain-text]"
    );

    for (const container of containers) {
      if (isMemuxInjectedElement(container)) continue;
      if (!isVisibleElement(container)) continue;

      const attrValues = collectWhatsAppAttributeValues(container);
      const primaryMetaRaw = container.getAttribute("data-pre-plain-text") || attrValues.prePlainTexts[0] || "";
      const meta = parseWhatsAppPrePlainText(primaryMetaRaw);
      const senderFromLabel = parseSenderFromAriaLabel(attrValues.ariaLabels[0] || "");
      const sender = normalizeText(meta.sender || senderFromLabel || "", false);
      const messageText =
        collectContainerReadableText(container) ||
        normalizeText(attrValues.ariaLabels[0] || "", false);
      if (!messageText || messageText.length < 2) continue;

      const text = sender && !messageText.startsWith(`${sender}:`)
        ? `${sender}: ${messageText}`
        : messageText;
      const depth = getDepthFromRoot(container, root);
      const key = `${meta.raw || "-"}__${text}__${attrValues.ariaLabels[0] || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      nodes.push({
        depth,
        tag: "message",
        text,
        href: "",
        heading_level: null,
        sender,
        timestamp: normalizeText(meta.timestamp || "", false),
        data_pre_plain_text: attrValues.prePlainTexts,
        aria_labels: attrValues.ariaLabels
      });
    }

    return nodes;
  };

  const isMemuxInjectedElement = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const id = String(el.id || "");
    if (id === "memux-overlay-host" || id.startsWith("memux-")) {
      return true;
    }
    const root = typeof el.getRootNode === "function" ? el.getRootNode() : null;
    const host = root && root.host ? root.host : null;
    if (host && String(host.id || "") === "memux-overlay-host") {
      return true;
    }
    return false;
  };

  const normalizeText = (input, preserveWhitespace = false) => {
    const text = String(input || "");
    if (!text) return "";
    if (preserveWhitespace) {
      return text
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\u00a0/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
    return text
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const isVisibleElement = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (isMemuxInjectedElement(el)) return false;
    if (el.hidden) return false;
    if (!EXTRACT_RUNTIME.relaxAriaHidden) {
      if (String(el.getAttribute("aria-hidden") || "").toLowerCase() === "true") return false;
    }

    try {
      const view = el.ownerDocument?.defaultView;
      if (!view) return true;
      const style = view.getComputedStyle(el);
      if (!style) return true;
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      return true;
    } catch {
      return true;
    }
  };

  const getDirectText = (el, preserveWhitespace = false) => {
    if (!el) return "";
    let acc = "";
    for (const node of el.childNodes || []) {
      if (node.nodeType === Node.TEXT_NODE) {
        acc += `${node.textContent || ""} `;
      }
    }
    return normalizeText(acc, preserveWhitespace);
  };

  const getFormControlText = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "textarea") {
      const value = normalizeText(el.value || "", false);
      const placeholder = normalizeText(el.getAttribute("placeholder") || "", false);
      const label = normalizeText(el.getAttribute("aria-label") || el.getAttribute("title") || "", false);
      return value || placeholder || label || "";
    }

    if (tag === "select") {
      const selectedOptions = Array.from(el.selectedOptions || []);
      const selected = selectedOptions
        .map((opt) => normalizeText(opt.textContent || "", false))
        .filter(Boolean)
        .join(" | ");
      const label = normalizeText(el.getAttribute("aria-label") || el.getAttribute("title") || "", false);
      return selected || label || "";
    }

    if (tag === "input") {
      const type = String(el.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden" || type === "password" || type === "file") return "";

      if (type === "checkbox" || type === "radio") {
        const state = el.checked ? "checked" : "unchecked";
        const label = normalizeText(
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.getAttribute("name") ||
          el.value ||
          "",
          false
        );
        return label ? `${label}: ${state}` : `${type}: ${state}`;
      }

      const value = normalizeText(el.value || "", false);
      const placeholder = normalizeText(el.getAttribute("placeholder") || "", false);
      const label = normalizeText(el.getAttribute("aria-label") || el.getAttribute("title") || "", false);
      return value || placeholder || label || "";
    }

    return "";
  };

  const collectReadableFragments = (node, fragments) => {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = normalizeText(node.textContent || "", false);
      if (text) fragments.push(text);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    if (isMemuxInjectedElement(el)) return;
    if (!isVisibleElement(el)) return;
    const tag = String(el.tagName || "").toLowerCase();
    if (!tag || SKIP_TAGS.has(tag)) return;

    if (tag === "br") {
      fragments.push("\n");
      return;
    }

    if (tag === "input" || tag === "textarea" || tag === "select") {
      const controlText = getFormControlText(el);
      if (controlText) {
        fragments.push(controlText);
      }
      fragments.push("\n");
      return;
    }

    const useInnerText = typeof el.innerText === "string" && !BLOCK_BREAK_TAGS.has(tag);
    if (useInnerText) {
      const inner = normalizeText(el.innerText || "", false);
      if (inner) {
        fragments.push(inner);
      }
      return;
    }

    for (const child of el.childNodes || []) {
      collectReadableFragments(child, fragments);
    }

    if (BLOCK_BREAK_TAGS.has(tag)) {
      fragments.push("\n");
    }
  };

  const getNodeText = (el, preserveWhitespace = false) => {
    if (!el) return "";
    if (preserveWhitespace) {
      return normalizeText(el.textContent || "", true);
    }
    const fragments = [];
    for (const child of el.childNodes || []) {
      collectReadableFragments(child, fragments);
    }
    return normalizeText(fragments.join(" "), false);
  };

  const getDepthFromRoot = (el, root) => {
    let depth = 0;
    let node = el;
    while (node && node !== root && node.parentElement) {
      depth += 1;
      node = node.parentElement;
      if (depth > 2000) break;
    }
    return depth;
  };

  const resolveHref = (href, baseUrl) => {
    const raw = String(href || "").trim();
    if (!raw) return "";
    try {
      return new URL(raw, baseUrl).href;
    } catch {
      return raw;
    }
  };

  const resolveImageSrc = (img, baseUrl) => {
    if (!img) return "";
    const candidate = String(img.currentSrc || img.getAttribute("src") || "").trim();
    if (!candidate) return "";
    try {
      return new URL(candidate, baseUrl).href;
    } catch {
      return candidate;
    }
  };

  const collectHyperlinks = (root, baseUrl) => {
    const links = [];
    const seen = new Set();
    const anchors = root.querySelectorAll ? root.querySelectorAll("a[href]") : [];

    for (const anchor of anchors) {
      if (!isVisibleElement(anchor)) continue;
      const href = resolveHref(anchor.getAttribute("href"), baseUrl);
      if (!href) continue;
      const title = normalizeText(
        anchor.getAttribute("title") ||
          anchor.getAttribute("aria-label") ||
          anchor.textContent ||
          href
      );
      const rel = normalizeText(anchor.getAttribute("rel"));
      const type = normalizeText(anchor.getAttribute("type"));
      const key = `${title}__${href}__${rel}__${type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        title: title || href,
        href,
        rel: rel || "",
        type: type || ""
      });
    }

    return links;
  };

  const collectImages = (root, baseUrl) => {
    const images = [];
    const seen = new Set();
    const elements = root.querySelectorAll ? root.querySelectorAll("img") : [];

    for (const img of elements) {
      if (!isVisibleElement(img)) continue;
      const src = resolveImageSrc(img, baseUrl);
      if (!src) continue;

      const alt = normalizeText(img.getAttribute("alt") || "");
      const title = normalizeText(img.getAttribute("title") || img.getAttribute("aria-label") || "");
      const referrerpolicy = normalizeText(img.getAttribute("referrerpolicy") || "");
      const decoding = normalizeText(img.getAttribute("decoding") || "");
      const loading = normalizeText(img.getAttribute("loading") || "");
      const crossorigin = normalizeText(img.getAttribute("crossorigin") || "");
      const sizes = normalizeText(img.getAttribute("sizes") || "");
      const srcset = normalizeText(img.getAttribute("srcset") || "");

      const width = Number(img.width || 0);
      const height = Number(img.height || 0);
      const natural_width = Number(img.naturalWidth || 0);
      const natural_height = Number(img.naturalHeight || 0);

      const key = `${src}__${alt}__${title}__${width}x${height}`;
      if (seen.has(key)) continue;
      seen.add(key);

      images.push({
        src,
        alt: alt || "",
        title: title || "",
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0,
        natural_width: Number.isFinite(natural_width) ? natural_width : 0,
        natural_height: Number.isFinite(natural_height) ? natural_height : 0,
        loading: loading || "",
        decoding: decoding || "",
        crossorigin: crossorigin || "",
        referrerpolicy: referrerpolicy || "",
        sizes: sizes || "",
        srcset: srcset || ""
      });
    }

    return images;
  };

  const buildNodeRecord = (el, depth, baseUrl) => {
    const tag = String(el.tagName || "").toLowerCase();
    if (!tag || SKIP_TAGS.has(tag)) return null;

    const isHeading = /^h[1-6]$/.test(tag);
    const isCodeLike = tag === "pre" || tag === "code";

    if (IMAGE_TAGS.has(tag)) {
      const src = resolveImageSrc(el, baseUrl);
      if (!src) return null;
      const alt = normalizeText(el.getAttribute("alt") || "");
      const title = normalizeText(el.getAttribute("title") || el.getAttribute("aria-label") || "");
      const width = Number(el.width || 0);
      const height = Number(el.height || 0);
      const text = alt || title || "[image]";
      return {
        depth,
        tag,
        text,
        href: "",
        heading_level: null,
        image_src: src,
        image_alt: alt || "",
        image_title: title || "",
        image_width: Number.isFinite(width) ? width : 0,
        image_height: Number.isFinite(height) ? height : 0
      };
    }

    if (tag === "input" || tag === "textarea" || tag === "select") {
      const text = getFormControlText(el);
      if (!text) return null;
      const controlType = tag === "input"
        ? String(el.getAttribute("type") || "text").toLowerCase()
        : tag;
      return {
        depth,
        tag,
        text,
        href: "",
        heading_level: null,
        control_type: controlType
      };
    }

    if (tag === "a") {
      const linkText = getNodeText(el, false);
      const href = resolveHref(el.getAttribute("href"), baseUrl);
      if (!linkText && !href) return null;
      return {
        depth,
        tag,
        text: linkText || href,
        href: href || "",
        heading_level: null
      };
    }

    if (TEXT_TAGS.has(tag)) {
      const text = getNodeText(el, isCodeLike);
      if (!text) return null;
      return {
        depth,
        tag,
        text,
        href: "",
        heading_level: isHeading ? Number(tag.slice(1)) : null
      };
    }

    if (CONTAINER_TAGS.has(tag)) {
      const directHeading = Array.from(el.children || []).find((child) => /^h[1-6]$/i.test(child.tagName || ""));
      const directText = getDirectText(el, false);
      const label = directHeading
        ? getNodeText(directHeading, false)
        : directText;

      if (!label) return null;
      return {
        depth,
        tag,
        text: label,
        href: "",
        heading_level: directHeading ? Number(String(directHeading.tagName || "h0").toLowerCase().slice(1)) : null
      };
    }

    return null;
  };

  const walkHierarchy = (el, depth, baseUrl, out) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    if (isMemuxInjectedElement(el)) return;
    if (!isVisibleElement(el)) return;
    const tag = String(el.tagName || "").toLowerCase();
    if (!tag || SKIP_TAGS.has(tag)) return;

    const record = buildNodeRecord(el, depth, baseUrl);
    const childDepth = record ? depth + 1 : depth;
    if (record) {
      out.push(record);
    }

    for (const child of el.children || []) {
      walkHierarchy(child, childDepth, baseUrl, out);
    }

    if (el.shadowRoot && !isMemuxInjectedElement(el)) {
      for (const child of el.shadowRoot.children || []) {
        walkHierarchy(child, childDepth, baseUrl, out);
      }
    }
  };

  const buildFallbackHierarchy = (root, baseUrl) => {
    if (!root || !root.querySelectorAll) return [];
    const nodes = [];
    const seen = new Set();
    const selector = Array.from(FALLBACK_TEXT_TAGS).join(",");
    const elements = root.querySelectorAll(selector);

    for (const el of elements) {
      if (isMemuxInjectedElement(el)) continue;
      if (!isVisibleElement(el)) continue;
      const tag = String(el.tagName || "").toLowerCase();
      if (!tag || SKIP_TAGS.has(tag)) continue;

      const isCodeLike = tag === "pre" || tag === "code";
      const text = getNodeText(el, isCodeLike);
      if (!text || text.length < 2) continue;

      const href = tag === "a" ? resolveHref(el.getAttribute("href"), baseUrl) : "";
      const depth = getDepthFromRoot(el, root);
      const headingLevel = /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : null;
      const key = `${tag}__${href || "-"}__${text}`;
      if (seen.has(key)) continue;
      seen.add(key);

      nodes.push({
        depth,
        tag,
        text,
        href,
        heading_level: headingLevel
      });
    }

    return nodes;
  };

  const buildDynamicHierarchy = (root, baseUrl) => {
    if (!root || !root.querySelectorAll) return [];
    const nodes = [];
    const seen = new Set();
    const selector = DYNAMIC_TEXT_SELECTORS.join(",");
    const elements = root.querySelectorAll(selector);

    for (const el of elements) {
      if (isMemuxInjectedElement(el)) continue;
      if (!isVisibleElement(el)) continue;
      const tag = String(el.tagName || "").toLowerCase();
      if (!tag || SKIP_TAGS.has(tag)) continue;

      const text = getNodeText(el, false);
      if (!text || text.length < 2) continue;

      const href = tag === "a" ? resolveHref(el.getAttribute("href"), baseUrl) : "";
      const depth = getDepthFromRoot(el, root);
      const headingLevel = /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : null;
      const key = `${tag}__${href || "-"}__${text}`;
      if (seen.has(key)) continue;
      seen.add(key);

      nodes.push({
        depth,
        tag,
        text,
        href,
        heading_level: headingLevel
      });
    }

    return nodes;
  };

  const buildVisibleTextNodeHierarchy = (root) => {
    if (!root || !root.ownerDocument || !root.ownerDocument.createTreeWalker) return [];
    const nodes = [];
    const seen = new Set();
    const walker = root.ownerDocument.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT
    );

    let current = walker.nextNode();
    while (current) {
      const parent = current.parentElement;
      if (!parent || isMemuxInjectedElement(parent) || !isVisibleElement(parent)) {
        current = walker.nextNode();
        continue;
      }

      const parentTag = String(parent.tagName || "").toLowerCase();
      if (!parentTag || SKIP_TAGS.has(parentTag)) {
        current = walker.nextNode();
        continue;
      }

      const text = normalizeText(current.textContent || "", false);
      if (!text || text.length < 2) {
        current = walker.nextNode();
        continue;
      }

      const depth = getDepthFromRoot(parent, root);
      const key = `${parentTag}__${depth}__${text}`;
      if (seen.has(key)) {
        current = walker.nextNode();
        continue;
      }
      seen.add(key);

      nodes.push({
        depth,
        tag: parentTag,
        text,
        href: "",
        heading_level: null
      });

      if (nodes.length >= 5000) {
        break;
      }
      current = walker.nextNode();
    }

    return nodes;
  };

  const buildHierarchyText = (nodes) =>
    nodes
      .map((node) => {
        const indent = "  ".repeat(Math.max(0, Number(node.depth) || 0));
        const head = node.heading_level ? `h${node.heading_level}` : node.tag;
        const link = node.link_ref ? ` (${node.link_ref})` : "";
        const imageRef = node.image_ref ? ` (${node.image_ref})` : "";
        return `${indent}- [${head}] ${node.text}${link}${imageRef}`;
      })
      .join("\n");

  const buildPlainText = (nodes) =>
    nodes
      .map((node) => normalizeText(node.text, false))
      .filter(Boolean)
      .join("\n");

  const normalizeHierarchyDepth = (nodes) => {
    if (!Array.isArray(nodes) || nodes.length === 0) return [];
    let minDepth = Infinity;
    for (const node of nodes) {
      const depth = Number(node?.depth);
      if (!Number.isFinite(depth)) continue;
      if (depth < minDepth) minDepth = depth;
    }
    if (!Number.isFinite(minDepth) || minDepth <= 0) return nodes;
    return nodes.map((node) => ({
      ...node,
      depth: Math.max(0, (Number(node.depth) || 0) - minDepth)
    }));
  };

  const extractForRoot = (root, baseUrl) => {
    const hierarchy = [];
    walkHierarchy(root, 0, baseUrl, hierarchy);
    const hyperlinks = collectHyperlinks(root, baseUrl);
    const images = collectImages(root, baseUrl);

    let finalHierarchy = hierarchy;
    const hierarchyTextCandidate = buildHierarchyText(hierarchy);
    const plainTextCandidate = buildPlainText(hierarchy);
    const tooSparse = hierarchy.length < 8 || plainTextCandidate.length < 220;
    if (tooSparse) {
      const fallback = buildFallbackHierarchy(root, baseUrl);
      if (fallback.length > hierarchy.length) {
        finalHierarchy = fallback;
      }
    }

    if (EXTRACT_RUNTIME.dynamicMode) {
      const dynamicFallback = buildDynamicHierarchy(root, baseUrl);
      const currentTextLen = buildPlainText(finalHierarchy).length;
      const dynamicTextLen = buildPlainText(dynamicFallback).length;
      if (
        dynamicFallback.length > 0 &&
        (finalHierarchy.length < 20 || dynamicTextLen > Math.floor(currentTextLen * 1.25))
      ) {
        finalHierarchy = dynamicFallback;
      }

      const textNodeFallback = buildVisibleTextNodeHierarchy(root);
      const nextTextLen = buildPlainText(finalHierarchy).length;
      const textNodeLen = buildPlainText(textNodeFallback).length;
      if (
        textNodeFallback.length > 0 &&
        (finalHierarchy.length < 30 || textNodeLen > Math.floor(nextTextLen * 1.2))
      ) {
        finalHierarchy = textNodeFallback;
      }

      if (EXTRACT_RUNTIME.isWhatsApp) {
        const whatsappMessages = buildWhatsAppMessageHierarchy(root);
        const currentLen = buildPlainText(finalHierarchy).length;
        const waLen = buildPlainText(whatsappMessages).length;
        if (
          whatsappMessages.length > 0 &&
          (finalHierarchy.length < 50 || waLen > Math.floor(currentLen * 0.9))
        ) {
          finalHierarchy = whatsappMessages;
        }
      }
    }

    finalHierarchy = normalizeHierarchyDepth(finalHierarchy);

    const hyperlinkIndexByHref = new Map();
    for (let i = 0; i < hyperlinks.length; i += 1) {
      const href = String(hyperlinks[i]?.href || "");
      if (!href || hyperlinkIndexByHref.has(href)) continue;
      hyperlinkIndexByHref.set(href, i);
    }

    for (const node of finalHierarchy) {
      if (!node.href) continue;
      const idx = hyperlinkIndexByHref.get(node.href);
      if (Number.isInteger(idx)) {
        node.link_ref = `hyperlinks[${idx}]`;
      }
    }

    const imageIndexBySrc = new Map();
    for (let i = 0; i < images.length; i += 1) {
      const src = String(images[i]?.src || "");
      if (!src || imageIndexBySrc.has(src)) continue;
      imageIndexBySrc.set(src, i);
    }

    for (const node of finalHierarchy) {
      if (!node.image_src) continue;
      const idx = imageIndexBySrc.get(node.image_src);
      if (Number.isInteger(idx)) {
        node.image_ref = `images[${idx}]`;
      }
    }

    return {
      root,
      hierarchy: finalHierarchy,
      hyperlinks,
      images,
      hierarchy_text: buildHierarchyText(finalHierarchy),
      plain_text: buildPlainText(finalHierarchy)
    };
  };

  const pickBestRoot = (doc, options, baseUrl) => {
    if (options.rootElement) return options.rootElement;

    const candidates = [];
    const pushCandidate = (el) => {
      if (!el || candidates.includes(el)) return;
      candidates.push(el);
    };

    pushCandidate(doc.querySelector?.("[data-testid='conversation-panel-messages']"));
    pushCandidate(doc.querySelector?.("#main"));
    pushCandidate(doc.querySelector?.("main"));
    pushCandidate(doc.querySelector?.("article"));
    pushCandidate(doc.querySelector?.("[role='main']"));
    pushCandidate(doc.body);
    pushCandidate(doc.documentElement);

    let best = null;
    let bestScore = -1;
    for (const root of candidates) {
      const extracted = extractForRoot(root, baseUrl);
      const score = (extracted.hierarchy.length * 2) + extracted.plain_text.length;
      if (score > bestScore) {
        bestScore = score;
        best = { root, extracted };
      }
    }

    return best || { root: doc.body || doc.documentElement, extracted: extractForRoot(doc.body || doc.documentElement, baseUrl) };
  };

  const extractFromDocument = (doc = document, options = {}) => {
    const baseUrl =
      String(options.baseUrl || "") ||
      String(doc.location?.href || "") ||
      String(window.location?.href || "");
    const hostname = parseHostname(baseUrl);
    const dynamicHost = isLikelyDynamicChatHost(hostname);
    const dynamicMode =
      typeof options.dynamicSiteMode === "boolean" ? options.dynamicSiteMode : dynamicHost;
    const relaxAriaHidden =
      typeof options.relaxAriaHidden === "boolean"
        ? options.relaxAriaHidden
        : dynamicHost;

    const prevRuntime = EXTRACT_RUNTIME;
    EXTRACT_RUNTIME = {
      dynamicMode,
      relaxAriaHidden,
      hostname,
      isWhatsApp: isLikelyDynamicChatHost(hostname)
    };

    let root = null;
    let extracted = null;
    try {
      const picked = pickBestRoot(doc, options, baseUrl);
      root = picked.root;
      extracted = picked.extracted || extractForRoot(root, baseUrl);
    } finally {
      EXTRACT_RUNTIME = prevRuntime;
    }

    return {
      url: baseUrl,
      hostname,
      dynamic_mode: dynamicMode,
      relaxed_aria_hidden: relaxAriaHidden,
      title: String(doc.title || ""),
      extracted_at: new Date().toISOString(),
      root_tag: String(root?.tagName || "").toLowerCase() || "document",
      node_count: extracted.hierarchy.length,
      hierarchy: extracted.hierarchy,
      hierarchy_text: extracted.hierarchy_text,
      plain_text: extracted.plain_text,
      hyperlinks: extracted.hyperlinks,
      images: extracted.images || [],
      image_count: Array.isArray(extracted.images) ? extracted.images.length : 0
    };
  };

  const extractFromHtml = (html, options = {}) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(html || ""), "text/html");
    return extractFromDocument(doc, {
      ...options,
      baseUrl: options.baseUrl || "about:blank"
    });
  };

  window.MEMUXPageExtractor = {
    extractFromDocument,
    extractFromHtml
  };

  window.__MEMUX_EXTRACT_PAGE_STRUCTURE__ = (options = {}) => extractFromDocument(document, options);
  window.__MEMUX_EXTRACT_PAGE_STRUCTURE_FROM_HTML__ = (html, options = {}) => extractFromHtml(html, options);

  if (chrome?.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.command !== "EXTRACT_PAGE_STRUCTURE") return;
      try {
        const result = extractFromDocument(document, message.payload || {});
        sendResponse({ ok: true, result });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
      return true;
    });
  }

  console.info("MEMUX page structure extractor ready");
})();
