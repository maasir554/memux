const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

export interface FieldSchema {
    name: string;
    type: string;
    description: string;
}

export interface ChunkData {
    data: Record<string, any>;
    text_summary: string;
    summary_embedding?: number[];
}

export interface TableExtraction {
    table_name: string;
    summary: string;
    notes: string;
    schema_fields: FieldSchema[];
    chunks: ChunkData[];
    summary_embedding?: number[];
    updated_schema_fields?: FieldSchema[];
    updated_notes?: string;
}

export interface BookmarkCaptureResponse {
    title: string;
    original_url: string;
    canonical_url: string;
    text_blocks: string[];
    screenshots?: Array<{
        image_base64: string;
        mime_type?: string;
    }>;
    screenshots_base64: string[];
    metadata: Record<string, any>;
    html?: string;
    structured_blocks?: Array<Record<string, any>>;
}

export interface BookmarkStructuredParagraph {
    paragraph_id: string;
    heading?: string;
    text: string;
    summary: string;
    order: number;
    dom_path?: string | null;
    tag_name?: string | null;
    channel: 'html' | 'ocr';
    screenshot_index?: number | null;
    context_prefix?: string[];
    layout_hint?: string | null;
    continued_from_previous?: boolean;
    inherited_heading?: string | null;
}

export interface BookmarkStructuredSection {
    section_id: string;
    heading: string;
    order: number;
    summary: string;
    channel?: 'html' | 'ocr' | null;
    continued_from_previous?: boolean;
    inherited_heading?: string | null;
    context_prefix?: string[];
    paragraphs: BookmarkStructuredParagraph[];
}

export interface BookmarkStructuredResponse {
    title: string;
    original_url: string;
    canonical_url: string;
    bookmark_summary: string;
    sections: BookmarkStructuredSection[];
    screenshots: Array<{
        image_base64: string;
        mime_type?: string;
    }>;
    metadata: {
        content_hash?: string;
        html_size?: number;
        clean_text_chars?: number;
        section_count?: number;
        paragraph_count?: number;
        capture_stats?: Record<string, any>;
        [key: string]: any;
    };
}

export interface SmartSnipChunk {
    heading: string;
    text: string;
    summary: string;
}

export interface BookmarkScreenshotSequenceChunk {
    heading: string;
    text: string;
    summary: string;
    context_prefix: string[];
    layout_hint?: string | null;
    continued_from_previous?: boolean;
    mapped_html_fragment_id?: string | null;
}

export interface BookmarkScreenshotSequenceResult {
    screenshot_index: number;
    screenshot_heading: string;
    screenshot_summary: string;
    continued_from_previous: boolean;
    inherited_heading?: string | null;
    context_prefix: string[];
    chunks: BookmarkScreenshotSequenceChunk[];
}

export interface BookmarkScreenshotSequenceResponse {
    screenshots: BookmarkScreenshotSequenceResult[];
    debug_info: Record<string, any>;
}

export interface BookmarkFuseScreenshotRequest {
    ocr_text: string;
    hierarchy_fragments: Array<Record<string, any>>;
    screenshot_index: number;
    previous_context?: Record<string, any>;
    base64_image?: string;
}

export interface BookmarkFuseScreenshotResponse {
    screenshot_index: number;
    screenshot_heading: string;
    screenshot_summary: string;
    chunks: BookmarkScreenshotSequenceChunk[];
    debug_info: Record<string, any>;
}

export interface DevBookmarkFragment {
    fragment_id: string;
    hierarchy: {
        source: string;
        capture_heading?: string;
        heading: string;
        sub_heading?: string | null;
        topic: string;
        level: number;
    };
    context_prefix: string[];
    trace_path?: string;
    text: string;
    summary: string;
    evidence_quote?: string;
    source_mapping?: {
        absolute_start_char?: number;
        absolute_end_char?: number;
        window_start_char?: number;
        window_end_char?: number;
        confidence?: string;
        evidence_quote?: string;
    };
    window_index?: number;
    main_text?: string;
    reply_to_text?: string;
    reply_to_sender?: string;
}

