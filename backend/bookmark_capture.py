import base64
import hashlib
import json
import re
from datetime import datetime, timezone
from html import unescape
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional
from urllib.parse import quote, urlparse

import requests

from vision_ocr import extract_text_from_image


USER_AGENT = "MEMUX-Bot/1.0 (+https://memux.local)"
MAX_SCREENSHOTS = 5
MAX_SECTIONS = 300
MAX_PARAGRAPHS = 2400
MAX_CLEAN_TEXT_CHARS = 1_500_000
MAX_LLM_SECTIONS = 140
EMBED_CHUNK_CHAR_TARGET = 900
EMBED_CHUNK_OVERLAP = 120


def _normalize_url(url: str) -> str:
    candidate = (url or "").strip()
    if not candidate:
        raise ValueError("Empty URL")
    if not candidate.startswith(("http://", "https://")):
        candidate = f"https://{candidate}"
    return candidate


def _extract_title(html: str) -> str:
    match = re.search(r"<title[^>]*>(.*?)</title>", html, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        return "Untitled Bookmark"
    title = re.sub(r"\s+", " ", unescape(match.group(1))).strip()
    return title or "Untitled Bookmark"


def _extract_canonical(html: str, fallback_url: str) -> str:
    match = re.search(
        r'<link[^>]+rel=["\']canonical["\'][^>]*href=["\']([^"\']+)["\']',
        html,
        flags=re.IGNORECASE,
    )
    if match:
        return match.group(1).strip()
    return fallback_url


def _strip_html_to_text(html: str) -> str:
    cleaned = re.sub(r"(?is)<(script|style|noscript).*?>.*?</\1>", " ", html)
    cleaned = re.sub(r"(?is)<br\s*/?>", "\n", cleaned)
    cleaned = re.sub(r"(?is)</(p|div|li|section|article|h1|h2|h3|h4|h5|h6)>", "\n", cleaned)
    cleaned = re.sub(r"(?is)<[^>]+>", " ", cleaned)
    cleaned = unescape(cleaned)
    cleaned = re.sub(r"\r", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    return cleaned.strip()


def _text_to_blocks(text: str, min_block_len: int = 80) -> List[str]:
    raw_blocks = [line.strip() for line in text.split("\n")]
    blocks = [b for b in raw_blocks if len(b) >= min_block_len]

    if blocks:
        return blocks[:60]

    if not text:
        return []

    sentences = re.split(r"(?<=[.!?])\s+", text)
    sentences = [s.strip() for s in sentences if len(s.strip()) >= 40]
    return sentences[:60]


def _normalize_for_dedupe(text: str) -> str:
    normalized = (text or "").lower()
    normalized = re.sub(r"\s+", " ", normalized)
    normalized = re.sub(r"[^a-z0-9 ]", "", normalized)
    return normalized.strip()


def _compact_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def _fallback_summary(text: str, max_chars: int = 280) -> str:
    compact = _compact_text(text)
    if not compact:
        return ""
    sentences = re.split(r"(?<=[.!?])\s+", compact)
    picked = " ".join([s for s in sentences if s][:2]).strip()
    if not picked:
        picked = compact
    return picked[:max_chars]


def _split_large_text(text: str, target: int = EMBED_CHUNK_CHAR_TARGET, overlap: int = EMBED_CHUNK_OVERLAP) -> List[str]:
    clean = _compact_text(text)
    if not clean:
        return []
    if len(clean) <= target:
        return [clean]

    out: List[str] = []
    cursor = 0
    n = len(clean)

    while cursor < n:
        end = min(n, cursor + target)
        split_at = end
        if end < n:
            # Prefer semantic boundary before hard limit.
            window = clean[cursor + int(target * 0.55):end]
            last_break = max(window.rfind(". "), window.rfind("! "), window.rfind("? "))
            if last_break != -1:
                split_at = cursor + int(target * 0.55) + last_break + 1
            else:
                soft_break = window.rfind(" ")
                if soft_break > 30:
                    split_at = cursor + int(target * 0.55) + soft_break

        piece = clean[cursor:split_at].strip()
        if piece:
            out.append(piece)

        if split_at >= n:
            break
        cursor = max(0, split_at - overlap)

    return out


class _StructuralHTMLExtractor(HTMLParser):
    HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
    CAPTURE_TAGS = HEADING_TAGS | {"p", "li", "blockquote", "pre", "td", "th"}
    IGNORE_TAGS = {
        "script",
        "style",
        "noscript",
        "svg",
        "canvas",
        "nav",
        "footer",
        "header",
        "aside",
        "form",
        "button",
        "input",
        "textarea",
        "select",
        "option",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack: List[str] = []
        self.capture_stack: List[Dict[str, Any]] = []
        self.blocks: List[Dict[str, Any]] = []
        self._ignore_depth = 0
        self._order = 0

    def handle_starttag(self, tag: str, attrs: List[tuple]):
        tag_l = (tag or "").lower()
        self.stack.append(tag_l)

        if tag_l in self.IGNORE_TAGS:
            self._ignore_depth += 1
            return

        if self._ignore_depth > 0:
            return

        if tag_l == "br" and self.capture_stack:
            self.capture_stack[-1]["parts"].append("\n")
            return

        if tag_l in self.CAPTURE_TAGS:
            dom_path = "/" + "/".join(self.stack)
            self.capture_stack.append({"tag": tag_l, "dom_path": dom_path, "parts": []})

    def handle_data(self, data: str):
        if self._ignore_depth > 0 or not self.capture_stack:
            return
        if data:
            self.capture_stack[-1]["parts"].append(data)

    def handle_endtag(self, tag: str):
        tag_l = (tag or "").lower()

        if self._ignore_depth > 0 and tag_l in self.IGNORE_TAGS:
            self._ignore_depth = max(0, self._ignore_depth - 1)

        if self.capture_stack and self.capture_stack[-1]["tag"] == tag_l:
            captured = self.capture_stack.pop()
            text = _compact_text(" ".join(captured.get("parts", [])))
            if text:
                self._order += 1
                self.blocks.append(
                    {
                        "tag_name": captured.get("tag"),
                        "text": text,
                        "dom_path": captured.get("dom_path"),
                        "order": self._order,
                    }
                )

        if self.stack:
            self.stack.pop()


def _extract_structured_blocks(html: str) -> List[Dict[str, Any]]:
    parser = _StructuralHTMLExtractor()
    try:
        parser.feed(html or "")
        parser.close()
    except Exception:
        pass

    filtered: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for block in parser.blocks:
        text = _compact_text(str(block.get("text", "")))
        if not text:
            continue

        tag_name = str(block.get("tag_name", "p"))
        min_len = 4 if tag_name.startswith("h") else 28
        if len(text) < min_len:
            continue

        dedupe_key = _normalize_for_dedupe(text)
        if len(dedupe_key) < min_len:
            continue
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        filtered.append(
            {
                "tag_name": tag_name,
                "text": text,
                "dom_path": block.get("dom_path"),
                "order": block.get("order", len(filtered) + 1),
            }
        )

    return filtered


def _build_sections_from_blocks(
    blocks: List[Dict[str, Any]],
    channel: str,
    section_start: int = 1,
    paragraph_start: int = 1,
    screenshot_index: Optional[int] = None,
) -> Dict[str, Any]:
    sections: List[Dict[str, Any]] = []
    section_no = section_start
    paragraph_no = paragraph_start
    current: Optional[Dict[str, Any]] = None

    def begin_section(heading: str) -> Dict[str, Any]:
        nonlocal section_no
        sec = {
            "section_id": f"section_{section_no}",
            "heading": _compact_text(heading)[:220] or f"Section {section_no}",
            "order": section_no,
            "summary": "",
            "channel": channel,
            "paragraphs": [],
        }
        section_no += 1
        return sec

    for block in blocks:
        tag_name = str(block.get("tag_name", "p"))
        text = _compact_text(str(block.get("text", "")))
        if not text:
            continue

        if tag_name in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            if current and current["paragraphs"]:
                sections.append(current)
            current = begin_section(text)
            continue

        if current is None:
            current = begin_section("Overview")

        parts = _split_large_text(text)
        for part_idx, part in enumerate(parts, start=1):
            pid = f"para_{paragraph_no}" if len(parts) == 1 else f"para_{paragraph_no}_part_{part_idx}"
            paragraph_no += 1
            current["paragraphs"].append(
                {
                    "paragraph_id": pid,
                    "text": part,
                    "summary": _fallback_summary(part, max_chars=220),
                    "order": len(current["paragraphs"]) + 1,
                    "dom_path": block.get("dom_path"),
                    "tag_name": tag_name,
                    "channel": channel,
                    "screenshot_index": screenshot_index if channel == "ocr" else None,
                }
            )

    if current and current["paragraphs"]:
        sections.append(current)

    return {
        "sections": sections,
        "next_section_no": section_no,
        "next_paragraph_no": paragraph_no,
    }


def _build_ocr_blocks(ocr_text: str, screenshot_index: int) -> List[Dict[str, Any]]:
    cleaned = (ocr_text or "").strip()
    if not cleaned:
        return []

    raw_blocks = [b.strip() for b in re.split(r"\n\s*\n", cleaned) if b and b.strip()]
    blocks: List[Dict[str, Any]] = []
    if not raw_blocks:
        raw_blocks = _split_large_text(cleaned)

    for i, block in enumerate(raw_blocks, start=1):
        compact = _compact_text(block)
        if len(compact) < 20:
            continue
        blocks.append(
            {
                "tag_name": "p",
                "text": compact,
                "dom_path": f"/screenshot[{screenshot_index + 1}]/block[{i}]",
                "order": i,
            }
        )
    return blocks


def _build_sections_from_screenshot_sequence(
    screenshot_results: List[Dict[str, Any]],
    section_start: int,
    paragraph_start: int,
) -> Dict[str, Any]:
    sections: List[Dict[str, Any]] = []
    section_no = int(section_start)
    paragraph_no = int(paragraph_start)

    for item in screenshot_results:
        if not isinstance(item, dict):
            continue

        screenshot_index = int(item.get("screenshot_index", len(sections)))
        screenshot_heading = _compact_text(str(item.get("screenshot_heading", ""))) or f"Screenshot {screenshot_index + 1}"
        screenshot_summary = _compact_text(str(item.get("screenshot_summary", "")))
        continued_from_previous = bool(item.get("continued_from_previous", False))
        inherited_heading = _compact_text(str(item.get("inherited_heading", "")))
        screenshot_prefix = item.get("context_prefix", [])
        if not isinstance(screenshot_prefix, list):
            screenshot_prefix = []
        screenshot_prefix = [str(token).strip() for token in screenshot_prefix if str(token).strip()][:12]

        section = {
            "section_id": f"section_{section_no}",
            "heading": f"Screenshot OCR {screenshot_index + 1}: {screenshot_heading}"[:220],
            "order": section_no,
            "summary": screenshot_summary[:320],
            "channel": "ocr",
            "continued_from_previous": continued_from_previous,
            "inherited_heading": inherited_heading or None,
            "context_prefix": screenshot_prefix,
            "paragraphs": [],
        }
        section_no += 1

        raw_chunks = item.get("chunks", [])
        if not isinstance(raw_chunks, list):
            raw_chunks = []

        for chunk_index, chunk in enumerate(raw_chunks, start=1):
            if not isinstance(chunk, dict):
                continue
            chunk_text = str(chunk.get("text", "")).strip()
            if not chunk_text:
                continue

            chunk_heading = _compact_text(str(chunk.get("heading", ""))) or screenshot_heading
            chunk_summary = _compact_text(str(chunk.get("summary", ""))) or _fallback_summary(chunk_text, max_chars=220)
            chunk_prefix = chunk.get("context_prefix", [])
            if not isinstance(chunk_prefix, list):
                chunk_prefix = screenshot_prefix
            chunk_prefix = [str(token).strip() for token in chunk_prefix if str(token).strip()][:12]
            layout_hint = _compact_text(str(chunk.get("layout_hint", ""))) or "full"
            chunk_continues = bool(chunk.get("continued_from_previous", continued_from_previous))

            parts = _split_large_text(chunk_text)
            for part_idx, part in enumerate(parts, start=1):
                pid = f"para_{paragraph_no}" if len(parts) == 1 else f"para_{paragraph_no}_part_{part_idx}"
                section["paragraphs"].append(
                    {
                        "paragraph_id": pid,
                        "heading": chunk_heading[:180],
                        "text": part,
                        "summary": chunk_summary[:220] if part_idx == 1 else _fallback_summary(part, max_chars=220),
                        "order": len(section["paragraphs"]) + 1,
                        "dom_path": f"/screenshot[{screenshot_index + 1}]/sequence_chunk[{chunk_index}]",
                        "tag_name": "ocr_chunk",
                        "channel": "ocr",
                        "screenshot_index": screenshot_index,
                        "context_prefix": chunk_prefix,
                        "layout_hint": layout_hint,
                        "continued_from_previous": chunk_continues,
                        "inherited_heading": inherited_heading or None,
                    }
                )
                paragraph_no += 1

        if section["paragraphs"]:
            sections.append(section)

    return {
        "sections": sections,
        "next_section_no": section_no,
        "next_paragraph_no": paragraph_no,
    }


def _apply_caps(sections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    capped_sections: List[Dict[str, Any]] = []
    paragraph_count = 0

    for section in sections[:MAX_SECTIONS]:
        paragraphs: List[Dict[str, Any]] = []
        for para in section.get("paragraphs", []):
            if paragraph_count >= MAX_PARAGRAPHS:
                break
            paragraph_count += 1
            paragraphs.append(para)

        if paragraphs:
            copy = dict(section)
            copy["paragraphs"] = paragraphs
            capped_sections.append(copy)

        if paragraph_count >= MAX_PARAGRAPHS:
            break

    return capped_sections


def _fallback_bookmark_summary(title: str, sections: List[Dict[str, Any]]) -> str:
    lead = title.strip() if title else "Bookmark"
    section_summaries = [s.get("summary", "").strip() for s in sections if s.get("summary")]
    paragraph_summaries: List[str] = []
    if not section_summaries:
        for section in sections[:3]:
            for para in section.get("paragraphs", [])[:2]:
                paragraph_summaries.append(_fallback_summary(para.get("text", ""), max_chars=180))
    merged = " ".join((section_summaries[:3] or paragraph_summaries[:4])).strip()
    if not merged:
        merged = "No meaningful textual content was captured from this page."
    return _compact_text(f"{lead}. {merged}")[:420]


def _call_llm_json(system_prompt: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    try:
        from extraction import get_next_client  # lazy import to avoid unnecessary backend boot overhead

        completion = get_next_client().chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[
                {"role": "system", "content": system_prompt + "\n\nReturn valid JSON only."},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=True)},
            ],
            temperature=0,
            response_format={"type": "json_object"},
        )
        content = completion.choices[0].message.content or "{}"
        return json.loads(content)
    except Exception:
        return None


def _enrich_sections_with_llm(title: str, canonical_url: str, clean_text: str, sections: List[Dict[str, Any]]) -> str:
    # Deterministic defaults first.
    for section in sections:
        if not section.get("summary"):
            section["summary"] = _fallback_summary(
                " ".join([p.get("text", "") for p in section.get("paragraphs", [])[:2]]),
                max_chars=300,
            )
        for para in section.get("paragraphs", []):
            if not para.get("summary"):
                para["summary"] = _fallback_summary(para.get("text", ""), max_chars=220)

    # Stage C: section + paragraph summarization in batches.
    section_prompt = """
You summarize structured webpage content into retrieval-friendly chunks.
Input contains sections and paragraphs from one bookmark capture.

Output JSON schema:
{
  "sections": [
    {
      "section_id": "section_1",
      "summary": "Section-level concise summary",
      "paragraphs": [
        {"paragraph_id": "para_1", "summary": "Concise paragraph summary"}
      ]
    }
  ]
}

Rules:
1. Keep summaries factual and grounded in provided text only.
2. Section summaries: 1-2 sentences, max 320 chars.
3. Paragraph summaries: 1 sentence, max 220 chars.
4. Keep IDs unchanged and return every provided section.
"""

    by_section_id = {s.get("section_id"): s for s in sections}
    llm_sections = sections[:MAX_LLM_SECTIONS]
    batch_size = 8

    for start in range(0, len(llm_sections), batch_size):
        batch = llm_sections[start:start + batch_size]
        batch_payload = {
            "title": title,
            "canonical_url": canonical_url,
            "sections": [
                {
                    "section_id": sec.get("section_id"),
                    "heading": sec.get("heading"),
                    "channel": sec.get("channel"),
                    "paragraphs": [
                        {
                            "paragraph_id": p.get("paragraph_id"),
                            "text": str(p.get("text", ""))[:1200],
                            "channel": p.get("channel"),
                        }
                        for p in sec.get("paragraphs", [])
                    ],
                }
                for sec in batch
            ],
        }

        result = _call_llm_json(section_prompt, batch_payload)
        if not isinstance(result, dict):
            continue
        result_sections = result.get("sections", [])
        if not isinstance(result_sections, list):
            continue

        for sec_out in result_sections:
            if not isinstance(sec_out, dict):
                continue
            sid = str(sec_out.get("section_id", "")).strip()
            if not sid or sid not in by_section_id:
                continue
            target_sec = by_section_id[sid]

            section_summary = _compact_text(str(sec_out.get("summary", "")))
            if section_summary:
                target_sec["summary"] = section_summary[:320]

            para_outputs = sec_out.get("paragraphs", [])
            if not isinstance(para_outputs, list):
                continue
            para_by_id = {p.get("paragraph_id"): p for p in target_sec.get("paragraphs", [])}
            for p_out in para_outputs:
                if not isinstance(p_out, dict):
                    continue
                pid = str(p_out.get("paragraph_id", "")).strip()
                if not pid or pid not in para_by_id:
                    continue
                p_summary = _compact_text(str(p_out.get("summary", "")))
                if p_summary:
                    para_by_id[pid]["summary"] = p_summary[:220]

    # Stage C: bookmark summary.
    page_summary_prompt = """
You generate one concise summary for a captured webpage.
Use title + section summaries + text preview.

Output JSON schema:
{
  "bookmark_summary": "2-4 sentence page summary for retrieval"
}

Rules:
1. Mention the main topic and key entities.
2. Keep under 420 chars.
3. Stay factual and grounded in provided data only.
"""

    payload = {
        "title": title,
        "canonical_url": canonical_url,
        "section_summaries": [
            {
                "section_id": s.get("section_id"),
                "heading": s.get("heading"),
                "summary": s.get("summary"),
                "channel": s.get("channel"),
            }
            for s in sections[:40]
        ],
        "clean_text_preview": clean_text[:14000],
    }

    result = _call_llm_json(page_summary_prompt, payload)
    if isinstance(result, dict):
        summary = _compact_text(str(result.get("bookmark_summary", "")))
        if summary:
            return summary[:420]

    return _fallback_bookmark_summary(title, sections)


def _fetch_screenshots_playwright(url: str, max_images: int = MAX_SCREENSHOTS) -> List[Dict[str, str | bytes]]:
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        return []

    screenshots: List[Dict[str, str | bytes]] = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=["--disable-dev-shm-usage", "--no-sandbox"],
            )
            context = browser.new_context(
                viewport={"width": 1366, "height": 900},
                user_agent=USER_AGENT,
            )
            page = context.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1200)

            total_height = page.evaluate(
                "Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, window.innerHeight)"
            )
            viewport = page.viewport_size or {"width": 1366, "height": 900}
            viewport_height = max(1, int(viewport.get("height", 900)))
            max_scroll = max(0, int(total_height) - viewport_height)

            positions = [0]
            if max_scroll > 0:
                for ratio in (0.25, 0.5, 0.75, 1.0):
                    positions.append(int(max_scroll * ratio))

            seen = set()
            dedup_positions: List[int] = []
            for pos in positions:
                if pos in seen:
                    continue
                seen.add(pos)
                dedup_positions.append(pos)

            for pos in dedup_positions[:max_images]:
                page.evaluate("window.scrollTo(0, arguments[0]);", pos)
                page.wait_for_timeout(300)
                image = page.screenshot(full_page=False, type="png")
                if image:
                    screenshots.append({"bytes": image, "mime_type": "image/png"})

            if not screenshots:
                image = page.screenshot(full_page=True, type="png")
                if image:
                    screenshots.append({"bytes": image, "mime_type": "image/png"})

            context.close()
            browser.close()
    except Exception:
        return []

    return screenshots[:max_images]


