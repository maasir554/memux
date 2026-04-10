import os
import json
import re
import math
from difflib import SequenceMatcher
from groq import Groq, APIStatusError
from models import TableExtraction
from typing import List, Tuple, Dict, Any, Optional

# Initialize multiple Groq clients for load distribution
# round-robin load distribution scheme
clients = []
key_index = 0

for i in range(7):
    cur_key = os.environ.get(f"GROQ_API_KEY_{i+1}")
    clients.append(Groq(api_key=cur_key))

def get_next_client():
    """Get next client using round-robin distribution"""
    global key_index
    client = clients[key_index % 7]
    key_index += 1
    return client

TABLE_EXTRACTION_PROMPT = """
You are a data extraction engine. Analyze the following OCR text from a document page.

1. Identify ALL tables, lists, or structured data in the text. Look closely at the BOTTOM of tables or pages for footnotes, keys, or abbreviations (e.g., "* denotes estimated values" or "Rev = Revenue").
2. For each table, extract EVERY row as an individual "chunk" — a self-contained JSON record.
3. Provide a schema describing each field's name, data type, and a brief description. Incorporate any abbreviations Found into the column descriptions.
4. Write a concise summary of what the table represents.
5. Add relevant descriptive notes (e.g., currency, units, data quality caveats, footnotes, abbreviation definitions & full forms).
6. For each chunk, write a highly descriptive three-line natural language summary of that specific entry. This summary MUST explicitly feature all vital context parameters of the row including the main entity, and all the parameters present.

Output Format (JSON only):
{
  "tables": [
    {
      "table_name": "snake_case_name",
      "summary": "Brief description of what this table contains",
      "notes": "descriptive relevant context, units, caveats, abbreviations with full forms (important!)",
      "schema_fields": [
        {
          "name": "field_name",
          "type": "TEXT|NUMERIC|DATE|BOOLEAN",
          "description": "What this field represents (include full form if abbreviated in raw text)"
        }
      ],
      "chunks": [
        {
          "data": {"field_name": "value", ...},
          "text_summary": "One-line natural language summary of this entry"
        }
      ],
      "updated_notes": null | string
    }
  ]
}

RULES:
- Every row in the original table must become exactly one chunk.
- The "data" object keys must match the "schema_fields" field names exactly.
- The "text_summary" should be a readable sentence, not just key-value pairs (e.g., "In Q2 2023, Acme Corp generated $5M in revenue"). Include available dates, metric units, and periods!
- Use snake_case for table_name and field names.
- Infer data types: use NUMERIC for numbers, DATE for dates, BOOLEAN for yes/no, TEXT for everything else.
- CRITICAL CONTINUATION RULE: If previous tables are provided and you identify a table that is a continuation of a table from the previous page:
  1. You MUST inherit the exact "table_name" to link them.
  2. For the chunks, you MUST use the exact "schema_fields" from the provided previous table. Do not invent new column keys for the chunk data.
  3. However, if this new page contains crucial NEW context about the table at the bottom (like abbreviation definitions) that wasn't in the previous schema or notes:
     - Provide the NEW, improved notes in "updated_notes".
  4. If no new context is found, leave "updated_schema_fields" and "updated_notes" as null.
- If NO tables are found, return {"tables": []}.
"""

PDF_SUMMARY_PROMPT = """
You are a document analysis assistant. Given the text from the first pages of a PDF document, provide:
1. A concise, descriptive title for the document (not a filename — a proper human-readable title).
2. A brief summary (2-3 sentences) describing what the document is about.

Output Format (JSON only):
{
  "title": "Human-readable document title",
  "summary": "2-3 sentence summary of the document's content and purpose."
}
"""

SQL_GENERATION_PROMPT = """
You have access to a local SQL database (PostgreSQL).
The user asks: "{user_query}"
Relevant Table Schema: {table_schema_json}

Write a SINGLE SQL query to answer this. Do not use Markdown. Do not explain. Just the SQL.
"""

SNIP_SMART_CHUNK_PROMPT = """
You are an expert document chunking assistant for OCR text extracted from a screenshot.
Your task is to convert noisy OCR text into coherent, semantically meaningful chunks.

Input:
- Raw OCR text from a single screen snip image.

Output JSON format:
{
  "screenshot_summary": "A concise overall summary of this screenshot's content for coarse retrieval.",
  "chunks": [
    {
      "heading": "Short section heading",
      "text": "Complete chunk text, preserving important details and context.",
      "summary": "A dense semantic summary for retrieval embedding."
    }
  ]
}

Rules:
1. Produce chunks that are coherent sections, not fixed-size abrupt cuts.
2. Keep original order of information.
3. Use headings that are concise and human-readable.
4. "text" should contain the detailed content for that chunk.
5. "summary" should be retrieval-optimized, 1-2 sentences, high signal.
6. Remove obvious OCR garbage lines if they add no value, but do not drop meaningful data.
7. If tabular structure exists, keep rows together logically under the same chunk.
8. Always provide "screenshot_summary" when meaningful.
9. If OCR text is empty/useless, return {"screenshot_summary": "", "chunks": []}.
10. Return valid JSON only.
"""

BOOKMARK_SCREENSHOT_SEQUENCE_PROMPT = """
You are an expert OCR screenshot sequence chunking engine for bookmarked webpages.
You process ONE screenshot at a time, but you are given context from previous screenshots in the same ordered capture.

Goal:
1. Preserve continuation across screenshots.
2. Detect when current screenshot continues the previous heading/topic/list/table.
3. Produce detailed chunks that keep the current screenshot grounded in the larger page context.
4. Maintain semantic trace from source -> page heading -> section -> leaf topic.

Output JSON format:
{
  "screenshot_heading": "Best current heading for this screenshot. Inherit previous heading if this is clearly a continuation.",
  "screenshot_summary": "Concise summary of this screenshot in the bookmark sequence context.",
  "continued_from_previous": true,
  "inherited_heading": "Heading inherited from previous screenshot if applicable, else empty string",
  "chunks": [
    {
      "heading": "Chunk heading",
      "text": "Detailed chunk text",
      "summary": "Dense retrieval summary for this chunk",
      "context_prefix": ["source", "capture heading", "section heading", "topic leaf"],
      "layout_hint": "top|upper-mid|mid|lower-mid|bottom|full"
    }
  ]
}

Rules:
1. Use previous screenshot context when the current screenshot is a continuation.
2. If the screenshot starts in the middle of a list/table/panel with no new heading, inherit the previous heading.
3. Keep factual detail. Do not generalize specific entities away.
4. context_prefix must contain the full semantic trace from top to leaf, not just local labels.
5. Use layout_hint to preserve approximate spatial awareness.
6. If there are code snippets, names, lists, tables, or panels, preserve them explicitly in text and summary.
7. Return valid JSON only.
8. BOILERPLATE DEDUPLICATION: You will receive `previous_chunks` — all chunks extracted from the previous screenshot.
   - If a chunk in the CURRENT screenshot contains text that is substantially identical (same navigation links, same footer text, same repeated banner/header) to any text_preview in previous_chunks, SKIP it — do not emit it.
   - "Substantially identical" means the same UI component (e.g. a navbar listing the same links, a footer with the same copyright text). Minor wording differences do not count.
   - EXCEPTION: mid-page content (layout_hint: mid, upper-mid, lower-mid) must NEVER be skipped on this basis — only top/bottom UI chrome gets filtered.
   - IMPORTANT: Still read all OCR text including boilerplate when deciding `continued_from_previous`. Skipping a chunk for output does NOT mean ignoring it for continuation detection.
   - Always emit at least one chunk even if most content is boilerplate.
"""

DEV_BOOKMARK_FRAGMENT_PROMPT = """
You are a precision information refactoring engine.
Given source text and optional hierarchy hints, produce detailed retrieval fragments.

Goal hierarchy (semantic, not HTML):
source -> capture_heading -> heading -> sub_heading -> topic

Output JSON format:
{
  "window_keywords": ["keyword1", "keyword2", "..."],
  "fragments": [
    {
      "capture_heading": "ultimate heading for the captured source",
      "heading": "semantic heading",
      "sub_heading": "optional sub heading",
      "topic": "specific topic label",
      "level": 1,
      "context_prefix": ["MUST include full trace from capture_heading to leaf"],
      "evidence_quote": "exact short quote copied from source window to map location",
      "text": "detailed fragment text",
      "summary": "dense retrieval-oriented summary"
    }
  ]
}

Rules:
1. Preserve factual detail. Do not paraphrase away important specifics.
2. Fragments should be coherent and smaller than the input window.
3. context_prefix MUST contain complete hierarchical trace from top to leaf.
4. Maintain source->capture_heading->heading->sub_heading->topic organization.
5. Do not output markdown. Return valid JSON only.
"""

DEV_BOOKMARK_MERGE_PROMPT = """
You merge boundary-adjacent fragments from two neighboring windows.

Input:
- prev_last_fragment
- next_first_fragment

Output JSON:
{
  "should_merge": true|false,
  "merged_fragment": {
    "heading": "...",
    "topic": "...",
    "level": 1,
    "context_prefix": ["..."],
    "text": "...",
    "summary": "..."
  },
  "reason": "short reason"
}

Rules:
1. Merge only if they are clearly continuation of same idea.
2. Preserve all key facts.
3. If no merge needed, return should_merge=false.
4. Valid JSON only.
"""


