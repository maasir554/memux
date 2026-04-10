import { apiService } from "./api-service";
import { dbService, type ContextSegment, type ContextSourceType, type RetrievedContextItem } from "./db-service";

export interface RetrievalOptions {
    spaceIds?: string[];
    sourceTypes?: ContextSourceType[];
    conversation?: Array<{ role: "user" | "assistant"; content: string }>;
    includeLinks?: boolean;
}

export interface RetrievalDebugInfo {
    original_query: string;
    generated_search_terms: string[];
    query_term_debug?: Record<string, any> | null;
    focused_space_ids: string[];
    focused_source_types: string[];
    term_runs: Array<{
        term: string;
        retrieved_ids: string[];
        retrieved_count: number;
        top_labels: string[];
    }>;
    merged_retrieved_ids: string[];
    merged_retrieved_count: number;
}

// ── Search term generation ────────────────────────────────────────────────────
// ── Deduplication ─────────────────────────────────────────────────────────────
function dedupeById(items: RetrievedContextItem[]): RetrievedContextItem[] {
    const seen = new Set<string>();
    const out: RetrievedContextItem[] = [];
    for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
    }
    return out;
}

// ── JSON helpers ──────────────────────────────────────────────────────────────
function parseJsonObject(value: unknown): Record<string, any> | null {
    if (!value) return null;
    if (typeof value === "object") return value as Record<string, any>;
    if (typeof value === "string") {
        try { return JSON.parse(value); } catch { return null; }
    }
    return null;
}

function trimBlock(text: string, max: number = 1800): string {
    const t = String(text || "").trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
}

function findLastSegment<T>(items: T[], predicate: (item: T) => boolean): T | null {
    for (let i = items.length - 1; i >= 0; i--) {
        if (predicate(items[i])) return items[i];
    }
    return null;
}

function getStructured(segment?: ContextSegment | null): Record<string, any> {
    return parseJsonObject(segment?.structured_json) || {};
}

function getSegmentRawText(segment?: ContextSegment | null): string {
    const s = getStructured(segment);
    return String(s?.raw_text || segment?.text_content || "").trim();
}

// ── Content builders (used by enrichRetrievedItems) ───────────────────────────
function buildBookmarkContent(
    item: RetrievedContextItem,
    segments: ContextSegment[]
): { rawText: string; fullContent: string; structured: Record<string, any> } {
    const exact = segments.find(s => s.id === item.id) || null;
    const exactStructured = parseJsonObject(exact?.structured_json) || (item.structured_payload || {});

    const sourceSummarySeg = findLastSegment(segments, s => s.segment_type === "bookmark_summary");
    const sourceSummaryStructured = parseJsonObject(sourceSummarySeg?.structured_json);
    const sourceSummary = sourceSummaryStructured?.summary || sourceSummarySeg?.text_content || exactStructured?.source_summary || "";

    const heading = exactStructured?.heading || "";
    const contextPrefix = Array.isArray(exactStructured?.context_prefix)
        ? exactStructured.context_prefix.join(" > ")
        : "";
    const rawText = String(exactStructured?.raw_text || exact?.text_content || item.raw_text || item.text_summary || "");

    const allParagraphs = segments
        .filter(s => s.segment_type === "paragraph")
        .sort((a, b) => Number(a.segment_index || 0) - Number(b.segment_index || 0));

    const currentIndex = exact ? allParagraphs.findIndex(s => s.id === exact.id) : -1;
    const neighbors = currentIndex >= 0
        ? allParagraphs.slice(Math.max(0, currentIndex - 1), Math.min(allParagraphs.length, currentIndex + 2))
        : allParagraphs.slice(0, 2);
    const neighborTextBlocks = neighbors.map(s => trimBlock(getSegmentRawText(s), 700)).filter(Boolean);

    const blocks = [
        sourceSummary ? `Bookmark Summary:\n${trimBlock(sourceSummary, 700)}` : "",
        heading ? `Heading: ${heading}` : "",
        contextPrefix ? `Trace:\n${contextPrefix}` : "",
        exactStructured?.continued_from_previous
            ? `Continuation: yes${exactStructured?.inherited_heading ? ` (inherited heading: ${exactStructured.inherited_heading})` : ""}`
            : "",
        neighborTextBlocks.length > 1 ? `Neighbor Context:\n${neighborTextBlocks.join("\n\n---\n\n")}` : "",
        `Primary Evidence:\n${rawText}`,
    ].filter(Boolean);

    let finalRawText = rawText;
    let finalFullContent = blocks.join("\n\n");

    if (exact?.segment_type === 'link') {
        const alias = `[link_${exactStructured?.chunk_id || exact.id}]`;
        const title = exactStructured?.link_title || "Hyperlink";
        finalRawText = `${alias}: "${title}"`;
        finalFullContent = `Primary Link Reference:\n${finalRawText}`;
    } else if (exact?.segment_type === 'image_link') {
        const alias = `[image_${exactStructured?.chunk_id || exact.id}]`;
        const title = exactStructured?.image_title || "Image";
        finalRawText = `${alias}: "${title}"`;
        finalFullContent = `Primary Image Reference:\n${finalRawText}`;
    }

    return {
        rawText: finalRawText,
        fullContent: finalFullContent,
        structured: { ...(exactStructured || {}), source_summary: sourceSummary, heading, raw_text: finalRawText }
    };
}