def _fetch_screenshots_thumio(url: str, max_images: int = MAX_SCREENSHOTS) -> List[Dict[str, str | bytes]]:
    encoded_url = quote(url, safe="")
    candidates = [
        f"https://image.thum.io/get/noanimate/{encoded_url}",
        f"https://image.thum.io/get/width/1200/noanimate/{encoded_url}",
        f"https://image.thum.io/get/width/900/noanimate/{encoded_url}",
    ]

    screenshots: List[Dict[str, str | bytes]] = []
    for shot_url in candidates:
        try:
            resp = requests.get(
                shot_url,
                headers={"User-Agent": USER_AGENT},
                timeout=20,
            )
            mime_type = (resp.headers.get("Content-Type") or "image/png").split(";")[0].strip()
            if resp.ok and resp.content and mime_type.startswith("image/"):
                screenshots.append({
                    "bytes": resp.content,
                    "mime_type": mime_type,
                })
        except Exception:
            continue
        if len(screenshots) >= max_images:
            break
    return screenshots[:max_images]


def _fetch_screenshot_candidates(url: str) -> List[Dict[str, str | bytes]]:
    playwright_shots = _fetch_screenshots_playwright(url, max_images=MAX_SCREENSHOTS)
    if playwright_shots:
        return playwright_shots
    return _fetch_screenshots_thumio(url, max_images=MAX_SCREENSHOTS)


