from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Any, Dict, List, Optional
import os
import requests
from fastapi import Response
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
import uuid

load_dotenv()

app = FastAPI(title="Maxcavator Backend")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # TODO: restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Maxcavator Backend Running"}

from models import ExtractionRequest, ExtractionResponse, SqlQueryRequest, SqlQueryResponse, PdfSummaryRequest, PdfSummaryResponse, EmbedRequest, EmbedResponse, RagRequest, RagResponse, RagQueryTermsRequest, RagQueryTermsResponse, BookmarkRestructureChunkRequest, BookmarkRestructureChunkResponse, ShortlistRequest, ShortlistResponse
from extraction import (
    extract_tables_from_text,
    generate_sql_query,
    extract_pdf_summary,
    smart_chunk_screen_snip,
    process_dev_bookmark_fragments,
    process_bookmark_screenshot_sequence,
    generate_rag_query_terms,
    evaluate_shortlist
)
from vision_ocr import extract_text_from_image, infer_bookmark_title
from embeddings import generate_embeddings
from bookmark_capture import capture_bookmark, process_bookmark_structured
from agent_orchestrator import run_multi_agent_stream

RUN_STATE_STORE: Dict[str, Dict[str, Any]] = {}

@app.post("/extract", response_model=ExtractionResponse)
def extract_tables(request: ExtractionRequest):
    tables, debug_info = extract_tables_from_text(request.text, request.previous_tables)
    return ExtractionResponse(tables=tables, debug_info=debug_info)

@app.post("/pdf_summary", response_model=PdfSummaryResponse)
def pdf_summary(request: PdfSummaryRequest):
    result = extract_pdf_summary(request.page_texts)
    return PdfSummaryResponse(title=result["title"], summary=result["summary"])

@app.post("/embed", response_model=EmbedResponse)
def embed_texts(request: EmbedRequest):
    vectors = generate_embeddings(request.texts)
    return EmbedResponse(embeddings=vectors)

class VisionOcrRequest(BaseModel):
    image: str  # base64-encoded image

class VisionOcrResponse(BaseModel):
    text: str
    debug_info: dict

@app.post("/vision_ocr", response_model=VisionOcrResponse)
def vision_ocr(request: VisionOcrRequest):
    result = extract_text_from_image(request.image)
    return VisionOcrResponse(text=result["text"], debug_info=result["debug_info"])


class BookmarkInferTitleRequest(BaseModel):
    image_base64: str
    raw_title: str = ""

class BookmarkInferTitleResponse(BaseModel):
    title: str

@app.post("/bookmark/infer_title", response_model=BookmarkInferTitleResponse)
def bookmark_infer_title(request: BookmarkInferTitleRequest):
    title = infer_bookmark_title(request.image_base64, request.raw_title)
    return BookmarkInferTitleResponse(title=title)

class BookmarkCaptureRequest(BaseModel):
    url: str
    capture_mode: str = "dual"


class BookmarkScreenshot(BaseModel):
    image_base64: str
    mime_type: str = "image/png"


class BookmarkCaptureResponse(BaseModel):
    title: str
    original_url: str
    canonical_url: str
    text_blocks: List[str]
    screenshots: Optional[List[BookmarkScreenshot]] = None
    screenshots_base64: List[str]
    metadata: Dict[str, Any]
    html: Optional[str] = None
    structured_blocks: Optional[List[Dict[str, Any]]] = None


class BookmarkStructuredParagraph(BaseModel):
    paragraph_id: str
    text: str
    summary: str
    order: int
    dom_path: Optional[str] = None
    tag_name: Optional[str] = None
    channel: str
    screenshot_index: Optional[int] = None


class BookmarkStructuredSection(BaseModel):
    section_id: str
    heading: str
    order: int
    summary: str
    channel: Optional[str] = None
    paragraphs: List[BookmarkStructuredParagraph]


class BookmarkProcessStructuredResponse(BaseModel):
    title: str
    original_url: str
    canonical_url: str
    bookmark_summary: str
    sections: List[BookmarkStructuredSection]
    screenshots: List[BookmarkScreenshot]
    metadata: Dict[str, Any]


class ContextChunkRequest(BaseModel):
    source_type: str
    raw_text_blocks: List[str]
    metadata: Optional[Dict[str, Any]] = None


class ContextChunkResponse(BaseModel):
    chunks: List[str]

class SnipSmartChunkRequest(BaseModel):
    ocr_text: str

class SnipSmartChunkItem(BaseModel):
    heading: str
    text: str
    summary: str