function buildSnipContent(
    item: RetrievedContextItem,
    segments: ContextSegment[]
): { rawText: string; fullContent: string; structured: Record<string, any> } {
    const exact = segments.find(s => s.id === item.id) || null;
    const exactStructured = parseJsonObject(exact?.structured_json) || (item.structured_payload || {});
    const caption = findLastSegment(segments, s => s.segment_type === "caption");
    const detailBlocks = segments
        .filter(s => s.segment_type === "ocr_block")
        .sort((a, b) => Number(a.segment_index || 0) - Number(b.segment_index || 0));
    const currentIndex = exact ? detailBlocks.findIndex(s => s.id === exact.id) : -1;
    const neighbors = currentIndex >= 0
        ? detailBlocks.slice(Math.max(0, currentIndex - 1), Math.min(detailBlocks.length, currentIndex + 2))
        : detailBlocks.slice(0, 2);
    const rawText = String(exactStructured?.raw_text || exact?.text_content || item.raw_text || item.text_summary || "");
    const blocks = [
        caption?.text_content ? `Screenshot Summary:\n${trimBlock(caption.text_content, 600)}` : "",
        exactStructured?.heading ? `Chunk Heading: ${exactStructured.heading}` : "",
        Array.isArray(exactStructured?.context_prefix) ? `Trace:\n${exactStructured.context_prefix.join(" > ")}` : "",
        neighbors.length > 1 ? `Neighbor OCR Blocks:\n${neighbors.map(s => trimBlock(s.text_content, 700)).join("\n\n---\n\n")}` : "",
        `Primary Evidence:\n${rawText}`,
    ].filter(Boolean);
    return {
        rawText,
        fullContent: blocks.join("\n\n"),
        structured: { ...(exactStructured || {}), source_snip_summary: caption?.text_content || "", raw_text: rawText }
    };
}

function buildPdfContent(
    item: RetrievedContextItem,
    segments: ContextSegment[]
): { rawText: string; fullContent: string; structured: Record<string, any> } {
    const exact = segments.find(s => s.id === item.id) || null;
    const exactStructured = parseJsonObject(exact?.structured_json) || (item.structured_payload || {});
    const sorted = segments
        .filter(s => s.segment_type === item.segment_type)
        .sort((a, b) => Number(a.segment_index || 0) - Number(b.segment_index || 0));
    const currentIndex = exact ? sorted.findIndex(s => s.id === exact.id) : -1;
    const neighbors = currentIndex >= 0
        ? sorted.slice(Math.max(0, currentIndex - 1), Math.min(sorted.length, currentIndex + 2))
        : sorted.slice(0, 2);
    const structuredDataText = exactStructured && Object.keys(exactStructured).length > 0
        ? JSON.stringify(exactStructured, null, 2)
        : "";
    const rawText = String(exactStructured?.raw_text || exact?.text_content || item.raw_text || item.text_summary || "");
    const blocks = [
        item.location_label ? `Location: ${item.location_label}` : "",
        structuredDataText ? `Structured Data:\n${trimBlock(structuredDataText, 1200)}` : "",
        neighbors.length > 1 ? `Neighbor Rows / Chunks:\n${neighbors.map(s => trimBlock(s.text_content, 500)).join("\n\n---\n\n")}` : "",
        `Primary Evidence:\n${rawText}`,
    ].filter(Boolean);
    return {
        rawText,
        fullContent: blocks.join("\n\n"),
        structured: { ...(exactStructured || {}), raw_text: rawText }
    };
}

async function enrichRetrievedItems(items: RetrievedContextItem[]): Promise<RetrievedContextItem[]> {
    const uniqueSourceIds = Array.from(new Set(items.map(item => item.source_id)));
    const segmentLists = await Promise.all(uniqueSourceIds.map(id => dbService.getContextSegmentsBySource(id)));
    const bySource = new Map<string, ContextSegment[]>();
    uniqueSourceIds.forEach((id, idx) => bySource.set(id, segmentLists[idx] || []));

    return items.map(item => {
        const sourceSegments = bySource.get(item.source_id) || [];
        let content;
        if (item.source_type === "bookmark") {
            content = buildBookmarkContent(item, sourceSegments);
        } else if (item.source_type === "snip") {
            content = buildSnipContent(item, sourceSegments);
        } else {
            content = buildPdfContent(item, sourceSegments);
        }
        return {
            ...item,
            raw_text: content.rawText,
            full_content: content.fullContent,
            structured_payload: { ...(item.structured_payload || {}), ...(content.structured || {}) }
        };
    });
}