def _fetch_html_playwright(url: str) -> tuple[str, str]:
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        return url, ""

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=["--disable-dev-shm-usage", "--no-sandbox"],
            )
            context = browser.new_context(
                viewport={"width": 1366, "height": 900},
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            )
            page = context.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1000)
            html = page.content()
            final_url = page.url
            context.close()
            browser.close()
            return final_url, html
    except Exception as e:
        print(f"Skipping playwright HTML fetch due to error: {e}")
        return url, ""


def _capture_raw(url: str, capture_mode: str = "dual") -> Dict[str, Any]:
    normalized = _normalize_url(url)
    
    final_url = normalized
    html = ""
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1"
    }

    try:
        response = requests.get(
            normalized,
            headers=headers,
            timeout=25,
        )
        response.raise_for_status()
        final_url = response.url
        html = response.text or ""
    except requests.exceptions.HTTPError as e:
        if e.response is not None and e.response.status_code in {401, 403, 406, 429}:
            final_url, html = _fetch_html_playwright(normalized)
            if not html:
                # Fallback gracefully rather than crashing
                final_url = e.response.url if e.response else normalized
                html = f"<html><head><title>Content Protected or Unavailable</title></head><body><h1>Content Protected (Status {e.response.status_code})</h1><p>The target server blocked direct HTML extraction. Relying on OCR and screenshots where available.</p></body></html>"
        else:
            raise

    title = _extract_title(html)
    canonical_url = _extract_canonical(html, final_url)

    screenshots: List[Dict[str, Any]] = []
    if capture_mode == "dual":
        for shot in _fetch_screenshot_candidates(final_url):
            raw = shot.get("bytes", b"")
            mime_type = str(shot.get("mime_type", "image/png"))
            if not isinstance(raw, (bytes, bytearray)) or not raw:
                continue
            screenshots.append({
                "bytes": bytes(raw),
                "mime_type": mime_type,
            })

    return {
        "normalized": normalized,
        "final_url": final_url,
        "html": html,
        "title": title,
        "canonical_url": canonical_url,
        "screenshots": screenshots,
    }