def extract_tables_from_text(text: str, previous_tables: list = None) -> Tuple[List[TableExtraction], Dict[str, str]]:
    messages = [
        {"role": "system", "content": TABLE_EXTRACTION_PROMPT + "\n\nCRITICAL: You must return a valid JSON object with a 'tables' key."}
    ]
    
    if previous_tables:
        messages.append({
            "role": "user", 
            "content": f"PREVIOUS PAGE TABLES SCHEMAS (inherit if continuing, but update via updated_notes if new/important context found):\n{json.dumps(previous_tables, indent=2)}"
        })
        
    messages.append({"role": "user", "content": text})
    
    completion = get_next_client().chat.completions.create(
        model="openai/gpt-oss-120b",
        messages=messages,
        temperature=0,
        response_format={"type": "json_object"}
    )
    
    content = completion.choices[0].message.content
    debug_info = {
        "ocr_text": text,
        "prompt_sent": json.dumps(messages, indent=2),
        "raw_response": content
    }

    try:
        data = json.loads(content)
        if isinstance(data, list):
            return [TableExtraction(**item) for item in data], debug_info
        if "tables" in data:
            return [TableExtraction(**item) for item in data["tables"]], debug_info
        return [], debug_info
    except Exception as e:
        print(f"Error parsing AI response: {e}")
        return [], debug_info


def extract_pdf_summary(page_texts: list[str]) -> dict:
    """Extract title and summary from first pages of a PDF."""
    combined = "\n\n---PAGE BREAK---\n\n".join(page_texts)
    
    messages = [
        {"role": "system", "content": PDF_SUMMARY_PROMPT + "\n\nCRITICAL: Return valid JSON only."},
        {"role": "user", "content": combined}
    ]
    
    completion = get_next_client().chat.completions.create(
        model="openai/gpt-oss-120b",
        messages=messages,
        temperature=0,
        response_format={"type": "json_object"}
    )
    
    content = completion.choices[0].message.content
    try:
        data = json.loads(content)
        return {"title": data.get("title", ""), "summary": data.get("summary", "")}
    except Exception as e:
        print(f"Error parsing PDF summary: {e}")
        return {"title": "", "summary": ""}


def generate_sql_query(user_query: str, table_schema: dict) -> str:
    prompt = SQL_GENERATION_PROMPT.format(user_query=user_query, table_schema_json=json.dumps(table_schema))
    
    completion = get_next_client().chat.completions.create(
        model="openai/gpt-oss-120b",
        messages=[
            {"role": "system", "content": "You are a SQL expert."},
            {"role": "user", "content": prompt}
        ],
        temperature=0
    )
    
    sql = completion.choices[0].message.content.strip()
    sql = sql.replace("```sql", "").replace("```", "").strip()
    return sql


def _fallback_smart_chunk_screen_snip(ocr_text: str) -> List[Dict[str, str]]:
    text = (ocr_text or "").strip()
    if not text:
        return []

    # Paragraph-aware fallback before hard windowing.
    blocks = [b.strip() for b in text.split("\n\n") if b and b.strip()]
    if not blocks:
        blocks = [text]

    chunks: List[Dict[str, str]] = []
    buffer = ""
    target = 900
    overlap = 120

    for block in blocks:
        candidate = f"{buffer}\n\n{block}".strip() if buffer else block
        if len(candidate) <= target:
            buffer = candidate
            continue

        if buffer:
            lines = [ln.strip() for ln in buffer.splitlines() if ln.strip()]
            heading = lines[0][:80] if lines else "Screen Snip Section"
            summary = buffer[:220].replace("\n", " ")
            chunks.append({
                "heading": heading or "Screen Snip Section",
                "text": buffer,
                "summary": summary
            })
            tail = buffer[-overlap:] if len(buffer) > overlap else ""
            buffer = f"{tail}\n{block}".strip()
        else:
            # Rare oversized single block.
            start = 0
            while start < len(block):
                end = min(len(block), start + target)
                piece = block[start:end].strip()
                if piece:
                    lines = [ln.strip() for ln in piece.splitlines() if ln.strip()]
                    heading = lines[0][:80] if lines else "Screen Snip Section"
                    summary = piece[:220].replace("\n", " ")
                    chunks.append({
                        "heading": heading or "Screen Snip Section",
                        "text": piece,
                        "summary": summary
                    })
                if end >= len(block):
                    break
                start = max(0, end - overlap)

    if buffer:
        lines = [ln.strip() for ln in buffer.splitlines() if ln.strip()]
        heading = lines[0][:80] if lines else "Screen Snip Section"
        summary = buffer[:220].replace("\n", " ")
        chunks.append({
            "heading": heading or "Screen Snip Section",
            "text": buffer,
            "summary": summary
        })

    return chunks


def smart_chunk_screen_snip(ocr_text: str) -> Tuple[List[Dict[str, str]], str, Dict[str, str]]:
    messages = [
        {"role": "system", "content": SNIP_SMART_CHUNK_PROMPT},
        {"role": "user", "content": ocr_text or ""}
    ]

    debug_info = {
        "ocr_text": ocr_text or "",
        "prompt_sent": json.dumps(messages, indent=2),
        "raw_response": ""
    }

    if not (ocr_text or "").strip():
        return [], "", debug_info

    try:
        completion = get_next_client().chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=messages,
            temperature=0,
            response_format={"type": "json_object"}
        )
        content = completion.choices[0].message.content or ""
        debug_info["raw_response"] = content

        data = json.loads(content)
        screenshot_summary = ""
        if isinstance(data, dict):
            screenshot_summary = str(data.get("screenshot_summary", "")).strip()
        raw_chunks = data.get("chunks", []) if isinstance(data, dict) else []
        parsed: List[Dict[str, str]] = []
        for item in raw_chunks:
            if not isinstance(item, dict):
                continue
            heading = str(item.get("heading", "")).strip()
            text = str(item.get("text", "")).strip()
            summary = str(item.get("summary", "")).strip()
            if not text:
                continue
            if not heading:
                heading = "Screen Snip Section"
            if not summary:
                summary = text[:220].replace("\n", " ")
            parsed.append({
                "heading": heading,
                "text": text,
                "summary": summary
            })

        if parsed:
            if not screenshot_summary:
                screenshot_summary = " ".join([c["summary"] for c in parsed[:3]]).strip()[:320]
            return parsed, screenshot_summary, debug_info
    except Exception as e:
        debug_info["error"] = str(e)

    fallback = _fallback_smart_chunk_screen_snip(ocr_text)
    fallback_summary = " ".join([c["summary"] for c in fallback[:3]]).strip()[:320] if fallback else ""
    return fallback, fallback_summary, debug_info


def _slice_lines(lines: List[str], start: int, end: int) -> str:
    return "\n".join([line for line in lines[start:end] if line]).strip()