class SnipSmartChunkResponse(BaseModel):
    chunks: List[SnipSmartChunkItem]
    screenshot_summary: Optional[str] = None
    debug_info: Optional[Dict[str, Any]] = None


class BookmarkScreenshotSequenceInput(BaseModel):
    screenshot_index: int
    ocr_text: str
    asset_id: Optional[str] = None


class BookmarkScreenshotSequenceChunk(BaseModel):
    heading: str
    text: str
    summary: str
    context_prefix: List[str] = []
    layout_hint: Optional[str] = None
    continued_from_previous: bool = False
    mapped_html_fragment_id: Optional[str] = None


class BookmarkFuseScreenshotRequest(BaseModel):
    ocr_text: str
    hierarchy_fragments: List[Dict[str, Any]]
    screenshot_index: int
    previous_context: Optional[Dict[str, Any]] = None
    base64_image: Optional[str] = None


class BookmarkFuseScreenshotResponse(BaseModel):
    screenshot_index: int
    screenshot_heading: str
    screenshot_summary: str
    chunks: List[BookmarkScreenshotSequenceChunk]
    debug_info: Dict[str, Any]


class BookmarkScreenshotSequenceResult(BaseModel):
    screenshot_index: int
    screenshot_heading: str
    screenshot_summary: str
    continued_from_previous: bool = False
    inherited_heading: Optional[str] = None
    context_prefix: List[str] = []
    chunks: List[BookmarkScreenshotSequenceChunk]


class BookmarkScreenshotSequenceRequest(BaseModel):
    source_title: Optional[str] = None
    bookmark_summary_context: Optional[str] = None
    screenshots: List[BookmarkScreenshotSequenceInput]
    initial_context: Optional[Dict[str, Any]] = None


class BookmarkScreenshotSequenceResponse(BaseModel):
    screenshots: List[BookmarkScreenshotSequenceResult]
    debug_info: Dict[str, Any]


class DevBookmarkFragmentRequest(BaseModel):
    source_title: Optional[str] = None
    raw_text: str
    hierarchy_text: Optional[str] = None
    max_window_chars: int = 12000
    overlap_chars: int = 1200


class DevBookmarkFragmentResponse(BaseModel):
    source_title: str
    fragments: List[Dict[str, Any]]
    debug_info: Dict[str, Any]


class AgentChatRequest(BaseModel):
    user_query: str
    context_chunks: List[Dict[str, Any]]
    conversation: Optional[List[Dict[str, str]]] = None
    run_id: Optional[str] = None


class AgentRunControlResponse(BaseModel):
    run_id: str
    status: str
    phase: str