export interface DevBookmarkFragmentResponse {
    source_title: string;
    fragments: DevBookmarkFragment[];
    debug_info: Record<string, any>;
}

export interface RagQueryTermsResponse {
    search_terms: string[];
    debug_info?: Record<string, any>;
}
export interface ShortlistChunk {
    id: string;
    text_summary: string;
}

export interface ShortlistEvaluation {
    id: string;
    to_keep: boolean;
}

export interface ShortlistResponse {
    evaluations: ShortlistEvaluation[];
    debug_info?: Record<string, any>;
}

export const apiService = {
    async extractTables(text: string, previousTables?: any[]): Promise<{ tables: TableExtraction[], debug_info?: any }> {
        const body: any = { text };
        if (previousTables && previousTables.length > 0) {
            body.previous_tables = previousTables;
        }

        const res = await fetch(`${API_URL}/extract`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error("Extraction failed");
        const data = await res.json();
        return { tables: data.tables, debug_info: data.debug_info };
    },

    async generateSql(userQuery: string, schema: any): Promise<string> {
        const res = await fetch(`${API_URL}/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_query: userQuery, table_schema: schema }),
        });
        if (!res.ok) throw new Error("Failed to generate SQL");
        const data = await res.json();
        return data.sql;
    },

    async visionOcr(base64Image: string): Promise<{ text: string, debug_info?: any }> {
        const res = await fetch(`${API_URL}/vision_ocr`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: base64Image }),
        });
        if (!res.ok) throw new Error("Vision OCR failed");
        return await res.json();
    },

    async captureBookmark(url: string, captureMode: 'dual' = 'dual'): Promise<BookmarkCaptureResponse> {
        const res = await fetch(`${API_URL}/bookmark/capture`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, capture_mode: captureMode }),
        });
        if (!res.ok) throw new Error("Bookmark capture failed");
        return await res.json();
    },

    async inferBookmarkTitle(imageBase64: string, rawTitle: string): Promise<string> {
        try {
            const res = await fetch(`${API_URL}/bookmark/infer_title`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ image_base64: imageBase64, raw_title: rawTitle }),
            });
            if (!res.ok) return rawTitle;
            const data = await res.json();
            return data.title || rawTitle;
        } catch {
            return rawTitle;
        }
    },

    async processBookmarkStructured(url: string, captureMode: 'dual' = 'dual'): Promise<BookmarkStructuredResponse> {
        const res = await fetch(`${API_URL}/bookmark/process_structured`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, capture_mode: captureMode }),
        });
        if (!res.ok) throw new Error("Structured bookmark processing failed");
        return await res.json();
    },

    async chunkContext(sourceType: 'pdf' | 'bookmark' | 'snip', rawTextBlocks: string[], metadata?: Record<string, any>): Promise<{ chunks: string[] }> {
        const res = await fetch(`${API_URL}/context/chunk`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                source_type: sourceType,
                raw_text_blocks: rawTextBlocks,
                metadata: metadata || {}
            }),
        });
        if (!res.ok) throw new Error("Context chunking failed");
        return await res.json();
    },

    async smartChunkSnip(ocrText: string): Promise<{ chunks: SmartSnipChunk[], screenshot_summary?: string, debug_info?: any }> {
        const res = await fetch(`${API_URL}/snip/smart_chunk`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ocr_text: ocrText }),
        });
        if (!res.ok) throw new Error("Snip smart chunking failed");
        return await res.json();
    },

    async processBookmarkScreenshotSequence(params: {
        source_title?: string;
        bookmark_summary_context?: string;
        screenshots: Array<{
            screenshot_index: number;
            ocr_text: string;
            asset_id?: string;
        }>;
        initial_context?: Record<string, any>;
    }): Promise<BookmarkScreenshotSequenceResponse> {
        const res = await fetch(`${API_URL}/bookmark/screenshot_sequence_chunk`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                source_title: params.source_title || "",
                bookmark_summary_context: params.bookmark_summary_context || "",
                screenshots: params.screenshots,
                initial_context: params.initial_context || {}
            }),
        });
        if (!res.ok) throw new Error("Bookmark screenshot sequence chunking failed");
        return await res.json();
    },

    async fuseScreenshotWithHierarchy(params: BookmarkFuseScreenshotRequest): Promise<BookmarkFuseScreenshotResponse> {
        const res = await fetch(`${API_URL}/bookmark/fuse_screenshot`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
        });
        if (!res.ok) throw new Error("Screenshot hierarchy fusion failed");
        return await res.json();
    },

    async processDevBookmarkFragments(params: {
        source_title?: string;
        raw_text: string;
        hierarchy_text?: string;
        max_window_chars?: number;
        overlap_chars?: number;
    }): Promise<DevBookmarkFragmentResponse> {
        const res = await fetch(`${API_URL}/dev/bookmark_fragments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                source_title: params.source_title || "",
                raw_text: params.raw_text,
                hierarchy_text: params.hierarchy_text || "",
                max_window_chars: params.max_window_chars || 12000,
                overlap_chars: params.overlap_chars || 1200
            }),
        });
        if (!res.ok) throw new Error("Dev bookmark fragmentation failed");
        return await res.json();
    },

    async extractPdfSummary(pageTexts: string[]): Promise<{ title: string, summary: string }> {
        const res = await fetch(`${API_URL}/pdf_summary`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ page_texts: pageTexts }),
        });
        if (!res.ok) throw new Error("PDF Summary extraction failed");
        return await res.json();
    },

    async generateRagQueryTerms(
        userQuery: string,
        conversation?: Array<{ role: 'user' | 'assistant'; content: string }>
    ): Promise<RagQueryTermsResponse> {
        const res = await fetch(`${API_URL}/rag/query_terms`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                user_query: userQuery,
                conversation: conversation || []
            }),
        });
        if (!res.ok) throw new Error("RAG query term generation failed");
        return await res.json();
    },

    async ragShortlistChunks(
        userQuery: string,
        candidates: ShortlistChunk[]
    ): Promise<ShortlistResponse> {
        const res = await fetch(`${API_URL}/rag/shortlist`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                user_query: userQuery,
                candidates: candidates
            }),
        });
        if (!res.ok) throw new Error("RAG shortlisting failed");
        return await res.json();
    },

    async generateEmbeddings(texts: string[]): Promise<number[][]> {
        const res = await fetch(`${API_URL}/embed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ texts }),
        });
        if (!res.ok) throw new Error("Embedding generation failed");
        const data = await res.json();
        return data.embeddings;
    },

    async generateRagChat(
        userQuery: string,
        contextChunks: any[],
        conversation?: Array<{ role: 'user' | 'assistant'; content: string }>
    ): Promise<{ response: string, used_chunk_ids: string[], debug_info?: any }> {
        const res = await fetch(`${API_URL}/rag_chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                user_query: userQuery,
                context_chunks: contextChunks,
                conversation: conversation || []
            }),
        });
        if (!res.ok) throw new Error("Failed to generate RAG response");
        const data = await res.json();
        return { response: data.response, used_chunk_ids: data.used_chunk_ids || [], debug_info: data.debug_info };
    },

    async decomposeQuery(
        userQuery: string,
        conversation?: Array<{ role: 'user' | 'assistant'; content: string }>
    ): Promise<{ search_terms: string[]; debug_info?: any }> {
        const res = await fetch(`${API_URL}/rag/query_terms`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                user_query: userQuery,
                conversation: conversation || [],
            }),
        });
        if (!res.ok) throw new Error("Failed to decompose query");
        const data = await res.json();
        return { search_terms: data.search_terms || [], debug_info: data.debug_info };
    },
};