def _build_screenshot_layout_hints(ocr_text: str) -> Dict[str, str]:
    lines = [re.sub(r"\s+", " ", line).strip() for line in (ocr_text or "").splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        return {
            "top": "",
            "middle": "",
            "bottom": "",
            "line_count": 0
        }

    total = len(lines)
    middle_start = max(0, (total // 2) - 3)
    middle_end = min(total, middle_start + 6)
    return {
        "top": _slice_lines(lines, 0, min(total, 6)),
        "middle": _slice_lines(lines, middle_start, middle_end),
        "bottom": _slice_lines(lines, max(0, total - 6), total),
        "line_count": total
    }


def _compact_prefix_label(value: str, fallback: str = "") -> str:
    compact = re.sub(r"\s+", " ", (value or "").strip())
    if not compact:
        compact = fallback
    return compact[:140]


def _normalize_layout_hint(value: str) -> str:
    normalized = str(value or "").strip().lower()
    allowed = {"top", "upper-mid", "mid", "lower-mid", "bottom", "full"}
    return normalized if normalized in allowed else "full"


def _build_screenshot_context_prefix(
    source_title: str,
    bookmark_summary_context: str,
    screenshot_heading: str,
    chunk_heading: str,
    inherited_heading: str = "",
    extra: Optional[List[str]] = None
) -> List[str]:
    bookmark_label = ""
    summary = _compact_prefix_label(bookmark_summary_context)
    if summary:
        bookmark_label = summary.split(".")[0][:140].strip()

    prefix_items = [
        _compact_prefix_label(source_title, "Bookmark Capture"),
        bookmark_label,
        _compact_prefix_label(inherited_heading or screenshot_heading, "Screenshot Context"),
        _compact_prefix_label(chunk_heading or screenshot_heading, "Detail")
    ]
    if extra:
        prefix_items.extend([_compact_prefix_label(item) for item in extra if item])

    out: List[str] = []
    seen = set()
    for item in prefix_items:
        token = str(item or "").strip()
        if not token:
            continue
        key = token.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(token)
    return out[:12]


def _normalize_sequence_chunk(
    item: Dict[str, Any],
    source_title: str,
    bookmark_summary_context: str,
    screenshot_heading: str,
    inherited_heading: str,
    screenshot_continues: bool,
    fallback_index: int
) -> Optional[Dict[str, Any]]:
    if not isinstance(item, dict):
        return None

    text = str(item.get("text", "")).strip()
    if not text:
        return None

    chunk_heading = str(item.get("heading", "")).strip() or screenshot_heading or f"Screenshot Detail {fallback_index}"
    summary = str(item.get("summary", "")).strip() or text[:220].replace("\n", " ")
    context_prefix = item.get("context_prefix", [])
    if not isinstance(context_prefix, list) or not any(str(token or "").strip() for token in context_prefix):
        context_prefix = _build_screenshot_context_prefix(
            source_title=source_title,
            bookmark_summary_context=bookmark_summary_context,
            screenshot_heading=screenshot_heading,
            chunk_heading=chunk_heading,
            inherited_heading=inherited_heading
        )
    else:
        context_prefix = [str(token).strip() for token in context_prefix if str(token).strip()][:12]

    return {
        "heading": chunk_heading[:180],
        "text": text,
        "summary": summary[:320],
        "context_prefix": context_prefix,
        "layout_hint": _normalize_layout_hint(str(item.get("layout_hint", ""))),
        "continued_from_previous": bool(item.get("continued_from_previous", screenshot_continues))
    }


def _fallback_sequence_screenshot_result(
    screenshot_index: int,
    ocr_text: str,
    source_title: str,
    bookmark_summary_context: str,
    previous_state: Dict[str, Any]
) -> Dict[str, Any]:
    chunks, screenshot_summary, _ = smart_chunk_screen_snip(ocr_text)
    previous_heading = str(previous_state.get("screenshot_heading", "")).strip()
    previous_tail = previous_state.get("tail_chunks", []) or []
    lines = [line.strip() for line in (ocr_text or "").splitlines() if line.strip()]
    first_line = lines[0][:180] if lines else ""
    looks_like_heading = bool(first_line) and len(first_line.split()) <= 12 and not first_line.endswith((".", ",", ";"))
    continues = bool(previous_heading) and (not looks_like_heading)
    screenshot_heading = first_line if looks_like_heading else (previous_heading or f"Screenshot {screenshot_index + 1}")
    inherited_heading = previous_heading if continues else ""

    normalized_chunks: List[Dict[str, Any]] = []
    for idx, chunk in enumerate(chunks, start=1):
        normalized = _normalize_sequence_chunk(
            item=chunk,
            source_title=source_title,
            bookmark_summary_context=bookmark_summary_context,
            screenshot_heading=screenshot_heading,
            inherited_heading=inherited_heading,
            screenshot_continues=continues,
            fallback_index=idx
        )
        if normalized:
            normalized_chunks.append(normalized)

    if not normalized_chunks and (ocr_text or "").strip():
        fallback = _fallback_smart_chunk_screen_snip(ocr_text)
        for idx, chunk in enumerate(fallback, start=1):
            normalized = _normalize_sequence_chunk(
                item=chunk,
                source_title=source_title,
                bookmark_summary_context=bookmark_summary_context,
                screenshot_heading=screenshot_heading,
                inherited_heading=inherited_heading,
                screenshot_continues=continues,
                fallback_index=idx
            )
            if normalized:
                normalized_chunks.append(normalized)

    tail_seed = previous_tail[-1] if previous_tail else {}
    if not screenshot_summary:
        first_summary = normalized_chunks[0]["summary"] if normalized_chunks else ""
        screenshot_summary = " ".join(filter(None, [tail_seed.get("summary", ""), first_summary])).strip()[:360] or (ocr_text or "").strip()[:360]

    return {
        "screenshot_index": screenshot_index,
        "screenshot_heading": screenshot_heading[:220],
        "screenshot_summary": screenshot_summary[:420],
        "continued_from_previous": continues,
        "inherited_heading": inherited_heading[:220],
        "context_prefix": _build_screenshot_context_prefix(
            source_title=source_title,
            bookmark_summary_context=bookmark_summary_context,
            screenshot_heading=screenshot_heading,
            chunk_heading=screenshot_heading,
            inherited_heading=inherited_heading
        ),
        "chunks": normalized_chunks
    }


def process_bookmark_screenshot_sequence(
    screenshots: List[Dict[str, Any]],
    source_title: str = "",
    bookmark_summary_context: str = "",
    initial_context: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    normalized_inputs = []
    for idx, item in enumerate(screenshots or []):
        if not isinstance(item, dict):
            continue
        ocr_text = str(item.get("ocr_text", "")).strip()
        if not ocr_text:
            continue
        normalized_inputs.append({
            "screenshot_index": int(item.get("screenshot_index", idx)),
            "ocr_text": ocr_text,
            "asset_id": item.get("asset_id")
        })

    if not normalized_inputs:
        return {"screenshots": [], "debug_info": {"error": "empty_screenshot_sequence"}}

    debug_steps: List[Dict[str, Any]] = []
    outputs: List[Dict[str, Any]] = []
    initial_context = initial_context or {}
    previous_state: Dict[str, Any] = {
        "screenshot_heading": str(initial_context.get("previous_screenshot_heading", "")).strip(),
        "screenshot_summary": str(initial_context.get("previous_screenshot_summary", "")).strip(),
        "all_chunks": [],  # all chunks from previous screenshot for boilerplate dedup
        "tail_chunks": initial_context.get("previous_tail_chunks", []) or [],
        "context_prefix": initial_context.get("previous_context_prefix", []) or []
    }

    for idx, shot in enumerate(normalized_inputs):
        layout_context = _build_screenshot_layout_hints(shot["ocr_text"])

        # All previous chunks for boilerplate dedup — capped text_preview to keep payload lean
        previous_chunks_for_dedup = []
        for chunk in previous_state.get("all_chunks", []):
            if not isinstance(chunk, dict):
                continue
            previous_chunks_for_dedup.append({
                "heading": str(chunk.get("heading", "")).strip(),
                "text_preview": str(chunk.get("text", "")).strip(),
                "layout_hint": _normalize_layout_hint(str(chunk.get("layout_hint", "")))
            })

        # Also build tail_chunks for continuation (kept for backward compat with context_prefix logic)
        previous_tail_chunks = []
        for tail in previous_state.get("tail_chunks", [])[-2:]:
            if not isinstance(tail, dict):
                continue
            previous_tail_chunks.append({
                "heading": str(tail.get("heading", "")).strip(),
                "summary": str(tail.get("summary", "")).strip(),
                "text_preview": str(tail.get("text", "")).strip()[:320],
                "layout_hint": _normalize_layout_hint(str(tail.get("layout_hint", "")))
            })

        payload = {
            "source_title": source_title,
            "bookmark_summary_context": bookmark_summary_context,
            "screenshot_index": shot["screenshot_index"],
            "layout_context": layout_context,
            "ocr_text": shot["ocr_text"],
            "previous_context": {
                "previous_screenshot_heading": previous_state.get("screenshot_heading", ""),
                "previous_screenshot_summary": previous_state.get("screenshot_summary", ""),
                "previous_context_prefix": previous_state.get("context_prefix", []),
                "previous_tail_chunks": previous_tail_chunks,
                "previous_chunks": previous_chunks_for_dedup
            }
        }
        messages = [
            {"role": "system", "content": BOOKMARK_SCREENSHOT_SEQUENCE_PROMPT},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}
        ]

        debug_entry: Dict[str, Any] = {
            "screenshot_index": shot["screenshot_index"],
            "prompt": messages,
            "raw_response": "",
            "fallback_used": False
        }

        parsed: Optional[Dict[str, Any]] = None
        try:
            parsed, raw_response = _call_json_llm(messages, temperature=0.1)
            debug_entry["raw_response"] = raw_response
        except Exception as e:
            debug_entry["error"] = str(e)

        screenshot_result: Optional[Dict[str, Any]] = None
        if parsed and isinstance(parsed, dict):
            screenshot_heading = str(parsed.get("screenshot_heading", "")).strip() or str(previous_state.get("screenshot_heading", "")).strip() or f"Screenshot {shot['screenshot_index'] + 1}"
            continued_from_previous = bool(parsed.get("continued_from_previous", False))
            inherited_heading = str(parsed.get("inherited_heading", "")).strip()
            if continued_from_previous and not inherited_heading:
                inherited_heading = str(previous_state.get("screenshot_heading", "")).strip()
            screenshot_summary = str(parsed.get("screenshot_summary", "")).strip()

            raw_chunks = parsed.get("chunks", [])
            normalized_chunks: List[Dict[str, Any]] = []
            if isinstance(raw_chunks, list):
                for chunk_index, item in enumerate(raw_chunks, start=1):
                    normalized = _normalize_sequence_chunk(
                        item=item,
                        source_title=source_title,
                        bookmark_summary_context=bookmark_summary_context,
                        screenshot_heading=screenshot_heading,
                        inherited_heading=inherited_heading,
                        screenshot_continues=continued_from_previous,
                        fallback_index=chunk_index
                    )
                    if normalized:
                        normalized_chunks.append(normalized)

            if normalized_chunks:
                if not screenshot_summary:
                    screenshot_summary = " ".join([chunk["summary"] for chunk in normalized_chunks[:2]]).strip()[:420]
                screenshot_result = {
                    "screenshot_index": shot["screenshot_index"],
                    "screenshot_heading": screenshot_heading[:220],
                    "screenshot_summary": screenshot_summary[:420],
                    "continued_from_previous": continued_from_previous,
                    "inherited_heading": inherited_heading[:220],
                    "context_prefix": _build_screenshot_context_prefix(
                        source_title=source_title,
                        bookmark_summary_context=bookmark_summary_context,
                        screenshot_heading=screenshot_heading,
                        chunk_heading=screenshot_heading,
                        inherited_heading=inherited_heading,
                        extra=previous_state.get("context_prefix", [])[:2] if idx == 0 else None
                    ),
                    "chunks": normalized_chunks
                }

        if not screenshot_result:
            screenshot_result = _fallback_sequence_screenshot_result(
                screenshot_index=shot["screenshot_index"],
                ocr_text=shot["ocr_text"],
                source_title=source_title,
                bookmark_summary_context=bookmark_summary_context,
                previous_state=previous_state
            )
            debug_entry["fallback_used"] = True

        outputs.append(screenshot_result)
        previous_state = {
            "screenshot_heading": screenshot_result.get("screenshot_heading", ""),
            "screenshot_summary": screenshot_result.get("screenshot_summary", ""),
            "all_chunks": screenshot_result.get("chunks", []),  # ALL chunks for next-screenshot dedup
            "tail_chunks": screenshot_result.get("chunks", [])[-2:],
            "context_prefix": screenshot_result.get("context_prefix", [])
        }
        debug_entry["output"] = {
            "screenshot_heading": screenshot_result.get("screenshot_heading", ""),
            "continued_from_previous": screenshot_result.get("continued_from_previous", False),
            "chunk_count": len(screenshot_result.get("chunks", []))
        }
        debug_steps.append(debug_entry)

    return {
        "screenshots": outputs,
        "debug_info": {
            "source_title": source_title,
            "bookmark_summary_context": bookmark_summary_context[:420],
            "initial_context": initial_context,
            "steps": debug_steps
        }
    }


def _split_text_windows(text: str, max_chars: int = 12000, overlap_chars: int = 1200) -> List[Dict[str, Any]]:
    source = (text or "").strip()
    if not source:
        return []

    windows: List[Dict[str, Any]] = []
    n = len(source)
    start = 0
    idx = 0

    while start < n:
        end = min(n, start + max_chars)

        # Prefer cutting on paragraph/newline boundaries to reduce abrupt breaks.
        if end < n:
            boundary = source.rfind("\n\n", start + int(max_chars * 0.55), end)
            if boundary == -1:
                boundary = source.rfind("\n", start + int(max_chars * 0.55), end)
            if boundary != -1 and boundary > start + int(max_chars * 0.4):
                end = boundary

        snippet = source[start:end].strip()
        if snippet:
            windows.append({
                "window_index": idx,
                "start_char": start,
                "end_char": end,
                "text": snippet
            })
            idx += 1

        if end >= n:
            break
        start = max(0, end - overlap_chars)

    return windows


def _extract_capture_heading(source_title: str, hierarchy_text: str, raw_text: str) -> str:
    title = (source_title or "").strip()
    if title:
        return title

    hierarchy = (hierarchy_text or "").strip()
    if hierarchy:
        for line in hierarchy.splitlines():
            cleaned = re.sub(r"^\s*-\s*\[[^\]]+\]\s*", "", line).strip()
            if cleaned and len(cleaned) > 2:
                return cleaned[:220]

    text = (raw_text or "").strip()
    for line in text.splitlines():
        cleaned = line.strip()
        if cleaned and len(cleaned) > 3:
            return cleaned[:220]
    return "Captured Source"


def _build_trace_prefix(
    source_title: str,
    capture_heading: str,
    heading: str,
    sub_heading: str,
    topic: str,
    carry_keywords: List[str]
) -> List[str]:
    trace = [
        (source_title or "").strip(),
        (capture_heading or "").strip(),
        (heading or "").strip(),
        (sub_heading or "").strip(),
        (topic or "").strip()
    ]
    out: List[str] = []
    seen = set()
    for item in trace + carry_keywords:
        token = str(item or "").strip()
        if not token:
            continue
        key = token.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(token)
    return out[:16]


def _find_source_range(
    window_text: str,
    absolute_window_start: int,
    fragment_text: str,
    evidence_quote: str = "",
    summary: str = ""
) -> Dict[str, Any]:
    source = window_text or ""
    lower_source = source.lower()

    candidates = []
    for value in [evidence_quote, fragment_text, summary]:
        text = str(value or "").strip()
        if text:
            candidates.append(text)

    def try_exact(candidate: str) -> Optional[Tuple[int, int, str]]:
        normalized = re.sub(r"\s+", " ", candidate).strip()
        if len(normalized) < 10:
            return None
        idx = lower_source.find(normalized.lower())
        if idx != -1:
            return idx, idx + len(normalized), "high"
        short = normalized[: min(140, len(normalized))]
        idx2 = lower_source.find(short.lower())
        if idx2 != -1:
            return idx2, idx2 + len(short), "medium"
        return None

    for cand in candidates:
        hit = try_exact(cand)
        if hit:
            local_start, local_end, confidence = hit
            return {
                "absolute_start_char": absolute_window_start + local_start,
                "absolute_end_char": absolute_window_start + local_end,
                "window_start_char": absolute_window_start,
                "window_end_char": absolute_window_start + len(source),
                "confidence": confidence,
                "evidence_quote": cand[:240]
            }

    # Fuzzy fallback if no exact quote is found.
    if candidates and source:
        probe = re.sub(r"\s+", " ", candidates[0]).strip()[:220]
        if len(probe) >= 16:
            ratio = SequenceMatcher(None, lower_source[:5000], probe.lower()).find_longest_match(0, min(len(lower_source), 5000), 0, len(probe))
            if ratio.size >= 12:
                local_start = ratio.a
                local_end = ratio.a + ratio.size
                return {
                    "absolute_start_char": absolute_window_start + local_start,
                    "absolute_end_char": absolute_window_start + local_end,
                    "window_start_char": absolute_window_start,
                    "window_end_char": absolute_window_start + len(source),
                    "confidence": "low",
                    "evidence_quote": probe
                }

    return {
        "absolute_start_char": absolute_window_start,
        "absolute_end_char": absolute_window_start + len(source),
        "window_start_char": absolute_window_start,
        "window_end_char": absolute_window_start + len(source),
        "confidence": "none",
        "evidence_quote": ""
    }


def _normalize_fragment(
    item: Dict[str, Any],
    source_title: str,
    capture_heading_default: str,
    fallback_index: int,
    carry_keywords: List[str]
) -> Optional[Dict[str, Any]]:
    if not isinstance(item, dict):
        return None
    text = str(item.get("text", "")).strip()
    if not text:
        return None

    capture_heading = str(item.get("capture_heading", "")).strip() or capture_heading_default
    heading = str(item.get("heading", "")).strip() or "General"
    sub_heading = str(item.get("sub_heading", "")).strip()
    topic = str(item.get("topic", "")).strip() or sub_heading or heading
    level_raw = item.get("level", 1)
    try:
        level = int(level_raw)
    except Exception:
        level = 1
    level = max(1, min(4, level))

    normalized_prefix = _build_trace_prefix(
        source_title=source_title,
        capture_heading=capture_heading,
        heading=heading,
        sub_heading=sub_heading,
        topic=topic,
        carry_keywords=carry_keywords
    )

    summary = str(item.get("summary", "")).strip()
    if not summary:
        summary = text[:260].replace("\n", " ")
    evidence_quote = str(item.get("evidence_quote", "")).strip()

    return {
        "fragment_id": f"frag_{fallback_index}",
        "hierarchy": {
            "source": source_title or "unknown_source",
            "capture_heading": capture_heading or (source_title or "unknown_source"),
            "heading": heading,
            "sub_heading": sub_heading or None,
            "topic": topic,
            "level": level
        },
        "context_prefix": normalized_prefix,
        "trace_path": " > ".join([p for p in [
            source_title or "unknown_source",
            capture_heading,
            heading,
            sub_heading,
            topic
        ] if p]),
        "text": text,
        "summary": summary,
        "evidence_quote": evidence_quote
    }


def _call_json_llm(messages: List[Dict[str, str]], temperature: float = 0.1) -> Tuple[Optional[Dict[str, Any]], str]:
    completion = get_next_client().chat.completions.create(
        model="openai/gpt-oss-120b",
        messages=messages,
        temperature=temperature,
        response_format={"type": "json_object"}
    )
    content = completion.choices[0].message.content or ""
    try:
        return json.loads(content), content
    except Exception:
        return None, content


def process_dev_bookmark_fragments(
    source_title: str,
    raw_text: str,
    hierarchy_text: str = "",
    max_window_chars: int = 12000,
    overlap_chars: int = 1200
) -> Dict[str, Any]:
    text = (raw_text or "").strip()
    if not text:
        return {
            "source_title": source_title or "",
            "fragments": [],
            "debug_info": {
                "error": "empty_raw_text",
                "windows": [],
                "merge_steps": []
            }
        }

    safe_max = max(2500, min(24000, int(max_window_chars or 12000)))
    safe_overlap = max(200, min(4000, int(overlap_chars or 1200)))
    windows = _split_text_windows(text, max_chars=safe_max, overlap_chars=safe_overlap)

    all_fragments: List[Dict[str, Any]] = []
    debug_windows: List[Dict[str, Any]] = []
    merge_steps: List[Dict[str, Any]] = []

    carry_keywords: List[str] = []
    previous_last_fragment: Optional[Dict[str, Any]] = None
    fragment_counter = 1

    hierarchy_hint = (hierarchy_text or "").strip()
    if len(hierarchy_hint) > 5000:
        hierarchy_hint = hierarchy_hint[:5000]
    capture_heading = _extract_capture_heading(source_title, hierarchy_hint, text)

    for window in windows:
        prev_context = {
            "carry_keywords": carry_keywords[:12],
            "previous_last_fragment": previous_last_fragment or {}
        }
        payload = {
            "source_title": source_title,
            "capture_heading": capture_heading,
            "hierarchy_hint": hierarchy_hint,
            "window_index": window["window_index"],
            "window_text": window["text"],
            "previous_context": prev_context
        }
        messages = [
            {"role": "system", "content": DEV_BOOKMARK_FRAGMENT_PROMPT},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}
        ]

        parsed, raw_response = _call_json_llm(messages, temperature=0.1)
        debug_entry = {
            "window_index": window["window_index"],
            "start_char": window["start_char"],
            "end_char": window["end_char"],
            "input_chars": len(window["text"]),
            "prompt": messages,
            "raw_response": raw_response
        }

        window_keywords: List[str] = []
        window_fragments: List[Dict[str, Any]] = []

        if parsed and isinstance(parsed, dict):
            kws = parsed.get("window_keywords", [])
            if isinstance(kws, list):
                window_keywords = [str(x).strip() for x in kws if str(x).strip()]

            raw_frags = parsed.get("fragments", [])
            if isinstance(raw_frags, list):
                for item in raw_frags:
                    normalized = _normalize_fragment(
                        item,
                        source_title,
                        capture_heading,
                        fragment_counter,
                        carry_keywords
                    )
                    if not normalized:
                        continue
                    normalized["window_index"] = window["window_index"]
                    normalized["source_mapping"] = _find_source_range(
                        window_text=window["text"],
                        absolute_window_start=window["start_char"],
                        fragment_text=normalized.get("text", ""),
                        evidence_quote=normalized.get("evidence_quote", ""),
                        summary=normalized.get("summary", "")
                    )
                    window_fragments.append(normalized)
                    fragment_counter += 1

        if not window_fragments:
            # Deterministic fallback if model returns invalid output.
            fallback_text = window["text"].strip()
            if fallback_text:
                window_fragments = [{
                    "fragment_id": f"frag_{fragment_counter}",
                    "hierarchy": {
                        "source": source_title or "unknown_source",
                        "capture_heading": capture_heading,
                        "heading": "General",
                        "sub_heading": None,
                        "topic": "Window Segment",
                        "level": 1
                    },
                    "context_prefix": _build_trace_prefix(
                        source_title=source_title,
                        capture_heading=capture_heading,
                        heading="General",
                        sub_heading="",
                        topic="Window Segment",
                        carry_keywords=carry_keywords
                    ),
                    "trace_path": " > ".join([p for p in [source_title or "unknown_source", capture_heading, "General", "Window Segment"] if p]),
                    "text": fallback_text,
                    "summary": fallback_text[:260].replace("\n", " "),
                    "window_index": window["window_index"],
                    "evidence_quote": fallback_text[:220],
                    "source_mapping": {
                        "absolute_start_char": window["start_char"],
                        "absolute_end_char": window["end_char"],
                        "window_start_char": window["start_char"],
                        "window_end_char": window["end_char"],
                        "confidence": "window_fallback",
                        "evidence_quote": fallback_text[:120]
                    }
                }]
                fragment_counter += 1
            debug_entry["fallback_used"] = True
        else:
            debug_entry["fallback_used"] = False

        # Boundary merge agent: previous last vs current first.
        if previous_last_fragment and window_fragments:
            merge_payload = {
                "prev_last_fragment": {
                    "heading": previous_last_fragment["hierarchy"]["heading"],
                    "topic": previous_last_fragment["hierarchy"]["topic"],
                    "level": previous_last_fragment["hierarchy"]["level"],
                    "context_prefix": previous_last_fragment.get("context_prefix", []),
                    "text": previous_last_fragment.get("text", ""),
                    "summary": previous_last_fragment.get("summary", "")
                },
                "next_first_fragment": {
                    "heading": window_fragments[0]["hierarchy"]["heading"],
                    "topic": window_fragments[0]["hierarchy"]["topic"],
                    "level": window_fragments[0]["hierarchy"]["level"],
                    "context_prefix": window_fragments[0].get("context_prefix", []),
                    "text": window_fragments[0].get("text", ""),
                    "summary": window_fragments[0].get("summary", "")
                }
            }
            merge_messages = [
                {"role": "system", "content": DEV_BOOKMARK_MERGE_PROMPT},
                {"role": "user", "content": json.dumps(merge_payload, ensure_ascii=False)}
            ]
            merge_parsed, merge_raw = _call_json_llm(merge_messages, temperature=0)
            merge_debug = {
                "window_index": window["window_index"],
                "prompt": merge_messages,
                "raw_response": merge_raw,
                "applied": False
            }

            if merge_parsed and isinstance(merge_parsed, dict) and bool(merge_parsed.get("should_merge", False)):
                merged_candidate = merge_parsed.get("merged_fragment", {})
                normalized_merged = _normalize_fragment(
                    merged_candidate if isinstance(merged_candidate, dict) else {},
                    source_title,
                    capture_heading,
                    fragment_counter,
                    carry_keywords
                )
                if normalized_merged:
                    prev_map = previous_last_fragment.get("source_mapping", {}) if previous_last_fragment else {}
                    next_map = window_fragments[0].get("source_mapping", {}) if window_fragments else {}
                    prev_start = prev_map.get("absolute_start_char")
                    prev_end = prev_map.get("absolute_end_char")
                    next_start = next_map.get("absolute_start_char")
                    next_end = next_map.get("absolute_end_char")
                    if all(isinstance(x, int) for x in [prev_start, prev_end, next_start, next_end]):
                        normalized_merged["source_mapping"] = {
                            "absolute_start_char": min(prev_start, next_start),
                            "absolute_end_char": max(prev_end, next_end),
                            "window_start_char": min(prev_map.get("window_start_char", prev_start), next_map.get("window_start_char", next_start)),
                            "window_end_char": max(prev_map.get("window_end_char", prev_end), next_map.get("window_end_char", next_end)),
                            "confidence": "merged",
                            "evidence_quote": normalized_merged.get("evidence_quote", "")
                        }
                    else:
                        normalized_merged["source_mapping"] = _find_source_range(
                            window_text=window["text"],
                            absolute_window_start=window["start_char"],
                            fragment_text=normalized_merged.get("text", ""),
                            evidence_quote=normalized_merged.get("evidence_quote", ""),
                            summary=normalized_merged.get("summary", "")
                        )
                    normalized_merged["fragment_id"] = previous_last_fragment["fragment_id"]
                    normalized_merged["window_index"] = window["window_index"]
                    # Replace previous last + drop current first.
                    if all_fragments:
                        all_fragments[-1] = normalized_merged
                        previous_last_fragment = normalized_merged
                    window_fragments = window_fragments[1:]
                    merge_debug["applied"] = True
                    merge_debug["reason"] = str(merge_parsed.get("reason", "")).strip()

            merge_steps.append(merge_debug)

        all_fragments.extend(window_fragments)
        previous_last_fragment = all_fragments[-1] if all_fragments else None

        if window_keywords:
            carry_keywords = window_keywords[:12]
        elif previous_last_fragment:
            carry_keywords = [str(previous_last_fragment.get("summary", ""))[:80]]

        debug_entry["produced_fragments"] = len(window_fragments)
        debug_entry["window_keywords"] = carry_keywords
        debug_windows.append(debug_entry)

    # Ensure stable fragment ids after boundary operations.
    for idx, frag in enumerate(all_fragments, start=1):
        frag["fragment_id"] = f"frag_{idx}"

    return {
        "source_title": source_title or "",
        "fragments": all_fragments,
        "debug_info": {
            "capture_heading": capture_heading,
            "window_count": len(windows),
            "safe_max_window_chars": safe_max,
            "safe_overlap_chars": safe_overlap,
            "windows": debug_windows,
            "merge_steps": merge_steps
        }
    }

RAG_CHAT_PROMPT = """
You are the MEMUX simple RAG response engine.
You receive:
- the user question,
- recent conversation for interpretation,
- and packed context chunks retrieved from the user's sources.

Each context chunk includes:
- source_id
- filename
- location
- source_type
- segment_type
- summary
- raw_evidence
- expanded_context
- structured_data

RULES:
1. Answer ONLY from the provided context chunks.
2. Use citations inline like [doc_0], [doc_2].
3. Prefer exact facts, names, numbers, code, and wording from raw_evidence and expanded_context.
4. If multiple chunks are needed to answer fully, combine them.
5. If the context is insufficient, say: "I could not find the answer to this question in the provided context."
6. Return only valid JSON.

Output Format (JSON only):
{
  "answer": "Your natural language response here...",
  "used_source_ids": ["doc_0", "doc_1"]
}
"""

RAG_SHORTLIST_PROMPT = """
You are the MEMUX shortlist agent.
You will be given:
- a user question
- one candidate semantic summary for one source hit

Decide whether this candidate is worth sending to the extraction stage.

Output JSON:
{
  "keep": true,
  "reason": "short reason grounded in overlap with the user need",
  "match_strength": "high|medium|low"
}

Rules:
1. Keep only if the candidate is plausibly relevant to answering the question.
2. Be strict. Near-topic but non-answering candidates should be rejected.
3. Ignore source ids as evidence; use only the candidate content.
4. Return valid JSON only.
"""

RAG_ACCUMULATOR_PROMPT = """
You are the MEMUX accumulator agent.
You will be given:
- the user question
- the current notebook
- one shortlisted candidate summary
- the raw source evidence for that candidate

Extract only the information from this candidate that is directly useful for answering the question.

Output JSON:
{
  "relevant": true,
  "note": "concise but detailed extracted facts useful for the final answer",
  "reason": "why this evidence matters"
}

Rules:
1. Use the raw source evidence as primary evidence.
2. Extract facts, names, numbers, code, and exact relationships useful to the question.
3. Do not repeat notebook content unless this candidate adds something materially new.
4. If the candidate is not actually useful, set relevant=false and note="".
5. Return valid JSON only.
"""

RAG_QUERY_DECOMPOSITION_PROMPT = """
You are the MEMUX retrieval query planner.
You will be given:
- the user question
- recent conversation for interpretation

Your job is to produce 3 to 5 short search strings that are easy to search in a vector store.

Output JSON:
{
  "search_terms": ["term 1", "term 2", "term 3"],
  "reason": "short note"
}

Rules:
1. Each search term should be a compact keyword phrase, not a full sentence.
2. Prefer exact entities, names, titles, IDs, code identifiers, or noun phrases.
3. Keep terms distinct and non-redundant.
4. Include the original exact phrase if the user already asked in compact form.
5. Maximum 5 terms.
6. Return valid JSON only.
"""

RAG_MAX_REQUEST_TOKENS = 6200
RAG_MAX_CONTEXT_TOKENS = 4200
RAG_MAX_HISTORY_TOKENS = 700
RAG_MAX_OUTPUT_TOKENS = 700


def _estimate_tokens(value: Any) -> int:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return max(1, math.ceil(len(text) / 4))


def _compact_text_block(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _trim_to_token_budget(text: str, token_budget: int) -> str:
    compact = str(text or "").strip()
    if not compact or token_budget <= 0:
        return ""
    approx_chars = max(60, token_budget * 4)
    if len(compact) <= approx_chars:
        return compact
    return compact[: approx_chars - 1].rstrip() + "…"


def _is_code_like_query(query: str) -> bool:
    q = str(query or "")
    if not q.strip():
        return False
    return bool(re.search(r"[`{}()[\];=<>]|::|=>|function\b|class\b|def\b|import\b|const\b|let\b|var\b|code\b|snippet\b|syntax\b", q, re.I))


def _pack_conversation_history(conversation: Optional[list], token_budget: int) -> List[Dict[str, str]]:
    packed: List[Dict[str, str]] = []
    consumed = 0
    for msg in reversed(conversation or []):
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role", "")).strip()
        content = _compact_text_block(msg.get("content", ""))
        if role not in {"user", "assistant"} or not content:
            continue
        trimmed = _trim_to_token_budget(content, min(220, token_budget - consumed))
        if not trimmed:
            continue
        cost = _estimate_tokens(trimmed) + 6
        if consumed + cost > token_budget:
            continue
        packed.append({"role": role, "content": trimmed})
        consumed += cost
        if consumed >= token_budget:
            break
    packed.reverse()
    return packed


def _pack_context_chunks(user_query: str, context_chunks: list, token_budget: int) -> List[Dict[str, Any]]:
    ranked = sorted(
        [chunk for chunk in context_chunks if isinstance(chunk, dict)],
        key=lambda chunk: float(chunk.get("similarity_score") or 0),
        reverse=True
    )
    code_query = _is_code_like_query(user_query)
    packed: List[Dict[str, Any]] = []
    consumed = 0

    for idx, chunk in enumerate(ranked):
        source_id = str(chunk.get("_source_id") or f"doc_{idx}")
        summary_budget = 90 if idx < 3 else 55
        raw_budget = 220 if idx == 0 else (180 if idx < 3 else 110)
        full_budget = 320 if idx == 0 else (220 if idx < 2 else (120 if idx < 4 else 0))
        structured_budget = 110 if idx < 2 else 60

        if code_query:
            raw_budget += 120
            full_budget += 140
            summary_budget = max(45, summary_budget - 20)

        text_summary = _trim_to_token_budget(_compact_text_block(chunk.get("text_summary", "")), summary_budget)
        raw_text = _trim_to_token_budget(str(chunk.get("raw_text", "")).strip(), raw_budget)
        full_content = _trim_to_token_budget(str(chunk.get("full_content", "")).strip(), full_budget)
        structured = chunk.get("data")
        structured_text = ""
        if structured:
            try:
                structured_text = _trim_to_token_budget(json.dumps(structured, ensure_ascii=False, separators=(",", ":")), structured_budget)
            except Exception:
                structured_text = _trim_to_token_budget(str(structured), structured_budget)

        packed_chunk = {
            "source_id": source_id,
            "filename": chunk.get("filename"),
            "location": chunk.get("table_name"),
            "page_number": chunk.get("page_number"),
            "source_type": chunk.get("source_type"),
            "segment_type": chunk.get("segment_type"),
            "summary": text_summary,
            "raw_evidence": raw_text,
            "expanded_context": full_content,
            "structured_data": structured_text,
            "citation_payload": chunk.get("citation_payload"),
            "similarity_score": chunk.get("similarity_score"),
        }

        cost = _estimate_tokens(packed_chunk)
        if packed and consumed + cost > token_budget:
            continue
        if not packed and cost > token_budget:
            # Force at least one chunk with aggressive trimming.
            packed_chunk["summary"] = _trim_to_token_budget(text_summary, 50)
            packed_chunk["raw_evidence"] = _trim_to_token_budget(raw_text or full_content or text_summary, 140)
            packed_chunk["expanded_context"] = _trim_to_token_budget(full_content, 80)
            packed_chunk["structured_data"] = _trim_to_token_budget(structured_text, 40)
            cost = _estimate_tokens(packed_chunk)
            if cost > token_budget:
                packed_chunk["expanded_context"] = ""
                packed_chunk["structured_data"] = ""
                cost = _estimate_tokens(packed_chunk)

        if consumed + cost > token_budget:
            break

        packed.append(packed_chunk)
        consumed += cost
        if consumed >= token_budget:
            break

    return packed


def _call_rag_llm(messages: List[Dict[str, str]]) -> str:
    completion = get_next_client().chat.completions.create(
        model="openai/gpt-oss-120b",
        messages=messages,
        temperature=0.1,
        max_completion_tokens=RAG_MAX_OUTPUT_TOKENS,
    )
    choice = completion.choices[0]
    content = (choice.message.content or "").strip()
    if content:
        return content
    metadata = {
        "finish_reason": getattr(choice, "finish_reason", None),
        "refusal": getattr(choice.message, "refusal", None),
    }
    return json.dumps({"answer": "", "used_source_ids": [], "_empty_completion_meta": metadata}, ensure_ascii=False)


def _extract_json_object(text: str) -> Optional[Dict[str, Any]]:
    content = str(text or "").strip()
    if not content:
        return None
    try:
        parsed = json.loads(content)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        pass

    start = content.find("{")
    end = content.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    candidate = content[start:end + 1]
    try:
        parsed = json.loads(candidate)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def _call_json_agent(system_prompt: str, payload: Dict[str, Any], max_output_tokens: int = 280) -> Tuple[Optional[Dict[str, Any]], str]:
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}
    ]

    completion = get_next_client().chat.completions.create(
        model="openai/gpt-oss-120b",
        messages=messages,
        temperature=0,
        max_completion_tokens=max_output_tokens,
    )
    choice = completion.choices[0]
    content = (choice.message.content or "").strip()
    if not content:
        content = json.dumps({
            "_empty_completion_meta": {
                "finish_reason": getattr(choice, "finish_reason", None),
                "refusal": getattr(choice.message, "refusal", None),
            }
        }, ensure_ascii=False)
    parsed = _extract_json_object(content)
    return parsed, content


def _build_fallback_notebook_entry(candidate: Dict[str, Any], max_chars: int = 900) -> Optional[Dict[str, Any]]:
    if not isinstance(candidate, dict):
        return None
    source_id = str(candidate.get("source_id", "")).strip()
    if not source_id:
        return None

    note_parts = []
    raw_evidence = _compact_text_block(candidate.get("raw_evidence", ""))
    expanded_context = _compact_text_block(candidate.get("expanded_context", ""))
    summary = _compact_text_block(candidate.get("summary", ""))
    location = _compact_text_block(candidate.get("location", ""))

    if location:
        note_parts.append(f"Location: {location}")
    if raw_evidence:
        note_parts.append(f"Evidence: {raw_evidence}")
    elif expanded_context:
        note_parts.append(f"Evidence: {expanded_context}")
    elif summary:
        note_parts.append(f"Evidence: {summary}")
    else:
        return None

    note = "\n".join(note_parts).strip()
    if len(note) > max_chars:
        note = note[: max_chars - 1].rstrip() + "…"

    return {
        "source_id": source_id,
        "filename": candidate.get("filename"),
        "location": candidate.get("location"),
        "note": note,
        "reason": "fallback_from_retrieved_candidate"
    }


def _semantic_terms(text: str) -> List[str]:
    stop_words = {
        "the", "and", "for", "with", "this", "that", "from", "into", "your", "have", "has",
        "what", "when", "where", "which", "who", "why", "how", "are", "was", "were", "been",
        "all", "any", "about", "does", "did", "can", "could", "would", "should", "code"
    }
    tokens = re.findall(r"[a-zA-Z0-9_/-]+", str(text or "").lower())
    return [token for token in tokens if len(token) > 2 and token not in stop_words]


def _build_shortlist_fallback(user_query: str, candidate: Dict[str, Any]) -> Dict[str, Any]:
    summary = _compact_text_block(candidate.get("summary", ""))
    location = _compact_text_block(candidate.get("location", ""))
    filename = _compact_text_block(candidate.get("filename", ""))
    segment_type = _compact_text_block(candidate.get("segment_type", ""))
    haystack = " ".join([summary, location, filename]).lower()

    query_terms = _semantic_terms(user_query)
    overlap_terms = [term for term in query_terms if term in haystack]
    overlap_count = len(set(overlap_terms))

    continuation_hint = any(token in haystack for token in ["continued", "additional", "remaining", "rest"])
    list_hint = any(token in haystack for token in ["members", "jury", "panel", "list", "contest director"])
    exact_entity_hint = any(phrase in haystack for phrase in [
        "midnight code cup",
        "jury members",
        "jury list",
    ])

    keep = (
        overlap_count >= 2
        or exact_entity_hint
        or (continuation_hint and list_hint)
        or (segment_type == "section_summary" and overlap_count >= 1 and list_hint)
    )

    if keep:
        reason = "fallback heuristic kept candidate due to keyword overlap and continuation/entity signals"
        strength = "high" if (exact_entity_hint or overlap_count >= 3) else "medium"
    else:
        reason = "fallback heuristic rejected candidate due to weak overlap with requested entities/topics"
        strength = "low"

    return {
        "keep": keep,
        "reason": reason,
        "match_strength": strength,
        "fallback_used": True,
        "overlap_terms": sorted(set(overlap_terms)),
    }


def _is_valid_shortlist_decision(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("keep"), bool)
        and bool(str(value.get("reason", "")).strip())
    )