def capture_bookmark(url: str, capture_mode: str = "dual") -> Dict[str, Any]:
    raw = _capture_raw(url, capture_mode)
    text = _strip_html_to_text(raw["html"])
    text_blocks = _text_to_blocks(text)
    
    html = raw["html"]
    structured_blocks = _extract_structured_blocks(html)

    screenshots_base64: List[str] = []
    screenshots: List[Dict[str, str]] = []
    for shot in raw["screenshots"]:
        encoded = base64.b64encode(shot["bytes"]).decode("utf-8")
        screenshots_base64.append(encoded)
        screenshots.append({"image_base64": encoded, "mime_type": shot.get("mime_type", "image/png")})

    signature = hashlib.sha256(
        f"{raw['canonical_url']}|{raw['title']}|{len(text)}|{len(screenshots_base64)}".encode("utf-8")
    ).hexdigest()

    return {
        "title": raw["title"],
        "original_url": raw["normalized"],
        "canonical_url": raw["canonical_url"],
        "text_blocks": text_blocks,
        "screenshots": screenshots,
        "screenshots_base64": screenshots_base64,
        "html": html,
        "structured_blocks": structured_blocks,
        "metadata": {
            "capture_mode": capture_mode,
            "final_url": raw["final_url"],
            "domain": urlparse(raw["final_url"]).netloc,
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "text_block_count": len(text_blocks),
            "screenshot_count": len(screenshots_base64),
            "signature": signature,
        },
    }