function formatForModels(items: RetrievedContextItem[]) {
    return items.map(item => ({
        id: item.id,
        source_id: item.source_id,
        source_type: item.source_type,
        space_id: item.space_id,
        document_id: item.document_id || null,
        filename: item.title,
        segment_type: item.segment_type || null,
        table_name: item.location_label,
        page_number: item.citation_payload.page_number || 1,
        text_summary: item.text_summary,
        raw_text: item.raw_text || item.text_summary,
        full_content: item.full_content || item.raw_text || item.text_summary,
        data: item.structured_payload || {},
        similarity_score: item.similarity_score,
        citation_payload: item.citation_payload,
    }));
}

// ── Main service ──────────────────────────────────────────────────────────────
export const contextRetrievalService = {
    /**
     * Flat RAG retrieval pipeline:
     *  1. Exact query + LLM-decomposed sub-queries (run in parallel)
     *  2. For each term: embed → pgvector across ALL source types
     *  3. Filter to similarity >= 60%, cap at 20 per term
     *  4. Dedupe across all 4 term results
     *  5. Sort by score, enrich with full content, return
     */
    async retrieve(
        query: string,
        options?: RetrievalOptions
    ): Promise<{ items: RetrievedContextItem[]; debug: RetrievalDebugInfo }> {
        const SIMILARITY_THRESHOLD = 0.60;
        const MAX_PER_TERM = 20;

        // ── Step 1: LLM decomposition + space resolution in parallel ──────────
        let spaceIds = options?.spaceIds || [];
        const [decomposed] = await Promise.all([
            apiService.decomposeQuery(query, options?.conversation).catch(() => ({ search_terms: [] as string[] })),
            spaceIds.length === 0
                ? dbService.getDefaultContextSpace().then(s => { spaceIds = [s.id]; })
                : Promise.resolve(),
        ]);

        // Exact query always first, then up to 3 unique LLM sub-queries
        const llmTerms = (decomposed.search_terms || []).slice(0, 3);
        const allTerms = [query, ...llmTerms.filter(t => t.toLowerCase() !== query.toLowerCase())].slice(0, 4);

        // ── Step 2: embed all terms and search in parallel ────────────────────
        const termRuns: RetrievalDebugInfo["term_runs"] = [];
        let mergedItems: RetrievedContextItem[] = [];

        const baseSegmentTypes: ContextSegment['segment_type'][] = ['table_row', 'paragraph', 'ocr_block', 'caption', 'bookmark_summary', 'section_summary'];
        const allowedTypes = options?.includeLinks 
            ? [...baseSegmentTypes, 'link', 'image_link'] as ContextSegment['segment_type'][]
            : baseSegmentTypes;

        const termResults = await Promise.all(
            allTerms.map(async term => {
                const embeddings = await apiService.generateEmbeddings([term]);
                if (!embeddings || embeddings.length === 0) return { term, items: [] as RetrievedContextItem[] };
                const raw = await dbService.getTopContextSegmentsByEmbeddingAcrossSpaces({
                    queryEmbedding: embeddings[0],
                    spaceIds,
                    segmentTypes: allowedTypes,
                    limit: MAX_PER_TERM * 3,
                });
                const passing = raw
                    .filter(item => (item.similarity_score || 0) >= SIMILARITY_THRESHOLD)
                    .slice(0, MAX_PER_TERM);
                return { term, items: passing };
            })
        );

        for (const { term, items } of termResults) {
            termRuns.push({
                term,
                retrieved_ids: items.map(i => i.id),
                retrieved_count: items.length,
                top_labels: items.slice(0, 3).map(i => `${i.title} • ${i.location_label}`),
            });
            mergedItems = dedupeById([...mergedItems, ...items]);
        }

        // Fallback: if nothing scored >= 60%, take top 5 regardless of score
        if (mergedItems.length === 0) {
            const embeddings = await apiService.generateEmbeddings([query]);
            if (embeddings && embeddings.length > 0) {
                const fallback = await dbService.getTopContextSegmentsByEmbeddingAcrossSpaces({
                    queryEmbedding: embeddings[0],
                    spaceIds,
                    segmentTypes: allowedTypes,
                    limit: 5,
                });
                mergedItems = dedupeById(fallback);
                termRuns.push({
                    term: `[fallback] ${query}`,
                    retrieved_ids: mergedItems.map(i => i.id),
                    retrieved_count: mergedItems.length,
                    top_labels: mergedItems.slice(0, 3).map(i => `${i.title} • ${i.location_label}`),
                });
            }
        }

        // ── Step 3: Sort and enrich ───────────────────────────────────────────
        mergedItems.sort((a, b) => (b.similarity_score || 0) - (a.similarity_score || 0));
        const finalItems = await enrichRetrievedItems(mergedItems);

        return {
            items: finalItems,
            debug: {
                original_query: query,
                generated_search_terms: allTerms,
                query_term_debug: {
                    mode: "llm_decomposition",
                    llm_terms: llmTerms,
                    threshold: SIMILARITY_THRESHOLD,
                    max_per_term: MAX_PER_TERM,
                },
                focused_space_ids: spaceIds,
                focused_source_types: ["all"],
                term_runs: termRuns,
                merged_retrieved_ids: finalItems.map(item => item.id),
                merged_retrieved_count: finalItems.length,
            },
        };
    },

    formatForModels,
};