def _is_valid_accumulator_decision(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("relevant"), bool)
        and ("note" in value or "reason" in value)
    )


def _build_shortlisted_accumulator_fallback(candidate: Dict[str, Any], max_chars: int = 900) -> Optional[Dict[str, Any]]:
    entry = _build_fallback_notebook_entry(candidate, max_chars=max_chars)
    if not entry:
        return None
    return {
        "relevant": True,
        "note": entry["note"],
        "reason": "fallback_from_shortlisted_candidate_after_json_failure"
    }


def _fallback_query_terms(user_query: str, max_terms: int = 5) -> List[str]:
    query = _compact_text_block(user_query)
    if not query:
        return []

    quoted = [
        term.strip()
        for groups in re.findall(r'"([^"]+)"|\'([^\']+)\'', query)
        for term in groups
        if term and term.strip()
    ]
    candidates: List[str] = []
    if quoted:
        candidates.extend(quoted)

    cleaned = re.sub(r"[^\w\s:/.-]", " ", query)
    compact = re.sub(r"\s+", " ", cleaned).strip()
    if compact:
        candidates.append(compact)

    words = [word for word in compact.split(" ") if len(word) > 2]
    for size in (4, 3, 2):
        for start in range(0, max(0, len(words) - size + 1)):
            phrase = " ".join(words[start:start + size]).strip()
            if phrase:
                candidates.append(phrase)

    deduped: List[str] = []
    seen = set()
    for candidate in candidates:
        normalized = candidate.lower().strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(candidate)
        if len(deduped) >= max_terms:
            break
    return deduped[:max_terms] or [query]