def chunk_text_blocks(text_blocks: List[str], chunk_size: int = 900, overlap: int = 150) -> List[str]:
    combined = "\n\n".join([b.strip() for b in text_blocks if b and b.strip()])
    if not combined:
        return []

    chunks: List[str] = []
    cursor = 0
    length = len(combined)

    while cursor < length:
        end = min(length, cursor + chunk_size)
        chunk = combined[cursor:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= length:
            break
        cursor = max(0, end - overlap)

    return chunks


@app.post("/bookmark/capture", response_model=BookmarkCaptureResponse)
def bookmark_capture(request: BookmarkCaptureRequest):
    result = capture_bookmark(request.url, request.capture_mode or "dual")
    return BookmarkCaptureResponse(**result)


@app.post("/bookmark/process_structured", response_model=BookmarkProcessStructuredResponse)
def bookmark_process_structured(request: BookmarkCaptureRequest):
    result = process_bookmark_structured(request.url, request.capture_mode or "dual")
    return BookmarkProcessStructuredResponse(**result)


@app.post("/context/chunk", response_model=ContextChunkResponse)
def context_chunk(request: ContextChunkRequest):
    chunks = chunk_text_blocks(request.raw_text_blocks)
    return ContextChunkResponse(chunks=chunks)

@app.post("/snip/smart_chunk", response_model=SnipSmartChunkResponse)
def snip_smart_chunk(request: SnipSmartChunkRequest):
    chunks, screenshot_summary, debug_info = smart_chunk_screen_snip(request.ocr_text)
    return SnipSmartChunkResponse(chunks=chunks, screenshot_summary=screenshot_summary, debug_info=debug_info)


@app.post("/bookmark/screenshot_sequence_chunk", response_model=BookmarkScreenshotSequenceResponse)
def bookmark_screenshot_sequence_chunk(request: BookmarkScreenshotSequenceRequest):
    result = process_bookmark_screenshot_sequence(
        screenshots=[item.model_dump() for item in request.screenshots],
        source_title=request.source_title or "",
        bookmark_summary_context=request.bookmark_summary_context or "",
        initial_context=request.initial_context or {}
    )
    return BookmarkScreenshotSequenceResponse(**result)


from extraction import fuse_screenshot_with_hierarchy

@app.post("/bookmark/fuse_screenshot", response_model=BookmarkFuseScreenshotResponse)
def bookmark_fuse_screenshot(request: BookmarkFuseScreenshotRequest):
    result = fuse_screenshot_with_hierarchy(
        ocr_text=request.ocr_text,
        hierarchy_fragments=request.hierarchy_fragments,
        screenshot_index=request.screenshot_index,
        previous_context=request.previous_context or {},
        base64_image=request.base64_image
    )
    return BookmarkFuseScreenshotResponse(**result)

@app.post("/dev/bookmark_fragments", response_model=DevBookmarkFragmentResponse)
def dev_bookmark_fragments(request: DevBookmarkFragmentRequest):
    result = process_dev_bookmark_fragments(
        source_title=request.source_title or "",
        raw_text=request.raw_text or "",
        hierarchy_text=request.hierarchy_text or "",
        max_window_chars=request.max_window_chars,
        overlap_chars=request.overlap_chars
    )
    return DevBookmarkFragmentResponse(**result)

@app.post("/query", response_model=SqlQueryResponse)
def query_sql(request: SqlQueryRequest):
    sql = generate_sql_query(request.user_query, request.table_schema)
    return SqlQueryResponse(sql=sql)

from extraction import generate_rag_response

@app.post("/rag/query_terms", response_model=RagQueryTermsResponse)
def rag_query_terms(request: RagQueryTermsRequest):
    result = generate_rag_query_terms(request.user_query, request.conversation or [])
    return RagQueryTermsResponse(
        search_terms=result.get("search_terms", []),
        debug_info=result.get("debug_info")
    )

@app.post("/rag/shortlist", response_model=ShortlistResponse)
def rag_shortlist(request: ShortlistRequest):
    candidates_list = [c.model_dump() for c in request.candidates]
    result = evaluate_shortlist(request.user_query, candidates_list)
    return ShortlistResponse(
        evaluations=result.get("evaluations", []),
        debug_info=result.get("debug_info")
    )


@app.post("/rag_chat", response_model=RagResponse)
def rag_chat(request: RagRequest):
    result = generate_rag_response(request.user_query, request.context_chunks, request.conversation or [])
    return RagResponse(
        response=result.get("response", ""), 
        used_chunk_ids=result.get("used_chunk_ids", []),
        debug_info=result.get("debug_info")
    )


@app.post("/agent_chat/stream")
def agent_chat_stream(request: AgentChatRequest):
    run_id = request.run_id or str(uuid.uuid4())
    stream = run_multi_agent_stream(
        run_id=run_id,
        user_query=request.user_query,
        context_chunks=request.context_chunks,
        conversation=request.conversation or [],
        run_state_store=RUN_STATE_STORE,
    )
    return StreamingResponse(stream, media_type="text/event-stream")


def _update_run_status(run_id: str, status: str) -> Dict[str, Any]:
    run = RUN_STATE_STORE.get(run_id)
    if not run:
        run = {"run_id": run_id, "status": "running", "phase": "planning"}
        RUN_STATE_STORE[run_id] = run
    run["status"] = status
    return run


@app.post("/agent_chat/run/{run_id}/pause", response_model=AgentRunControlResponse)
def agent_chat_pause(run_id: str):
    run = _update_run_status(run_id, "paused")
    return AgentRunControlResponse(run_id=run_id, status=run["status"], phase=run.get("phase", "unknown"))


@app.post("/agent_chat/run/{run_id}/resume", response_model=AgentRunControlResponse)
def agent_chat_resume(run_id: str):
    run = _update_run_status(run_id, "running")
    return AgentRunControlResponse(run_id=run_id, status=run["status"], phase=run.get("phase", "unknown"))


@app.post("/agent_chat/run/{run_id}/stop", response_model=AgentRunControlResponse)
def agent_chat_stop(run_id: str):
    run = _update_run_status(run_id, "stopped")
    return AgentRunControlResponse(run_id=run_id, status=run["status"], phase=run.get("phase", "unknown"))

@app.get("/proxy_pdf")
def proxy_pdf(url: str):
    try:
        # Simple proxy to bypass CORS
        resp = requests.get(url, stream=True)
        return Response(
            content=resp.content, 
            media_type="application/pdf", 
            headers={"Content-Disposition": "inline"}
        )
    except Exception as e:
        return {"error": str(e)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