def process_bookmark_structured(url: str, capture_mode: str = "dual") -> Dict[str, Any]:
    raw = _capture_raw(url, capture_mode)
    html = raw["html"]
    structured_blocks = _extract_structured_blocks(html)
    build = _build_sections_from_blocks(structured_blocks, channel="html", section_start=1, paragraph_start=1)

    sections = build["sections"]
    next_section_no = int(build["next_section_no"])
    next_paragraph_no = int(build["next_paragraph_no"])

    screenshots_encoded: List[Dict[str, str]] = []
    screenshot_ocr_success = 0
    screenshot_ocr_chars = 0
    screenshot_inputs: List[Dict[str, Any]] = []

    for idx, shot in enumerate(raw["screenshots"][:MAX_SCREENSHOTS]):
        encoded = base64.b64encode(shot["bytes"]).decode("utf-8")
        mime_type = str(shot.get("mime_type", "image/png"))
        screenshots_encoded.append({"image_base64": encoded, "mime_type": mime_type})

        ocr_result = extract_text_from_image(encoded)
        ocr_text = (ocr_result.get("text") or "").strip()
        if not ocr_text:
            continue

        screenshot_ocr_success += 1
        screenshot_ocr_chars += len(ocr_text)
        screenshot_inputs.append({
            "screenshot_index": idx,
            "ocr_text": ocr_text
        })

    if screenshot_inputs:
        initial_context = {}
        if sections:
            last_html_section = sections[-1]
            last_html_paragraphs = last_html_section.get("paragraphs", [])[-2:]
            initial_context = {
                "previous_screenshot_heading": last_html_section.get("heading", ""),
                "previous_screenshot_summary": last_html_section.get("summary", ""),
                "previous_tail_chunks": [
                    {
                        "heading": last_html_section.get("heading", ""),
                        "summary": para.get("summary", ""),
                        "text": para.get("text", ""),
                        "layout_hint": "bottom"
                    }
                    for para in last_html_paragraphs
                ],
                "previous_context_prefix": [raw["title"], last_html_section.get("heading", "")]
            }

        try:
            from extraction import process_bookmark_screenshot_sequence  # lazy import to avoid circular import

            sequence_result = process_bookmark_screenshot_sequence(
                screenshots=screenshot_inputs,
                source_title=raw["title"],
                bookmark_summary_context=_fallback_bookmark_summary(raw["title"], sections),
                initial_context=initial_context
            )
            ocr_build = _build_sections_from_screenshot_sequence(
                screenshot_results=sequence_result.get("screenshots", []),
                section_start=next_section_no,
                paragraph_start=next_paragraph_no,
            )
            sections.extend(ocr_build["sections"])
            next_section_no = int(ocr_build["next_section_no"])
            next_paragraph_no = int(ocr_build["next_paragraph_no"])
        except Exception:
            for item in screenshot_inputs:
                idx = int(item.get("screenshot_index", 0))
                ocr_blocks = _build_ocr_blocks(str(item.get("ocr_text", "")), idx)
                if not ocr_blocks:
                    continue

                ocr_build = _build_sections_from_blocks(
                    ocr_blocks,
                    channel="ocr",
                    section_start=next_section_no,
                    paragraph_start=next_paragraph_no,
                    screenshot_index=idx,
                )
                for sec in ocr_build["sections"]:
                    sec["heading"] = f"Screenshot OCR {idx + 1}: {sec['heading']}"
                sections.extend(ocr_build["sections"])
                next_section_no = int(ocr_build["next_section_no"])
                next_paragraph_no = int(ocr_build["next_paragraph_no"])

    sections = _apply_caps(sections)

    clean_text = "\n\n".join(
        [
            f"{section.get('heading', '')}\n" + "\n".join([p.get("text", "") for p in section.get("paragraphs", [])])
            for section in sections
        ]
    )
    clean_text = clean_text[:MAX_CLEAN_TEXT_CHARS]

    bookmark_summary = _enrich_sections_with_llm(raw["title"], raw["canonical_url"], clean_text, sections)
    if not bookmark_summary:
        bookmark_summary = _fallback_bookmark_summary(raw["title"], sections)

    paragraph_count = sum(len(section.get("paragraphs", [])) for section in sections)
    content_hash = hashlib.sha256(
        f"{raw['canonical_url']}|{len(html)}|{clean_text[:400000]}".encode("utf-8")
    ).hexdigest()

    return {
        "title": raw["title"],
        "original_url": raw["normalized"],
        "canonical_url": raw["canonical_url"],
        "bookmark_summary": bookmark_summary,
        "sections": sections,
        "screenshots": screenshots_encoded,
        "metadata": {
            "content_hash": content_hash,
            "html_size": len((html or "").encode("utf-8")),
            "clean_text_chars": len(clean_text),
            "section_count": len(sections),
            "paragraph_count": paragraph_count,
            "capture_stats": {
                "capture_mode": capture_mode,
                "final_url": raw["final_url"],
                "domain": urlparse(raw["final_url"]).netloc,
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "html_block_count": len(structured_blocks),
                "screenshot_count": len(screenshots_encoded),
                "ocr_screenshot_success_count": screenshot_ocr_success,
                "ocr_chars": screenshot_ocr_chars,
                "llm_section_batches": (min(len(sections), MAX_LLM_SECTIONS) + 7) // 8,
            },
        },
    }