def generate_rag_query_terms(user_query: str, conversation: Optional[list] = None) -> dict:
    payload = {
        "user_question": user_query,
        "conversation": _pack_conversation_history(conversation, 260),
    }
    parsed = None
    raw_response = ""
    try:
        parsed, raw_response = _call_json_agent(RAG_QUERY_DECOMPOSITION_PROMPT, payload, max_output_tokens=180)
    except APIStatusError as e:
        raw_response = str(e)

    terms: List[str] = []
    if isinstance(parsed, dict):
        raw_terms = parsed.get("search_terms")
        if isinstance(raw_terms, list):
            for term in raw_terms:
                value = _compact_text_block(term)
                if value:
                    terms.append(value)

    deduped_terms: List[str] = []
    seen = set()
    for term in terms:
        normalized = term.lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        deduped_terms.append(term)
        if len(deduped_terms) >= 5:
            break

    if not deduped_terms:
        deduped_terms = _fallback_query_terms(user_query, max_terms=5)

    return {
        "search_terms": deduped_terms[:5],
        "debug_info": {
            "payload": payload,
            "raw_response": raw_response,
            "parsed": parsed,
            "used_fallback": not bool(terms),
        }
    }


RAG_SHORTLIST_PROMPT = """You are a strict relevance filter for a Retrieval-Augmented Generation (RAG) system.
Your goal is to evaluate a list of retrieved candidate text chunks and determine if they contain information relevant to answering the user's query.
The candidates are provided in the format: {"id": "chunk_id", "text_summary": "(Bookmark Title: Chunk Summary)"}.

Input schema:
{
  "user_query": "The user's question",
  "candidates": [
    {"id": "...", "text_summary": "..."}
  ]
}

Output JSON schema:
{
  "evaluations": [
    {
      "id": "chunk_id",
      "to_keep": true // or false
    }
  ]
}

Rules:
1. "to_keep": true means the chunk likely contains at least partial information needed to answer the query.
2. "to_keep": false means it is completely irrelevant and should be dropped to save tokens and avoid hallucinations.
3. If unsure, lean towards true to preserve potentially useful context.
4. You MUST evaluate exactly every candidate provided in the input array.
5. Return ONLY a valid JSON object matching the Output JSON schema.
"""

