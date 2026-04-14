import json
import time
import uuid
from typing import Any, Dict, Generator, List, Optional

from extraction import evaluate_shortlist, generate_rag_query_terms, generate_rag_response


def _now_ms() -> int:
    return int(time.time() * 1000)


def sse_event(event_type: str, data: Dict[str, Any]) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event_type}\ndata: {payload}\n\n"


def _to_candidates(context_chunks: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for item in context_chunks:
        if not isinstance(item, dict):
            continue
        text_summary = (
            item.get("full_content")
            or item.get("text_summary")
            or item.get("raw_text")
            or ""
        )
        out.append({
            "id": str(item.get("id", "")),
            "text_summary": str(text_summary),
        })
    return out


def _build_references(used_chunk_ids: List[str], context_chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    index: Dict[str, Dict[str, Any]] = {}
    for chunk in context_chunks:
        cid = str(chunk.get("id", ""))
        if cid:
            index[cid] = chunk

    refs: List[Dict[str, Any]] = []
    for cid in used_chunk_ids:
        chunk = index.get(cid)
        if not chunk:
            continue
        refs.append({
            "chunk_id": cid,
            "source_id": chunk.get("source_id"),
            "filename": chunk.get("filename"),
            "source_type": chunk.get("source_type"),
            "location": chunk.get("table_name"),
            "page_number": chunk.get("page_number"),
            "text_summary": chunk.get("text_summary"),
            "citation_payload": chunk.get("citation_payload") or {},
            "similarity_score": chunk.get("similarity_score"),
        })
    return refs


def run_multi_agent_stream(
    *,
    run_id: str,
    user_query: str,
    context_chunks: List[Dict[str, Any]],
    conversation: Optional[List[Dict[str, str]]] = None,
    run_state_store: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Generator[str, None, None]:
    started_at = _now_ms()
    state = {
        "run_id": run_id,
        "status": "running",
        "phase": "planning",
        "started_at_ms": started_at,
        "updated_at_ms": started_at,
    }
    if run_state_store is not None:
        run_state_store[run_id] = state

    def emit(event_type: str, payload: Dict[str, Any]) -> str:
        payload.setdefault("run_id", run_id)
        payload.setdefault("timestamp_ms", _now_ms())
        return sse_event(event_type, payload)

    def checkpoint(phase: str) -> Optional[str]:
        if run_state_store is None:
            return None
        run = run_state_store.get(run_id)
        if not run:
            return None
        run["phase"] = phase
        run["updated_at_ms"] = _now_ms()
        if run.get("status") == "stopped":
            return emit("error", {
                "step_id": "run_control",
                "message": "Run stopped by user.",
            })
        while run.get("status") == "paused":
            time.sleep(0.2)
            run["updated_at_ms"] = _now_ms()
        return None

    yield emit("run_state", {
        "step_id": "run_started",
        "phase": "planning",
        "status": "running",
        "message": "Planner agent analyzing query intent.",
    })

    try:
        stop_msg = checkpoint("planning")
        if stop_msg:
            yield stop_msg
            return

        yield emit("tool_started", {
            "step_id": "planner.query_terms",
            "tool_name": "generate_rag_query_terms",
            "phase": "planning",
            "input": {"user_query": user_query},
        })
        planning_result = generate_rag_query_terms(user_query, conversation or [])
        search_terms = planning_result.get("search_terms", []) or []
        yield emit("tool_finished", {
            "step_id": "planner.query_terms",
            "tool_name": "generate_rag_query_terms",
            "phase": "planning",
            "output_summary": {
                "search_terms": search_terms,
                "count": len(search_terms),
            },
        })

        stop_msg = checkpoint("retrieving")
        if stop_msg:
            yield stop_msg
            return

        candidates = _to_candidates(context_chunks)
        yield emit("run_state", {
            "step_id": "retrieve.begin",
            "phase": "retrieving",
            "status": "running",
            "message": f"Retriever agent evaluating {len(candidates)} candidate chunks.",
        })

        yield emit("tool_started", {
            "step_id": "retriever.shortlist",
            "tool_name": "evaluate_shortlist",
            "phase": "retrieving",
            "input": {"candidate_count": len(candidates)},
        })
        shortlist = evaluate_shortlist(user_query, candidates)
        evaluations = shortlist.get("evaluations", []) or []
        kept_ids = {item.get("id") for item in evaluations if item.get("to_keep")}
        filtered_chunks = [chunk for chunk in context_chunks if chunk.get("id") in kept_ids]
        if not filtered_chunks:
            filtered_chunks = context_chunks[:5]
        yield emit("tool_finished", {
            "step_id": "retriever.shortlist",
            "tool_name": "evaluate_shortlist",
            "phase": "retrieving",
            "output_summary": {
                "kept": len(filtered_chunks),
                "total": len(context_chunks),
            },
        })

        stop_msg = checkpoint("tool_running")
        if stop_msg:
            yield stop_msg
            return

        yield emit("run_state", {
            "step_id": "responder.begin",
            "phase": "synthesizing",
            "status": "running",
            "message": "Responder agent drafting answer from shortlisted evidence.",
        })
        yield emit("tool_started", {
            "step_id": "responder.generate",
            "tool_name": "generate_rag_response",
            "phase": "synthesizing",
            "input": {"chunk_count": len(filtered_chunks)},
        })
        rag_result = generate_rag_response(user_query, filtered_chunks, conversation or [])
        response_text = str(rag_result.get("response", "")).strip()
        used_chunk_ids = rag_result.get("used_chunk_ids", []) or []
        debug_info = rag_result.get("debug_info")
        yield emit("tool_finished", {
            "step_id": "responder.generate",
            "tool_name": "generate_rag_response",
            "phase": "synthesizing",
            "output_summary": {
                "used_chunk_count": len(used_chunk_ids),
                "response_chars": len(response_text),
            },
        })

        references = _build_references(used_chunk_ids, filtered_chunks)
        for ref in references:
            yield emit("citation", {
                "step_id": "citation.emit",
                "phase": "synthesizing",
                "reference": ref,
            })

        # Token-like progressive stream from final response text.
        words = response_text.split(" ")
        for idx, token in enumerate(words):
            stop_msg = checkpoint("synthesizing")
            if stop_msg:
                yield stop_msg
                return
            suffix = "" if idx == len(words) - 1 else " "
            yield emit("token", {
                "step_id": "responder.stream",
                "phase": "synthesizing",
                "delta": f"{token}{suffix}",
            })
            time.sleep(0.012)

        ended_at = _now_ms()
        if run_state_store is not None and run_id in run_state_store:
            run_state_store[run_id]["status"] = "completed"
            run_state_store[run_id]["phase"] = "completed"
            run_state_store[run_id]["updated_at_ms"] = ended_at

        yield emit("final", {
            "step_id": "run_complete",
            "phase": "completed",
            "status": "completed",
            "response": response_text,
            "used_chunk_ids": used_chunk_ids,
            "references": references,
            "debug_info": debug_info,
            "search_terms": search_terms,
            "duration_ms": max(0, ended_at - started_at),
        })
    except Exception as exc:
        if run_state_store is not None and run_id in run_state_store:
            run_state_store[run_id]["status"] = "error"
            run_state_store[run_id]["phase"] = "error"
            run_state_store[run_id]["updated_at_ms"] = _now_ms()
        yield emit("error", {
            "step_id": "run_error",
            "phase": "error",
            "status": "error",
            "message": str(exc),
        })