def evaluate_shortlist(user_query: str, candidates: List[Dict[str, Any]]) -> Dict[str, Any]:
    payload = {
        "user_query": user_query,
        "candidates": candidates
    }
    
    messages = [
        {"role": "system", "content": RAG_SHORTLIST_PROMPT},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}
    ]
    
    debug_info = {
        "prompt": messages,
        "raw_response": ""
    }
    
    try:
        parsed, raw_response = _call_json_llm(messages, temperature=0.0)
        debug_info["raw_response"] = raw_response
        
        if not parsed or not isinstance(parsed, dict):
            raise ValueError("Invalid JSON response from LLM")
            
        evaluations = parsed.get("evaluations", [])
        if not isinstance(evaluations, list):
            evaluations = []
            
        return {
            "evaluations": evaluations,
            "debug_info": debug_info
        }
    except Exception as e:
        debug_info["error"] = str(e)
        # Fallback: maintain all if failed.
        fallback_evals = [{"id": c.get("id"), "to_keep": True} for c in candidates]
        return {
            "evaluations": fallback_evals,
            "debug_info": debug_info
        }


def generate_rag_response(user_query: str, context_chunks: list, conversation: Optional[list] = None) -> dict:
    chunk_mapping = {}
    normalized_context_chunks = []
    for idx, chunk in enumerate(context_chunks):
        source_id = f"doc_{idx}"
        chunk_mapping[source_id] = chunk.get("id")
        if isinstance(chunk, dict):
            normalized = dict(chunk)
            normalized["_source_id"] = source_id
            normalized_context_chunks.append(normalized)

    history = _pack_conversation_history(conversation, RAG_MAX_HISTORY_TOKENS)
    packed_chunks = _pack_context_chunks(user_query, normalized_context_chunks, RAG_MAX_CONTEXT_TOKENS)

    if not packed_chunks:
        return {
            "response": "I could not find the answer to this question in the provided context.",
            "used_chunk_ids": []
        }

    debug_info = {
        "rag_mode": "simple_direct_context",
        "token_budget": {
            "request_max": RAG_MAX_REQUEST_TOKENS,
            "context_max": RAG_MAX_CONTEXT_TOKENS,
            "history_max": RAG_MAX_HISTORY_TOKENS,
            "output_max": RAG_MAX_OUTPUT_TOKENS,
        },
        "query": user_query,
        "packed_history": history,
        "packed_context_chunks": packed_chunks,
        "packed_context_chunk_ids": [chunk.get("source_id") for chunk in packed_chunks],
        "estimated_tokens": {
            "history": _estimate_tokens(history),
            "context": _estimate_tokens(packed_chunks),
            "shortlist_payload_total": _estimate_tokens({
                "user_question": user_query,
                "candidates": packed_chunks[:10],
            }),
            "system_prompt": _estimate_tokens(RAG_CHAT_PROMPT),
            "total_request_estimate": _estimate_tokens({
                "history": history,
                "packed_context_chunks": packed_chunks,
                "user_question": user_query,
            }),
        },
        "messages": [],
        "retry_applied": False,
        "packed_context_count": len(packed_chunks),
    }

    final_payload = {
        "conversation": history,
        "user_question": user_query,
        "context_chunks": packed_chunks,
    }
    messages = [
        {"role": "system", "content": RAG_CHAT_PROMPT + "\n\nCRITICAL: Return valid JSON only."},
        {"role": "user", "content": json.dumps(final_payload, ensure_ascii=False, indent=2)}
    ]
    debug_info["messages"] = messages

    try:
        content = _call_rag_llm(messages)
    except APIStatusError as e:
        message = str(e)
        if "Request too large" not in message and "rate_limit_exceeded" not in message:
            raise
        debug_info["retry_applied"] = True
        debug_info["retry_reason"] = message
        smaller_context_chunks = packed_chunks[: max(2, min(5, len(packed_chunks)))]
        retry_payload = {
            "conversation": history[-2:],
            "user_question": user_query,
            "context_chunks": smaller_context_chunks
        }
        retry_messages = [
            {"role": "system", "content": RAG_CHAT_PROMPT + "\n\nCRITICAL: Return valid JSON only."},
            {"role": "user", "content": json.dumps(retry_payload, ensure_ascii=False, indent=2)}
        ]
        debug_info["retry_payload"] = retry_payload
        debug_info["retry_messages"] = retry_messages
        debug_info["retry_estimated_tokens"] = {
            "payload": _estimate_tokens(retry_payload),
            "total_request_estimate": _estimate_tokens(retry_messages),
        }
        content = _call_rag_llm(retry_messages)

    try:
        data = _extract_json_object(content)
        if not isinstance(data, dict):
            raise ValueError("No valid JSON object found in final response")
        
        # Map source_ids back to original UUIDs for the frontend
        used_source_ids = data.get("used_source_ids", [])
        original_chunk_ids = []
        for sid in used_source_ids:
            if sid in chunk_mapping:
                original_chunk_ids.append(chunk_mapping[sid])
                
        return {
            "response": data.get("answer", "I encountered an error formatting my response."),
            "used_chunk_ids": original_chunk_ids,
            "debug_info": {
                **debug_info,
                "raw_response": content,
                "used_source_ids": used_source_ids,
                "used_chunk_ids": original_chunk_ids
            }
        }
    except Exception as e:
        print(f"Error parsing RAG response: {e}")
        return {
            "response": "Sorry, I had trouble generating a structured response based on the documents.",
            "used_chunk_ids": [],
            "debug_info": {
                **debug_info,
                "raw_response": content,
                "parse_error": str(e)
            }
        }


BOOKMARK_MAP_OCR_TO_HTML_PROMPT = """You are a visual document chunker. You are shown a screenshot of a webpage and some metadata.
Your task is to segment visible content into logical chunks and produce structured JSON.

You will receive:
- The screenshot image itself (which you can see)
- A JSON context with hierarchy_fragments (parsed HTML elements for mapping), screenshot_index, and previous_context

Output JSON schema:
{
  "screenshot_heading": "Main heading for this screenshot (or inherited if entire screenshot is a continuation)",
  "screenshot_summary": "1-2 sentence summary of this screenshot",
  "chunks": [
    {
      "heading": "Chunk heading. If it's a continuation of a previous page chunk, use the EXACT SAME heading from previous_context.previous_tail_chunks — DO NOT invent new headings.",
      "text": "Exact visible text from the screenshot for this chunk",
      "summary": "1-sentence summary",
      "context_prefix": ["Topic", "Subtopic"],
      "layout_hint": "full",
      "continued_from_previous": false,
      "inherited_heading": "The exact heading inherited from previous_context if this chunk is a continuation",
      "mapped_html_fragment_id": "fragment_id from hierarchy_fragments if matched, else null"
    }
  ]
}

Rules:
1. Read the image carefully. Extract all visible text faithfully — do not paraphrase or drop content.
2. 'mapped_html_fragment_id': Match each chunk to a hierarchy_fragment by its text. If matched, set its fragment_id. Otherwise null.
3. Keep chunks logical (1 list, 1 table, or 1-3 paragraphs per chunk).
4. Do not hallucinate data. Only use text you actually see in the image.
5. CONTINUATION IS CRITICAL: Check previous_context.previous_tail_chunks. If the current screenshot begins with content that appears to CONTINUE a list or paragraph from the previous page (e.g., numbered items continuing from a previous list), you MUST set continued_from_previous=true on those chunks.
6. INHERITING HEADINGS: When a chunk is a continuation, you MUST copy the EXACT SAME heading from previous_context into both 'heading' and 'inherited_heading'. Do NOT invent a new heading (like 'Participant List' for a continued jury list). Keep context_prefix identical to stitch them together semantically.
7. Return only the JSON object, no preamble.
8. NEVER produce a chunk that is a meta-observation about the image itself (e.g. "Note: There are no tables in this image", "This screenshot contains...", "The image shows..."). Only produce chunks that contain actual textual content extracted directly from the screenshot. If there is nothing in a region to extract, simply omit that chunk.
"""


def fuse_screenshot_with_hierarchy(
    ocr_text: str,
    hierarchy_fragments: List[Dict[str, Any]],
    screenshot_index: int,
    previous_context: Dict[str, Any],
    base64_image: Optional[str] = None,
    image_mime_type: str = "image/png"
) -> Dict[str, Any]:

    context_payload = {
        "hierarchy_fragments": hierarchy_fragments,
        "screenshot_index": screenshot_index,
        "previous_context": previous_context
    }

    debug_info: Dict[str, Any] = {"mode": "vision" if base64_image else "text", "raw_response": ""}

    if base64_image:
        # Vision path: pass the image directly along with the context JSON
        context_json = json.dumps(context_payload, ensure_ascii=False)
        user_content = [
            {
                "type": "image_url",
                "image_url": {"url": f"data:{image_mime_type};base64,{base64_image}"}
            },
            {
                "type": "text",
                "text": f"Context JSON (for mapping and continuation):\n{context_json}\n\nReturn only valid JSON matching the output schema."
            }
        ]
        messages = [
            {"role": "system", "content": BOOKMARK_MAP_OCR_TO_HTML_PROMPT},
            {"role": "user", "content": user_content}
        ]
        debug_info["prompt"] = BOOKMARK_MAP_OCR_TO_HTML_PROMPT

        try:
            completion = get_next_client().chat.completions.create(
                model="meta-llama/llama-4-scout-17b-16e-instruct",
                messages=messages,
                temperature=0.1,
                max_completion_tokens=2000,
            )
            raw_response = (completion.choices[0].message.content or "").strip()
            debug_info["raw_response"] = raw_response
            parsed = _extract_json_object(raw_response)
        except Exception as e:
            debug_info["error"] = str(e)
            parsed = None
    else:
        # Text fallback: use OCR text only
        text_payload = {
            "ocr_text": ocr_text,
            **context_payload
        }
        messages = [
            {"role": "system", "content": BOOKMARK_MAP_OCR_TO_HTML_PROMPT},
            {"role": "user", "content": json.dumps(text_payload, ensure_ascii=False)}
        ]
        debug_info["prompt"] = messages
        parsed, raw_response = _call_json_llm(messages, temperature=0.1)
        debug_info["raw_response"] = raw_response

    try:
        if not parsed or not isinstance(parsed, dict):
            raise ValueError("Invalid JSON response from LLM")

        chunks = parsed.get("chunks", [])
        if not isinstance(chunks, list):
            chunks = []

        for chunk in chunks:
            if not isinstance(chunk.get("context_prefix"), list):
                chunk["context_prefix"] = []

        return {
            "screenshot_index": screenshot_index,
            "screenshot_heading": str(parsed.get("screenshot_heading", f"Screenshot {screenshot_index + 1}")),
            "screenshot_summary": str(parsed.get("screenshot_summary", "Screenshot summary")),
            "chunks": chunks,
            "debug_info": debug_info
        }
    except Exception as e:
        debug_info["error"] = str(e)
        return {
            "screenshot_index": screenshot_index,
            "screenshot_heading": f"Screenshot {screenshot_index + 1} (Fallback)",
            "screenshot_summary": "Failed to parse screenshot correctly.",
            "chunks": [],
            "debug_info": debug_info
        }
