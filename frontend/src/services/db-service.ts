import { getDb } from "../lib/db";

export interface Document {
    id: string;
    filename: string;
    source_url?: string;
    status: 'queued' | 'processing' | 'paused' | 'completed' | 'error' | 'archived';
    total_pages: number;
    processed_pages: number;
    created_at: string;
    updated_at?: string;
    deleted_at?: string | null;
    dismissed_from_queue?: boolean;
    name_embedding?: number[];
    summary?: string;
}

export interface ContextSpace {
    id: string;
    name: string;
    description?: string | null;
    is_default: boolean;
    created_at: string;
    updated_at: string;
    archived_at?: string | null;
}

export type ContextSourceType = 'pdf' | 'bookmark' | 'snip';

export interface ContextSource {
    id: string;
    space_id: string;
    source_type: ContextSourceType;
    title: string;
    original_uri?: string | null;
    canonical_uri?: string | null;
    status: string;
    summary?: string | null;
    metadata_json?: Record<string, any> | null;
    source_embedding?: number[] | null;
    source_group_key?: string | null;
    version_no?: number;
    is_latest?: boolean;
    content_hash?: string | null;
    legacy_document_id?: string | null;
    created_at: string;
    updated_at: string;
    deleted_at?: string | null;
}

export interface ContextSegment {
    id: string;
    source_id: string;
    segment_type: 'table_row' | 'paragraph' | 'ocr_block' | 'caption' | 'bookmark_summary' | 'section_summary' | 'link' | 'image_link';
    segment_index: number;
    page_number?: number | null;
    locator_json?: Record<string, any> | null;
    text_content: string;
    structured_json?: Record<string, any> | null;
    embedding?: number[] | null;
    token_count?: number | null;
    legacy_chunk_id?: string | null;
    created_at: string;
}

export interface ContextAsset {
    id: string;
    source_id: string;
    asset_type: 'pdf' | 'image' | 'screenshot' | 'html' | 'text' | 'thumbnail';
    asset_uri?: string | null;
    mime_type?: string | null;
    byte_size?: number | null;
    metadata_json?: Record<string, any> | null;
    created_at: string;
}

export interface DevPageExtraction {
    id: string;
    url: string;
    title?: string | null;
    source?: string | null;
    payload_json: Record<string, any>;
    hierarchy_text?: string | null;
    plain_text?: string | null;
    node_count?: number;
    link_count?: number;
    created_at: string;
}

export interface ContextExplorerItem {
    id: string;
    source_type: ContextSourceType;
    title: string;
    status: string;
    space_id: string;
    space_name?: string;
    original_uri?: string | null;
    canonical_uri?: string | null;
    summary?: string | null;
    legacy_document_id?: string | null;
    segment_count: number;
    max_page_number: number;
    total_pages?: number | null;
    created_at: string;
    updated_at: string;
}

export interface RetrievedContextItem {
    id: string;
    source_id: string;
    source_type: ContextSourceType;
    space_id: string;
    document_id?: string | null;
    title: string;
    segment_type?: ContextSegment['segment_type'];
    segment_index?: number;
    location_label: string;
    text_summary: string;
    raw_text?: string;
    full_content?: string;
    structured_payload?: any;
    similarity_score: number;
    citation_payload: {
        source_id: string;
        source_type: ContextSourceType;
        title: string;
        page_number?: number | null;
        original_uri?: string | null;
        canonical_uri?: string | null;
        asset_id?: string | null;
        tag_name?: string | null;
        section_id?: string | null;
        paragraph_id?: string | null;
        channel?: 'html' | 'ocr' | null;
    };
}

export const dbService = {
    async getAllDocuments(): Promise<Document[]> {
        const db = getDb();
        const res = await db.query("SELECT * FROM documents WHERE deleted_at IS NULL ORDER BY created_at DESC");
        // console.log("getAllDocuments raw result:", res.rows);
        return res.rows as Document[];
    },

    async getDocument(id: string): Promise<Document | null> {
        const db = getDb();
        const res = await db.query("SELECT * FROM documents WHERE id = $1", [id]);
        return (res.rows[0] as Document) ?? null;
    },

    async addDocument(filename: string, sourceUrl?: string): Promise<string> {
        const db = getDb();
        // PGlite returns query results, we need to extract the ID.
        // Since we use gen_random_uuid(), we can just insert and return id.
        const res = await db.query(
            "INSERT INTO documents (filename, source_url, dismissed_from_queue) VALUES ($1, $2, FALSE) RETURNING id",
            [filename, sourceUrl || null]
        );
        return (res.rows[0] as any).id;
    },

    async updateDocumentStatus(id: string, status: string, processedPages: number, totalPages?: number) {
        const db = getDb();
        if (totalPages !== undefined) {
            await db.query(
                "UPDATE documents SET status = $1, processed_pages = $2, total_pages = $3, updated_at = NOW() WHERE id = $4",
                [status, processedPages, totalPages, id]
            );
        } else {
            await db.query(
                "UPDATE documents SET status = $1, processed_pages = $2, updated_at = NOW() WHERE id = $3",
                [status, processedPages, id]
            );
        }

        await db.query(
            "UPDATE context_sources SET status = $1, updated_at = NOW() WHERE legacy_document_id = $2",
            [status, id]
        );
    },

    async updateDocumentTitleAndSummary(id: string, title: string, summary: string, nameEmbedding?: number[]) {
        const db = getDb();
        if (nameEmbedding) {
            await db.query(
                "UPDATE documents SET filename = $1, summary = $2, name_embedding = $3, updated_at = NOW() WHERE id = $4",
                [title, summary, JSON.stringify(nameEmbedding), id]
            );
        } else {
            await db.query(
                "UPDATE documents SET filename = $1, summary = $2, updated_at = NOW() WHERE id = $3",
                [title, summary, id]
            );
        }

        if (nameEmbedding) {
            await db.query(
                "UPDATE context_sources SET title = $1, summary = $2, source_embedding = $3, updated_at = NOW() WHERE legacy_document_id = $4",
                [title, summary, JSON.stringify(nameEmbedding), id]
            );
        } else {
            await db.query(
                "UPDATE context_sources SET title = $1, summary = $2, updated_at = NOW() WHERE legacy_document_id = $3",
                [title, summary, id]
            );
        }
    },

    async getTables() {
        const db = getDb();
        return await db.getTables();
    },

    async getFullSchema() {
        const db = getDb();
        const res = await db.query(`
            SELECT table_name, column_name, data_type 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
            ORDER BY table_name, ordinal_position
        `);

        // Group by table
        const schema: Record<string, any[]> = {};
        for (const r of res.rows) {
            const row = r as any;
            const t = row.table_name as string;
            if (!schema[t]) schema[t] = [];
            schema[t].push({ name: row.column_name, type: row.data_type });
        }
        return schema;
    },

    async executeQuery(sql: string) {
        const db = getDb();
        return await db.query(sql);
    },

    async saveExtractedData(tables: any[], docId: string, pageNum: number) {
        const sourceId = await this.ensurePdfContextSource(docId);
        for (const table of tables) {
            // 1. Insert into pdf_tables
            const tableId = await this.savePdfTable(docId, table, pageNum);

            // 2. Insert each chunk
            if (table.chunks && table.chunks.length > 0) {
                await this.saveChunks(tableId, docId, table.chunks, pageNum, sourceId);
            }
        }
    },

    async savePdfTable(
        docId: string,
        table: { table_name: string; summary: string; notes: string; schema_fields: any[]; summary_embedding?: number[] },
        pageNum: number
    ): Promise<string> {
        const db = getDb();
        const res = await db.query(
            `INSERT INTO pdf_tables (document_id, table_name, summary, notes, schema_json, summary_embedding, page_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [
                docId,
                table.table_name,
                table.summary,
                table.notes,
                JSON.stringify(table.schema_fields),
                table.summary_embedding ? JSON.stringify(table.summary_embedding) : null,
                pageNum
            ]
        );
        return (res.rows[0] as any).id;
    },

    async updatePdfTableSchemaAndNotes(
        tableId: string,
        newSchema: any[],
        newNotes: string,
        newSummaryEmbedding?: number[]
    ) {
        const db = getDb();
        if (newSummaryEmbedding) {
            await db.query(
                `UPDATE pdf_tables 
                 SET schema_json = $1, notes = $2, summary_embedding = $3, updated_at = NOW() 
                 WHERE id = $4`,
                [JSON.stringify(newSchema), newNotes, JSON.stringify(newSummaryEmbedding), tableId]
            );
        } else {
            await db.query(
                `UPDATE pdf_tables 
                 SET schema_json = $1, notes = $2, updated_at = NOW() 
                 WHERE id = $3`,
                [JSON.stringify(newSchema), newNotes, tableId]
            );
        }
    },

    async saveChunks(
        tableId: string,
        docId: string,
        chunks: { data: Record<string, any>; text_summary: string; summary_embedding?: number[] }[],
        pageNum: number,
        contextSourceId?: string
    ) {
        const db = getDb();
        const sourceId = contextSourceId || await this.ensurePdfContextSource(docId);
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const insertResult = await db.query(
                `INSERT INTO chunks (pdf_table_id, document_id, data, text_summary, summary_embedding, page_number, chunk_index)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [
                    tableId,
                    docId,
                    JSON.stringify(chunk.data),
                    chunk.text_summary,
                    chunk.summary_embedding ? JSON.stringify(chunk.summary_embedding) : null,
                    pageNum,
                    i
                ]
            );

            const chunkId = (insertResult.rows[0] as any)?.id as string | undefined;
            if (!chunkId) continue;

            await db.query(
                `INSERT INTO context_segments (
                    source_id, segment_type, segment_index, page_number, locator_json,
                    text_content, structured_json, embedding, token_count, legacy_chunk_id
                 )
                 SELECT
                    $1, 'table_row', $2, $3, $4, $5, $6, $7, NULL, $8
                 WHERE NOT EXISTS (
                    SELECT 1 FROM context_segments WHERE legacy_chunk_id = $8
                 )`,
                [
                    sourceId,
                    i,
                    pageNum,
                    JSON.stringify({ pdf_table_id: tableId }),
                    chunk.text_summary || "",
                    JSON.stringify(chunk.data || {}),
                    chunk.summary_embedding ? JSON.stringify(chunk.summary_embedding) : null,
                    chunkId
                ]
            );
        }
    },

    async getPdfTables(docId?: string): Promise<any[]> {
        const db = getDb();
        if (docId) {
            const res = await db.query(
                "SELECT * FROM pdf_tables WHERE document_id = $1 ORDER BY created_at DESC",
                [docId]
            );
            return res.rows;
        }
        const res = await db.query("SELECT * FROM pdf_tables ORDER BY created_at DESC");
        return res.rows;
    },

    async getTotalTableCount(): Promise<number> {
        const db = getDb();
        const res = await db.query("SELECT COUNT(*) as count FROM pdf_tables");
        return parseInt((res.rows[0] as any).count, 10);
    },

    async getPdfTablesByPage(docId: string, pageNumber: number): Promise<any[]> {
        const db = getDb();
        const res = await db.query(
            "SELECT * FROM pdf_tables WHERE document_id = $1 AND page_number = $2",
            [docId, pageNumber]
        );
        return res.rows;
    },

    async getChunks(tableId: string): Promise<any[]> {
        const db = getDb();
        const res = await db.query(
            "SELECT * FROM chunks WHERE pdf_table_id = $1 ORDER BY chunk_index ASC",
            [tableId]
        );
        return res.rows;
    },

    async getTableInfo(tableId: string): Promise<any> {
        const db = getDb();
        const res = await db.query(
            "SELECT id, table_name, summary, notes, schema_json, page_number FROM pdf_tables WHERE id = $1",
            [tableId]
        );
        return res.rows[0] || null;
    },

    async getNearbyChunks(chunkId: string, direction: 'up' | 'down' | 'both', count: number): Promise<any[]> {
        const db = getDb();

        // First get the chunk's table_id and index
        const chunkRes = await db.query("SELECT pdf_table_id, chunk_index FROM chunks WHERE id = $1", [chunkId]);
        if (chunkRes.rows.length === 0) return [];

        const { pdf_table_id, chunk_index } = chunkRes.rows[0] as any;

        let query = "";
        let params: any[] = [];

        if (direction === 'up') {
            query = "SELECT * FROM chunks WHERE pdf_table_id = $1 AND chunk_index < $2 ORDER BY chunk_index DESC LIMIT $3";
            params = [pdf_table_id, chunk_index, count];
        } else if (direction === 'down') {
            query = "SELECT * FROM chunks WHERE pdf_table_id = $1 AND chunk_index > $2 ORDER BY chunk_index ASC LIMIT $3";
            params = [pdf_table_id, chunk_index, count];
        } else {
            // Find both
            query = `
                (SELECT * FROM chunks WHERE pdf_table_id = $1 AND chunk_index < $2 ORDER BY chunk_index DESC LIMIT $3)
                UNION ALL
                (SELECT * FROM chunks WHERE pdf_table_id = $1 AND chunk_index > $2 ORDER BY chunk_index ASC LIMIT $3)
                ORDER BY chunk_index ASC
            `;
            params = [pdf_table_id, chunk_index, count];
        }

        const res = await db.query(query, params);

        // If direction is 'up', we got them in DESC order for the limit, so reverse them back to natural order
        if (direction === 'up') {
            return res.rows.reverse();
        }

        return res.rows;
    },

    async getAllChunks(docId: string): Promise<any[]> {
        const db = getDb();
        const res = await db.query(
            "SELECT c.*, pt.table_name FROM chunks c JOIN pdf_tables pt ON c.pdf_table_id = pt.id WHERE c.document_id = $1 ORDER BY pt.table_name, c.chunk_index",
            [docId]
        );
        return res.rows;
    },

    // --- Trash operations ---

    async getTrashedDocuments(): Promise<Document[]> {
        const db = getDb();
        const res = await db.query("SELECT * FROM documents WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC");
        return res.rows as Document[];
    },

    async softDeleteDocument(id: string) {
        const db = getDb();
        await db.query("UPDATE documents SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
    },

    async dismissDocument(id: string) {
        const db = getDb();
        await db.query("UPDATE documents SET dismissed_from_queue = TRUE, updated_at = NOW() WHERE id = $1", [id]);
    },

    async restoreDocument(id: string) {
        const db = getDb();
        await db.query("UPDATE documents SET deleted_at = NULL, updated_at = NOW() WHERE id = $1", [id]);
    },

    async permanentlyDeleteDocument(id: string) {
        const db = getDb();
        await db.query("DELETE FROM documents WHERE id = $1", [id]);
    },

    async purgeExpiredTrash(cutoffDate: Date): Promise<string[]> {
        const db = getDb();
        const res = await db.query(
            "DELETE FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < $1 RETURNING id",
            [cutoffDate.toISOString()]
        );
        return (res.rows as any[]).map(r => r.id);
    },

    async semanticFileSearch(queryEmbedding: number[]): Promise<string[]> {
        const db = getDb();
        const embStr = JSON.stringify(queryEmbedding);

        const res = await db.query(`
            WITH doc_matches AS (
                SELECT id as document_id, 1 - (name_embedding <=> $1) as score
                FROM documents 
                WHERE deleted_at IS NULL AND name_embedding IS NOT NULL
            ),
            table_matches AS (
                SELECT pt.document_id, 1 - (pt.summary_embedding <=> $1) * 0.9 as score
                FROM pdf_tables pt
                JOIN documents d ON d.id = pt.document_id
                WHERE d.deleted_at IS NULL AND pt.summary_embedding IS NOT NULL
            ),
            chunk_matches AS (
                SELECT c.document_id, 1 - (c.summary_embedding <=> $1) * 0.8 as score
                FROM chunks c
                JOIN documents d ON d.id = c.document_id
                WHERE d.deleted_at IS NULL AND c.summary_embedding IS NOT NULL
            ),
            combined AS (
                SELECT document_id, max(score) as max_score FROM (
                    SELECT * FROM doc_matches
                    UNION ALL
                    SELECT * FROM table_matches
                    UNION ALL
                    SELECT * FROM chunk_matches
                ) all_matches
                GROUP BY document_id
            )
            SELECT document_id, max_score
            FROM combined
            WHERE max_score > 0.3
            ORDER BY max_score DESC
            LIMIT 20;
        `, [embStr]);

        return res.rows.map((r: any) => r.document_id as string);
    },

    async semanticChunkSearch(queryEmbedding: number[], limit: number = 3, focusedDocumentIds?: string[]): Promise<any[]> {
        const db = getDb();
        const embStr = JSON.stringify(queryEmbedding);

        let filterClause = "";
        if (focusedDocumentIds && focusedDocumentIds.length > 0) {
            const idsStr = focusedDocumentIds.map(id => `'${id}'`).join(',');
            filterClause = ` AND d.id IN (${idsStr})`;
        }

        // Search specifically chunks, joining with pdf_tables to get the context and with documents to ensure it's not deleted
        const res = await db.query(`
            SELECT 
                c.id, 
                c.document_id, 
                c.pdf_table_id,
                c.page_number, 
                c.data, 
                c.text_summary,
                pt.table_name,
                d.filename,
                1 - (c.summary_embedding <=> $1) as similarity_score
            FROM chunks c
            JOIN pdf_tables pt ON c.pdf_table_id = pt.id
            JOIN documents d ON c.document_id = d.id
            WHERE d.deleted_at IS NULL AND c.summary_embedding IS NOT NULL ${filterClause}
            ORDER BY similarity_score DESC
            LIMIT $2;
        `, [embStr, limit]);

        return res.rows;
    },

    // Table → Chunk search: skip document hierarchy, find top tables by embedding, get chunks from those
    async semanticTableChunkSearch(queryEmbedding: number[], limit: number = 5, focusedDocumentIds?: string[]): Promise<any[]> {
        const db = getDb();
        const embStr = JSON.stringify(queryEmbedding);

        let filterClause = "";
        if (focusedDocumentIds && focusedDocumentIds.length > 0) {
            const idsStr = focusedDocumentIds.map(id => `'${id}'`).join(',');
            filterClause = ` AND d.id IN (${idsStr})`;
        }

        const res = await db.query(`
            WITH top_tables AS (
                SELECT pt.id
                FROM pdf_tables pt
                JOIN documents d ON pt.document_id = d.id
                WHERE d.deleted_at IS NULL AND pt.summary_embedding IS NOT NULL ${filterClause}
                ORDER BY pt.summary_embedding <=> $1
                LIMIT 5
            )
            SELECT
                c.id,
                c.document_id,
                c.pdf_table_id,
                c.page_number,
                c.data,
                c.text_summary,
                pt.table_name,
                d.filename,
                1 - (c.summary_embedding <=> $1) as similarity_score
            FROM chunks c
            JOIN top_tables tt ON c.pdf_table_id = tt.id
            JOIN pdf_tables pt ON c.pdf_table_id = pt.id
            JOIN documents d ON c.document_id = d.id
            WHERE d.deleted_at IS NULL AND c.summary_embedding IS NOT NULL
            ORDER BY similarity_score DESC
            LIMIT $2;
        `, [embStr, limit]);

        return res.rows;
    },

    async topDownSemanticSearch(queryEmbedding: number[], limit: number = 5, focusedDocumentIds?: string[]): Promise<any[]> {
        const db = getDb();
        const embStr = JSON.stringify(queryEmbedding);

        let filterClauseDocs = "";
        let filterClauseTables = "";

        if (focusedDocumentIds && focusedDocumentIds.length > 0) {
            const idsStr = focusedDocumentIds.map(id => `'${id}'`).join(',');
            filterClauseDocs = ` AND id IN (${idsStr})`;
            filterClauseTables = ` AND d.id IN (${idsStr})`;
        }

        // Step 1: Find top 3 docs
        // Step 2: Find top 3 tables in those docs
        // Step 3: Find top 3 tables overall
        // Step 4: Union the tables
        // Step 5: Find top chunks within those tables
        const res = await db.query(`
            WITH top_docs AS (
                SELECT id 
                FROM documents 
                WHERE deleted_at IS NULL AND name_embedding IS NOT NULL ${filterClauseDocs}
                ORDER BY name_embedding <=> $1 
                LIMIT 3
            ),
            top_tables_per_doc AS (
                SELECT t.id FROM (
                    SELECT pt.id, ROW_NUMBER() OVER(PARTITION BY pt.document_id ORDER BY pt.summary_embedding <=> $1) as rn
                    FROM pdf_tables pt
                    JOIN top_docs td ON pt.document_id = td.id
                    WHERE pt.summary_embedding IS NOT NULL
                ) t WHERE t.rn <= 3
            ),
            top_tables_overall AS (
                SELECT pt.id 
                FROM pdf_tables pt
                JOIN documents d ON pt.document_id = d.id
                WHERE d.deleted_at IS NULL AND pt.summary_embedding IS NOT NULL ${filterClauseTables}
                ORDER BY pt.summary_embedding <=> $1 
                LIMIT 3
            ),
            combined_tables AS (
                SELECT id FROM top_tables_per_doc
                UNION
                SELECT id FROM top_tables_overall
            )
            SELECT 
                c.id, 
                c.document_id, 
                c.pdf_table_id,
                c.page_number, 
                c.data, 
                c.text_summary,
                pt.table_name,
                d.filename,
                1 - (c.summary_embedding <=> $1) as similarity_score
            FROM chunks c
            JOIN combined_tables ct ON c.pdf_table_id = ct.id
            JOIN pdf_tables pt ON c.pdf_table_id = pt.id
            JOIN documents d ON c.document_id = d.id
            WHERE d.deleted_at IS NULL AND c.summary_embedding IS NOT NULL ${filterClauseTables}
            ORDER BY similarity_score DESC
            LIMIT $2;
        `, [embStr, limit]);

        return res.rows;
    },

    async getDefaultContextSpace(): Promise<ContextSpace> {
        const db = getDb();
        const existing = await db.query(
            "SELECT * FROM context_spaces WHERE is_default = TRUE AND archived_at IS NULL ORDER BY created_at ASC LIMIT 1"
        );

        if (existing.rows.length > 0) {
            return existing.rows[0] as ContextSpace;
        }

        const created = await db.query(
            `INSERT INTO context_spaces (name, description, is_default)
             VALUES ('General Context Space', 'Auto-created default context space', TRUE)
             RETURNING *`
        );
        return created.rows[0] as ContextSpace;
    },

    async getContextSpaces(includeArchived: boolean = false): Promise<ContextSpace[]> {
        const db = getDb();
        const res = await db.query(
            includeArchived
                ? "SELECT * FROM context_spaces ORDER BY is_default DESC, created_at ASC"
                : "SELECT * FROM context_spaces WHERE archived_at IS NULL ORDER BY is_default DESC, created_at ASC"
        );
        return res.rows as ContextSpace[];
    },

    async createContextSpace(name: string, description?: string): Promise<ContextSpace> {
        const db = getDb();
        const res = await db.query(
            "INSERT INTO context_spaces (name, description, is_default) VALUES ($1, $2, FALSE) RETURNING *",
            [name, description || null]
        );
        return res.rows[0] as ContextSpace;
    },

    async updateContextSpace(spaceId: string, name: string, description?: string): Promise<void> {
        const db = getDb();
        await db.query(
            "UPDATE context_spaces SET name = $1, description = $2, updated_at = NOW() WHERE id = $3",
            [name, description || null, spaceId]
        );
    },

    async archiveContextSpace(spaceId: string): Promise<void> {
        const db = getDb();
        await db.query(
            "UPDATE context_spaces SET archived_at = NOW(), updated_at = NOW(), is_default = FALSE WHERE id = $1",
            [spaceId]
        );
    },

    async ensurePdfContextSource(documentId: string, preferredSpaceId?: string): Promise<string> {
        const db = getDb();
        const existing = await db.query(
            "SELECT id FROM context_sources WHERE legacy_document_id = $1 ORDER BY created_at ASC LIMIT 1",
            [documentId]
        );
        if (existing.rows.length > 0) {
            return (existing.rows[0] as any).id;
        }

        const doc = await this.getDocument(documentId);
        if (!doc) throw new Error(`Document not found for context source: ${documentId}`);

        const defaultSpace = preferredSpaceId || (await this.getDefaultContextSpace()).id;
        const res = await db.query(
            `INSERT INTO context_sources (
                space_id, source_type, title, original_uri, canonical_uri, status, summary,
                metadata_json, source_embedding, legacy_document_id, created_at, updated_at, deleted_at
             ) VALUES ($1, 'pdf', $2, $3, $4, $5, $6, '{}'::jsonb, $7, $8, $9, NOW(), $10)
             RETURNING id`,
            [
                defaultSpace,
                doc.filename,
                doc.source_url || null,
                doc.source_url || null,
                doc.status || 'queued',
                doc.summary || null,
                doc.name_embedding ? JSON.stringify(doc.name_embedding) : null,
                doc.id,
                doc.created_at,
                doc.deleted_at || null
            ]
        );

        return (res.rows[0] as any).id;
    },

    async createContextSource(params: {
        spaceId: string;
        sourceType: ContextSourceType;
        title: string;
        originalUri?: string | null;
        canonicalUri?: string | null;
        status?: string;
        summary?: string | null;
        metadata?: Record<string, any>;
        sourceEmbedding?: number[] | null;
        sourceGroupKey?: string | null;
        versionNo?: number;
        isLatest?: boolean;
        contentHash?: string | null;
        legacyDocumentId?: string | null;
    }): Promise<ContextSource> {
        const db = getDb();
        const res = await db.query(
            `INSERT INTO context_sources (
                space_id, source_type, title, original_uri, canonical_uri, status, summary,
                metadata_json, source_embedding, source_group_key, version_no, is_latest, content_hash, legacy_document_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             RETURNING *`,
            [
                params.spaceId,
                params.sourceType,
                params.title,
                params.originalUri || null,
                params.canonicalUri || null,
                params.status || 'queued',
                params.summary || null,
                JSON.stringify(params.metadata || {}),
                params.sourceEmbedding ? JSON.stringify(params.sourceEmbedding) : null,
                params.sourceGroupKey || null,
                params.versionNo || 1,
                params.isLatest !== undefined ? params.isLatest : true,
                params.contentHash || null,
                params.legacyDocumentId || null
            ]
        );
        return res.rows[0] as ContextSource;
    },

    async updateContextSource(sourceId: string, updates: Partial<{
        title: string;
        status: string;
        summary: string | null;
        metadata: Record<string, any>;
        sourceEmbedding: number[] | null;
        canonicalUri: string | null;
        originalUri: string | null;
        sourceGroupKey: string | null;
        versionNo: number;
        isLatest: boolean;
        contentHash: string | null;
        deletedAt: string | null;
    }>): Promise<void> {
        const db = getDb();
        const current = await db.query("SELECT * FROM context_sources WHERE id = $1", [sourceId]);
        if (current.rows.length === 0) return;

        const row = current.rows[0] as any;
        await db.query(
            `UPDATE context_sources
             SET title = $1,
                 status = $2,
                 summary = $3,
                 metadata_json = $4,
                 source_embedding = $5,
                 canonical_uri = $6,
                 original_uri = $7,
                 source_group_key = $8,
                 version_no = $9,
                 is_latest = $10,
                 content_hash = $11,
                 deleted_at = $12,
                 updated_at = NOW()
             WHERE id = $13`,
            [
                updates.title ?? row.title,
                updates.status ?? row.status,
                updates.summary ?? row.summary,
                JSON.stringify(updates.metadata ?? row.metadata_json ?? {}),
                Object.prototype.hasOwnProperty.call(updates, "sourceEmbedding")
                    ? (updates.sourceEmbedding ? JSON.stringify(updates.sourceEmbedding) : null)
                    : row.source_embedding,
                updates.canonicalUri ?? row.canonical_uri,
                updates.originalUri ?? row.original_uri,
                updates.sourceGroupKey ?? row.source_group_key,
                updates.versionNo ?? row.version_no,
                updates.isLatest ?? row.is_latest,
                updates.contentHash ?? row.content_hash,
                updates.deletedAt ?? row.deleted_at,
                sourceId
            ]
        );
    },

    async getLatestBookmarkSourceByCanonical(spaceId: string, canonicalUri: string): Promise<ContextSource | null> {
        const db = getDb();
        const res = await db.query(
            `SELECT * FROM context_sources
             WHERE space_id = $1
               AND source_type = 'bookmark'
               AND canonical_uri = $2
               AND deleted_at IS NULL
               AND is_latest = TRUE
             ORDER BY version_no DESC, updated_at DESC
             LIMIT 1`,
            [spaceId, canonicalUri]
        );
        return (res.rows[0] as ContextSource) || null;
    },

    async getBookmarkSourceVersions(sourceId: string): Promise<ContextSource[]> {
        const db = getDb();
        const sourceRes = await db.query(
            `SELECT id, space_id, canonical_uri, source_group_key
             FROM context_sources
             WHERE id = $1
               AND source_type = 'bookmark'
             LIMIT 1`,
            [sourceId]
        );
        if (sourceRes.rows.length === 0) return [];

        const sourceRow = sourceRes.rows[0] as any;
        const groupKey = sourceRow.source_group_key || sourceRow.id;
        const canonical = sourceRow.canonical_uri;

        const res = await db.query(
            `SELECT * FROM context_sources
             WHERE space_id = $1
               AND source_type = 'bookmark'
               AND deleted_at IS NULL
               AND (
                   source_group_key = $2
                   OR ($3::text IS NOT NULL AND canonical_uri = $3::text)
               )
             ORDER BY version_no DESC, updated_at DESC`,
            [sourceRow.space_id, groupKey, canonical]
        );
        return res.rows as ContextSource[];
    },

    async createBookmarkSourceVersion(params: {
        spaceId: string;
        title: string;
        originalUri?: string | null;
        canonicalUri: string;
        summary?: string | null;
        metadata?: Record<string, any>;
        sourceEmbedding?: number[] | null;
        contentHash?: string | null;
        status?: string;
    }): Promise<ContextSource> {
        const db = getDb();
        const latest = await this.getLatestBookmarkSourceByCanonical(params.spaceId, params.canonicalUri);

        let sourceGroupKey: string | null = latest?.source_group_key || latest?.id || null;
        let versionNo = (latest?.version_no || 0) + 1;
        if (!latest) {
            versionNo = 1;
        } else {
            await db.query(
                "UPDATE context_sources SET is_latest = FALSE, updated_at = NOW() WHERE id = $1",
                [latest.id]
            );
        }

        const created = await this.createContextSource({
            spaceId: params.spaceId,
            sourceType: 'bookmark',
            title: params.title,
            originalUri: params.originalUri || null,
            canonicalUri: params.canonicalUri,
            status: params.status || 'queued',
            summary: params.summary || null,
            metadata: params.metadata || {},
            sourceEmbedding: params.sourceEmbedding || null,
            sourceGroupKey,
            versionNo,
            isLatest: true,
            contentHash: params.contentHash || null,
            legacyDocumentId: null
        });

        if (!sourceGroupKey) {
            sourceGroupKey = created.id;
            await db.query(
                "UPDATE context_sources SET source_group_key = $1 WHERE id = $2",
                [sourceGroupKey, created.id]
            );
            created.source_group_key = sourceGroupKey;
        }

        return created;
    },

    async addContextAsset(params: {
        sourceId: string;
        assetType: ContextAsset['asset_type'];
        assetUri?: string | null;
        mimeType?: string | null;
        byteSize?: number | null;
        metadata?: Record<string, any>;
    }): Promise<string> {
        const db = getDb();
        const res = await db.query(
            `INSERT INTO context_assets (
                source_id, asset_type, asset_uri, mime_type, byte_size, metadata_json
             ) VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [
                params.sourceId,
                params.assetType,
                params.assetUri || null,
                params.mimeType || null,
                params.byteSize || null,
                JSON.stringify(params.metadata || {})
            ]
        );
        return (res.rows[0] as any).id as string;
    },

    async getContextAssets(sourceId: string): Promise<ContextAsset[]> {
        const db = getDb();
        const res = await db.query(
            "SELECT * FROM context_assets WHERE source_id = $1 ORDER BY created_at ASC",
            [sourceId]
        );
        return res.rows as ContextAsset[];
    },

    async clearContextSourceContent(sourceId: string): Promise<void> {
        const db = getDb();
        await db.query("DELETE FROM context_segments WHERE source_id = $1", [sourceId]);
        await db.query("DELETE FROM context_assets WHERE source_id = $1", [sourceId]);
    },

    async saveContextSegments(params: {
        sourceId: string;
        segmentType: ContextSegment['segment_type'];
        chunks: Array<{
            text: string;
            embedding?: number[] | null;
            pageNumber?: number | null;
            index: number;
            structured?: Record<string, any>;
            locator?: Record<string, any>;
            tokenCount?: number | null;
        }>;
    }): Promise<void> {
        const db = getDb();
        for (const chunk of params.chunks) {
            await db.query(
                `INSERT INTO context_segments (
                    source_id, segment_type, segment_index, page_number, locator_json,
                    text_content, structured_json, embedding, token_count
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                    params.sourceId,
                    params.segmentType,
                    chunk.index,
                    chunk.pageNumber || null,
                    chunk.locator ? JSON.stringify(chunk.locator) : null,
                    chunk.text,
                    chunk.structured ? JSON.stringify(chunk.structured) : null,
                    chunk.embedding ? JSON.stringify(chunk.embedding) : null,
                    chunk.tokenCount || null
                ]
            );
        }
    },

    /**
     * Post-processing background deduplication.
     * Removes near-duplicate paragraph/ocr_block segments within a single source.
     * Uses pgvector cosine similarity. Keeps the longest (most informative) copy.
     * @param sourceId - The context_source UUID to deduplicate
     * @param threshold - Cosine similarity threshold (default 0.90)
     * @returns Number of segments deleted
     */
    async deduplicateSourceSegments(sourceId: string, threshold = 0.90): Promise<number> {
        const db = getDb();

        // Fetch all paragraph/ocr_block segments with embeddings for this source
        const res = await db.query(
            `SELECT id, text_content, embedding
             FROM context_segments
             WHERE source_id = $1
               AND segment_type IN ('paragraph', 'ocr_block')
               AND embedding IS NOT NULL
             ORDER BY segment_index ASC`,
            [sourceId]
        );

        const segments = res.rows as Array<{ id: string; text_content: string; embedding: string }>;
        if (segments.length < 2) return 0;

        const toDelete = new Set<string>();

        for (let i = 0; i < segments.length; i++) {
            const segA = segments[i];
            if (toDelete.has(segA.id)) continue; // Already marked, skip

            // Find siblings with high similarity
            const dupRes = await db.query(
                `SELECT id, text_content
                 FROM context_segments
                 WHERE source_id = $1
                   AND id <> $2
                   AND segment_type IN ('paragraph', 'ocr_block')
                   AND embedding IS NOT NULL
                   AND (1 - (embedding <=> $3::vector)) >= $4`,
                [sourceId, segA.id, segA.embedding, threshold]
            );

            const dups = dupRes.rows as Array<{ id: string; text_content: string }>;
            for (const dupSeg of dups) {
                if (toDelete.has(dupSeg.id)) continue;
                // Keep the longer (more informative) segment, delete the shorter
                if ((segA.text_content?.length ?? 0) >= (dupSeg.text_content?.length ?? 0)) {
                    toDelete.add(dupSeg.id);
                } else {
                    toDelete.add(segA.id);
                    break; // segA is the one being deleted, move to next
                }
            }
        }

        if (toDelete.size === 0) return 0;

        const ids = Array.from(toDelete);
        const placeholders = ids.map((_, idx) => `$${idx + 1}`).join(', ');
        await db.query(
            `DELETE FROM context_segments WHERE id IN (${placeholders})`,
            ids
        );

        return toDelete.size;
    },

    async getContextSourcesByCanonical(spaceId: string, canonicalUri: string): Promise<ContextSource[]> {
        const db = getDb();
        const res = await db.query(
            `SELECT * FROM context_sources
             WHERE space_id = $1
               AND canonical_uri = $2
               AND deleted_at IS NULL
               AND (source_type <> 'bookmark' OR is_latest = TRUE)
             ORDER BY updated_at DESC`,
            [spaceId, canonicalUri]
        );
        return res.rows as ContextSource[];
    },

    async getContextSources(spaceIds?: string[], sourceTypes?: ContextSourceType[]): Promise<ContextSource[]> {
        const db = getDb();
        let query = "SELECT * FROM context_sources WHERE deleted_at IS NULL AND (source_type <> 'bookmark' OR is_latest = TRUE)";
        const params: any[] = [];

        if (spaceIds && spaceIds.length > 0) {
            const placeholders = spaceIds.map((_, idx) => `$${params.length + idx + 1}`).join(",");
            params.push(...spaceIds);
            query += ` AND space_id IN (${placeholders})`;
        }

        if (sourceTypes && sourceTypes.length > 0) {
            const placeholders = sourceTypes.map((_, idx) => `$${params.length + idx + 1}`).join(",");
            params.push(...sourceTypes);
            query += ` AND source_type IN (${placeholders})`;
        }

        query += " ORDER BY created_at DESC";
        const res = await db.query(query, params);
        return res.rows as ContextSource[];
    },

    async getContextSource(sourceId: string): Promise<ContextSource | null> {
        const db = getDb();
        const res = await db.query(
            "SELECT * FROM context_sources WHERE id = $1 LIMIT 1",
            [sourceId]
        );
        return (res.rows[0] as ContextSource) || null;
    },

    async softDeleteContextSource(sourceId: string): Promise<string[]> {
        const db = getDb();
        const sourceRes = await db.query(
            `SELECT id, source_type, space_id, source_group_key, canonical_uri
             FROM context_sources
             WHERE id = $1
             LIMIT 1`,
            [sourceId]
        );
        if (sourceRes.rows.length === 0) return [];

        const source = sourceRes.rows[0] as any;

        if (source.source_type === 'bookmark') {
            const groupKey = source.source_group_key || source.id;
            const canonical = source.canonical_uri || null;
            const groupRes = await db.query(
                `SELECT id
                 FROM context_sources
                 WHERE source_type = 'bookmark'
                   AND space_id = $1
                   AND deleted_at IS NULL
                   AND (
                     source_group_key = $2
                     OR ($3::text IS NOT NULL AND canonical_uri = $3::text)
                   )`,
                [source.space_id, groupKey, canonical]
            );
            const ids = groupRes.rows.map((r: any) => r.id as string);
            if (ids.length === 0) return [];

            const placeholders = ids.map((_, idx) => `$${idx + 1}`).join(",");
            await db.query(
                `UPDATE context_sources
                 SET deleted_at = NOW(),
                     updated_at = NOW(),
                     is_latest = FALSE
                 WHERE id IN (${placeholders})`,
                ids
            );

            // Hard-delete all segments and assets for these source versions immediately.
            // The FK has ON DELETE CASCADE but that only fires on a hard DELETE of the source row.
            // Since we soft-delete (just set deleted_at), we must clean up children explicitly.
            if (ids.length > 0) {
                const ph = ids.map((_, i) => `$${i + 1}`).join(",");
                await db.query(`DELETE FROM context_segments WHERE source_id IN (${ph})`, ids);
                await db.query(`DELETE FROM context_assets WHERE source_id IN (${ph})`, ids);
            }

            return ids;
        }

        await db.query(
            `UPDATE context_sources
             SET deleted_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [sourceId]
        );

        // Hard-delete segments and assets for non-bookmark sources too
        await db.query(`DELETE FROM context_segments WHERE source_id = $1`, [sourceId]);
        await db.query(`DELETE FROM context_assets WHERE source_id = $1`, [sourceId]);

        return [sourceId];
    },

    /**
     * One-shot cleanup: hard-deletes segments and assets that belong to already soft-deleted
     * sources. Run once to purge the backlog accumulated before this fix.
     */
    async purgeOrphanedSegments(): Promise<{ segments: number; assets: number }> {
        const db = getDb();
        const segRes = await db.query(
            `DELETE FROM context_segments
             WHERE source_id IN (
                 SELECT id FROM context_sources WHERE deleted_at IS NOT NULL
             )`
        );
        const assetRes = await db.query(
            `DELETE FROM context_assets
             WHERE source_id IN (
                 SELECT id FROM context_sources WHERE deleted_at IS NOT NULL
             )`
        );
        const segments = (segRes as any).affectedRows ?? (segRes.rows?.length ?? 0);
        const assets = (assetRes as any).affectedRows ?? (assetRes.rows?.length ?? 0);
        console.log(`[purgeOrphanedSegments] Removed ${segments} segments and ${assets} assets from soft-deleted sources.`);
        return { segments, assets };
    },

    async getContextSegmentsBySource(sourceId: string): Promise<ContextSegment[]> {
        const db = getDb();
        const res = await db.query(
            `SELECT * FROM context_segments
             WHERE source_id = $1
             ORDER BY COALESCE(page_number, 0), segment_index`,
            [sourceId]
        );
        return res.rows as ContextSegment[];
    },

    async getContextExplorerItems(spaceIds?: string[], sourceTypes?: ContextSourceType[]): Promise<ContextExplorerItem[]> {
        const db = getDb();
        const params: any[] = [];
        let whereClause = "WHERE src.deleted_at IS NULL AND (src.source_type <> 'bookmark' OR src.is_latest = TRUE)";

        if (spaceIds && spaceIds.length > 0) {
            const placeholders = spaceIds.map((_, idx) => `$${params.length + idx + 1}`).join(",");
            params.push(...spaceIds);
            whereClause += ` AND src.space_id IN (${placeholders})`;
        }

        if (sourceTypes && sourceTypes.length > 0) {
            const placeholders = sourceTypes.map((_, idx) => `$${params.length + idx + 1}`).join(",");
            params.push(...sourceTypes);
            whereClause += ` AND src.source_type IN (${placeholders})`;
        }

        const query = `
            SELECT
                src.id,
                src.source_type,
                src.title,
                src.status,
                src.space_id,
                sp.name as space_name,
                src.original_uri,
                src.canonical_uri,
                src.summary,
                src.legacy_document_id,
                src.created_at,
                src.updated_at,
                COALESCE(COUNT(seg.id), 0) as segment_count,
                COALESCE(MAX(seg.page_number), 0) as max_page_number,
                COALESCE(doc.total_pages, 0) as total_pages
            FROM context_sources src
            LEFT JOIN context_spaces sp ON sp.id = src.space_id
            LEFT JOIN context_segments seg ON seg.source_id = src.id
            LEFT JOIN documents doc ON doc.id = src.legacy_document_id
            ${whereClause}
            GROUP BY src.id, sp.name, doc.total_pages
            ORDER BY src.created_at DESC
        `;

        const res = await db.query(query, params);
        return res.rows.map((row: any) => ({
            id: row.id,
            source_type: row.source_type,
            title: row.title,
            status: row.status,
            space_id: row.space_id,
            space_name: row.space_name,
            original_uri: row.original_uri,
            canonical_uri: row.canonical_uri,
            summary: row.summary,
            legacy_document_id: row.legacy_document_id,
            segment_count: Number(row.segment_count || 0),
            max_page_number: Number(row.max_page_number || 0),
            total_pages: Number(row.total_pages || 0),
            created_at: row.created_at,
            updated_at: row.updated_at
        })) as ContextExplorerItem[];
    },

    async semanticContextSourceSearch(queryEmbedding: number[], spaceIds?: string[], sourceTypes?: ContextSourceType[]): Promise<string[]> {
        const targetSpaces = spaceIds && spaceIds.length > 0
            ? spaceIds
            : (await this.getContextSpaces()).map(s => s.id);

        if (targetSpaces.length === 0) return [];
        const rows = await this.getTopContextSourcesByEmbedding(queryEmbedding, targetSpaces, sourceTypes, 200);
        return rows.map(r => r.source_id);
    },

    async getTopContextSourcesByEmbedding(queryEmbedding: number[], spaceIds: string[], sourceTypes?: ContextSourceType[], limit: number = 40): Promise<Array<{ source_id: string; source_score: number }>> {
        const db = getDb();
        const embStr = JSON.stringify(queryEmbedding);
        const params: any[] = [embStr];
        const spacePlaceholders = spaceIds.map((_, idx) => `$${params.length + idx + 1}`).join(",");
        params.push(...spaceIds);
        let query = `
            SELECT id as source_id, 1 - (source_embedding <=> $1) as source_score
            FROM context_sources
            WHERE deleted_at IS NULL
              AND source_embedding IS NOT NULL
              AND (source_type <> 'bookmark' OR is_latest = TRUE)
              AND space_id IN (${spacePlaceholders})
        `;

        if (sourceTypes && sourceTypes.length > 0) {
            const typePlaceholders = sourceTypes.map((_, idx) => `$${params.length + idx + 1}`).join(",");
            params.push(...sourceTypes);
            query += ` AND source_type IN (${typePlaceholders})`;
        }

        params.push(limit);
        query += ` ORDER BY source_score DESC LIMIT $${params.length};`;

        const res = await db.query(query, params);
        return res.rows.map((r: any) => ({
            source_id: r.source_id as string,
            source_score: Number(r.source_score || 0)
        }));
    },

    async getTopContextSegmentsByEmbedding(params: {
        queryEmbedding: number[];
        sourceIds: string[];
        sourceTypes?: ContextSourceType[];
        segmentTypes?: ContextSegment['segment_type'][];
        limit?: number;
    }): Promise<RetrievedContextItem[]> {
        const db = getDb();
        if (!params.sourceIds || params.sourceIds.length === 0) return [];

        const embStr = JSON.stringify(params.queryEmbedding);
        const queryParams: any[] = [embStr];
        const sourcePlaceholders = params.sourceIds.map((_, idx) => `$${queryParams.length + idx + 1}`).join(",");
        queryParams.push(...params.sourceIds);
        let query = `
            SELECT
                seg.id,
                seg.source_id,
                src.source_type,
                src.space_id,
                src.title,
                src.legacy_document_id,
                src.original_uri,
                src.canonical_uri,
                src.created_at as source_created_at,
                seg.page_number,
                seg.segment_type,
                seg.segment_index,
                seg.locator_json,
                seg.text_content,
                seg.structured_json,
                seg.created_at as segment_created_at,
                1 - (seg.embedding <=> $1) as similarity_score
            FROM context_segments seg
            JOIN context_sources src ON src.id = seg.source_id
            WHERE src.deleted_at IS NULL
              AND (src.source_type <> 'bookmark' OR src.is_latest = TRUE)
              AND seg.embedding IS NOT NULL
              AND seg.source_id IN (${sourcePlaceholders})
        `;

        if (params.sourceTypes && params.sourceTypes.length > 0) {
            const typePlaceholders = params.sourceTypes.map((_, idx) => `$${queryParams.length + idx + 1}`).join(",");
            queryParams.push(...params.sourceTypes);
            query += ` AND src.source_type IN (${typePlaceholders})`;
        }

        if (params.segmentTypes && params.segmentTypes.length > 0) {
            const segTypePlaceholders = params.segmentTypes.map((_, idx) => `$${queryParams.length + idx + 1}`).join(",");
            queryParams.push(...params.segmentTypes);
            query += ` AND seg.segment_type IN (${segTypePlaceholders})`;
        }

        queryParams.push(params.limit || 120);
        query += ` ORDER BY similarity_score DESC LIMIT $${queryParams.length};`;

        const res = await db.query(query, queryParams);
        return res.rows.map((row: any) => {
            let locator = row.locator_json;
            if (typeof locator === "string") {
                try {
                    locator = JSON.parse(locator);
                } catch {
                    locator = null;
                }
            }
            let structured = row.structured_json;
            if (typeof structured === "string") {
                try {
                    structured = JSON.parse(structured);
                } catch {
                    structured = null;
                }
            }
            const structuredSummary = structured && typeof structured === "object"
                ? (structured.summary || structured.section_summary || structured.source_summary || null)
                : null;
            const structuredRawText = structured && typeof structured === "object"
                ? (structured.raw_text || null)
                : null;
            const locationLabel = row.page_number
                ? `Page ${row.page_number}`
                : (structured && typeof structured === "object" && structured.heading
                    ? `${row.segment_type}: ${structured.heading}`
                    : row.segment_type);

            return {
                id: row.id,
                source_id: row.source_id,
                source_type: row.source_type,
                space_id: row.space_id,
                title: row.title,
                segment_type: row.segment_type,
                segment_index: Number(row.segment_index || 0),
                location_label: locationLabel,
                text_summary: structuredSummary || row.text_content,
                raw_text: structuredRawText || row.text_content,
                document_id: row.legacy_document_id || null,
                structured_payload: structured,
                similarity_score: Number(row.similarity_score || 0),
                citation_payload: {
                    source_id: row.source_id,
                    source_type: row.source_type,
                    title: row.title,
                    page_number: row.page_number,
                    original_uri: row.original_uri,
                    canonical_uri: row.canonical_uri,
                    asset_id: locator && typeof locator === "object" ? (locator.asset_id || null) : null,
                    tag_name: locator && typeof locator === "object" ? (locator.tag_name || null) : null,
                    section_id: structured && typeof structured === "object" ? (structured.section_id || null) : null,
                    paragraph_id: structured && typeof structured === "object" ? (structured.paragraph_id || null) : null,
                    channel: structured && typeof structured === "object" ? (structured.channel || null) : null
                },
                _rank_meta: {
                    source_created_at: row.source_created_at,
                    segment_created_at: row.segment_created_at
                }
            };
        }) as RetrievedContextItem[];
    },

    async getTopContextSegmentsByEmbeddingAcrossSpaces(params: {
        queryEmbedding: number[];
        spaceIds: string[];
        sourceTypes?: ContextSourceType[];
        segmentTypes?: ContextSegment['segment_type'][];
        limit?: number;
    }): Promise<RetrievedContextItem[]> {
        const db = getDb();
        if (!params.spaceIds || params.spaceIds.length === 0) return [];

        const embStr = JSON.stringify(params.queryEmbedding);
        const queryParams: any[] = [embStr];
        const spacePlaceholders = params.spaceIds.map((_, idx) => `$${queryParams.length + idx + 1}`).join(",");
        queryParams.push(...params.spaceIds);

        let query = `
            SELECT
                seg.id,
                seg.source_id,
                src.source_type,
                src.space_id,
                src.title,
                src.legacy_document_id,
                src.original_uri,
                src.canonical_uri,
                src.created_at as source_created_at,
                seg.page_number,
                seg.segment_type,
                seg.segment_index,
                seg.locator_json,
                seg.text_content,
                seg.structured_json,
                seg.created_at as segment_created_at,
                1 - (seg.embedding <=> $1) as similarity_score
            FROM context_segments seg
            JOIN context_sources src ON src.id = seg.source_id
            WHERE src.deleted_at IS NULL
              AND (src.source_type <> 'bookmark' OR src.is_latest = TRUE)
              AND seg.embedding IS NOT NULL
              AND src.space_id IN (${spacePlaceholders})
        `;

        if (params.sourceTypes && params.sourceTypes.length > 0) {
            const typePlaceholders = params.sourceTypes.map((_, idx) => `$${queryParams.length + idx + 1}`).join(",");
            queryParams.push(...params.sourceTypes);
            query += ` AND src.source_type IN (${typePlaceholders})`;
        }

        if (params.segmentTypes && params.segmentTypes.length > 0) {
            const segTypePlaceholders = params.segmentTypes.map((_, idx) => `$${queryParams.length + idx + 1}`).join(",");
            queryParams.push(...params.segmentTypes);
            query += ` AND seg.segment_type IN (${segTypePlaceholders})`;
        }

        queryParams.push(params.limit || 120);
        query += ` ORDER BY similarity_score DESC LIMIT $${queryParams.length};`;

        const res = await db.query(query, queryParams);
        return res.rows.map((row: any) => {
            let locator = row.locator_json;
            if (typeof locator === "string") {
                try {
                    locator = JSON.parse(locator);
                } catch {
                    locator = null;
                }
            }
            let structured = row.structured_json;
            if (typeof structured === "string") {
                try {
                    structured = JSON.parse(structured);
                } catch {
                    structured = null;
                }
            }
            const structuredSummary = structured && typeof structured === "object"
                ? (structured.summary || structured.section_summary || structured.source_summary || null)
                : null;
            const structuredRawText = structured && typeof structured === "object"
                ? (structured.raw_text || null)
                : null;
            const locationLabel = row.page_number
                ? `Page ${row.page_number}`
                : (structured && typeof structured === "object" && structured.heading
                    ? `${row.segment_type}: ${structured.heading}`
                    : row.segment_type);

            return {
                id: row.id,
                source_id: row.source_id,
                source_type: row.source_type,
                space_id: row.space_id,
                title: row.title,
                segment_type: row.segment_type,
                segment_index: Number(row.segment_index || 0),
                location_label: locationLabel,
                text_summary: structuredSummary || row.text_content,
                raw_text: structuredRawText || row.text_content,
                document_id: row.legacy_document_id || null,
                structured_payload: structured,
                similarity_score: Number(row.similarity_score || 0),
                citation_payload: {
                    source_id: row.source_id,
                    source_type: row.source_type,
                    title: row.title,
                    page_number: row.page_number,
                    original_uri: row.original_uri,
                    canonical_uri: row.canonical_uri,
                    asset_id: locator && typeof locator === "object" ? (locator.asset_id || null) : null,
                    tag_name: locator && typeof locator === "object" ? (locator.tag_name || null) : null,
                    section_id: structured && typeof structured === "object" ? (structured.section_id || null) : null,
                    paragraph_id: structured && typeof structured === "object" ? (structured.paragraph_id || null) : null,
                    channel: structured && typeof structured === "object" ? (structured.channel || null) : null
                },
                _rank_meta: {
                    source_created_at: row.source_created_at,
                    segment_created_at: row.segment_created_at
                }
            };
        }) as RetrievedContextItem[];
    },

    async getTopContextSegmentsByLexicalAcrossSpaces(params: {
        queryText: string;
        spaceIds: string[];
        sourceTypes?: ContextSourceType[];
        segmentTypes?: ContextSegment['segment_type'][];
        limit?: number;
    }): Promise<RetrievedContextItem[]> {
        const db = getDb();
        const queryText = String(params.queryText || "").trim();
        if (!queryText || !params.spaceIds || params.spaceIds.length === 0) return [];

        const tokenized = queryText
            .toLowerCase()
            .split(/[^a-z0-9_]+/g)
            .map((t) => t.trim())
            .filter((t) => t.length >= 2);
        const uniqueTerms = Array.from(new Set(tokenized)).slice(0, 8);
        if (uniqueTerms.length === 0) return [];

        const queryParams: any[] = [];
        const spacePlaceholders = params.spaceIds.map((_, idx) => `$${idx + 1}`).join(",");
        queryParams.push(...params.spaceIds);

        const lexicalTerms = uniqueTerms.map((term) => `%${term}%`);
        const fullQueryLike = `%${queryText.toLowerCase()}%`;
        const lexicalStart = queryParams.length + 1;
        queryParams.push(...lexicalTerms, fullQueryLike);
        const searchableExpr = `LOWER(CONCAT_WS(' ',
            seg.text_content,
            COALESCE(seg.structured_json->>'raw_text', ''),
            COALESCE(seg.structured_json->>'summary', ''),
            COALESCE(seg.structured_json->>'heading', ''),
            COALESCE(seg.structured_json->>'section_summary', ''),
            COALESCE(seg.structured_json->>'inherited_heading', '')
        ))`;

        const lexicalMatchConditions = lexicalTerms
            .map((_, idx) => `${searchableExpr} LIKE $${lexicalStart + idx}`)
            .concat([`${searchableExpr} LIKE $${lexicalStart + lexicalTerms.length}`]);

        const lexicalScoreParts = lexicalTerms
            .map((_, idx) => `CASE WHEN ${searchableExpr} LIKE $${lexicalStart + idx} THEN 1 ELSE 0 END`)
            .concat([
                `CASE WHEN ${searchableExpr} LIKE $${lexicalStart + lexicalTerms.length} THEN 2 ELSE 0 END`,
                `CASE WHEN COALESCE(seg.locator_json->>'tag_name', '') IN ('pre','code') THEN 0.4 ELSE 0 END`,
            ]);

        let query = `
            SELECT
                seg.id,
                seg.source_id,
                src.source_type,
                src.space_id,
                src.title,
                src.legacy_document_id,
                src.original_uri,
                src.canonical_uri,
                src.created_at as source_created_at,
                seg.page_number,
                seg.segment_type,
                seg.segment_index,
                seg.locator_json,
                seg.text_content,
                seg.structured_json,
                seg.created_at as segment_created_at,
                (${lexicalScoreParts.join(" + ")}) as lexical_score
            FROM context_segments seg
            JOIN context_sources src ON src.id = seg.source_id
            WHERE src.deleted_at IS NULL
              AND (src.source_type <> 'bookmark' OR src.is_latest = TRUE)
              AND src.space_id IN (${spacePlaceholders})
              AND (${lexicalMatchConditions.join(" OR ")})
        `;

        if (params.sourceTypes && params.sourceTypes.length > 0) {
            const typePlaceholders = params.sourceTypes.map((_, idx) => `$${queryParams.length + idx + 1}`).join(",");
            queryParams.push(...params.sourceTypes);
            query += ` AND src.source_type IN (${typePlaceholders})`;
        }

        if (params.segmentTypes && params.segmentTypes.length > 0) {
            const segTypePlaceholders = params.segmentTypes.map((_, idx) => `$${queryParams.length + idx + 1}`).join(",");
            queryParams.push(...params.segmentTypes);
            query += ` AND seg.segment_type IN (${segTypePlaceholders})`;
        }

        queryParams.push(params.limit || 80);
        query += ` ORDER BY lexical_score DESC, seg.created_at DESC LIMIT $${queryParams.length};`;

        const res = await db.query(query, queryParams);
        return res.rows.map((row: any) => {
            let locator = row.locator_json;
            if (typeof locator === "string") {
                try {
                    locator = JSON.parse(locator);
                } catch {
                    locator = null;
                }
            }
            let structured = row.structured_json;
            if (typeof structured === "string") {
                try {
                    structured = JSON.parse(structured);
                } catch {
                    structured = null;
                }
            }
            const structuredSummary = structured && typeof structured === "object"
                ? (structured.summary || structured.section_summary || structured.source_summary || null)
                : null;
            const structuredRawText = structured && typeof structured === "object"
                ? (structured.raw_text || null)
                : null;
            const locationLabel = row.page_number
                ? `Page ${row.page_number}`
                : (structured && typeof structured === "object" && structured.heading
                    ? `${row.segment_type}: ${structured.heading}`
                    : row.segment_type);
            const lexicalScore = Number(row.lexical_score || 0);
            const normalizedScore = Math.max(0, Math.min(1, lexicalScore / 5));

            return {
                id: row.id,
                source_id: row.source_id,
                source_type: row.source_type,
                space_id: row.space_id,
                title: row.title,
                segment_type: row.segment_type,
                segment_index: Number(row.segment_index || 0),
                location_label: locationLabel,
                text_summary: structuredSummary || row.text_content,
                raw_text: structuredRawText || row.text_content,
                document_id: row.legacy_document_id || null,
                structured_payload: structured,
                similarity_score: normalizedScore,
                citation_payload: {
                    source_id: row.source_id,
                    source_type: row.source_type,
                    title: row.title,
                    page_number: row.page_number,
                    original_uri: row.original_uri,
                    canonical_uri: row.canonical_uri,
                    asset_id: locator && typeof locator === "object" ? (locator.asset_id || null) : null,
                    tag_name: locator && typeof locator === "object" ? (locator.tag_name || null) : null,
                    section_id: structured && typeof structured === "object" ? (structured.section_id || null) : null,
                    paragraph_id: structured && typeof structured === "object" ? (structured.paragraph_id || null) : null,
                    channel: structured && typeof structured === "object" ? (structured.channel || null) : null
                },
                _rank_meta: {
                    source_created_at: row.source_created_at,
                    segment_created_at: row.segment_created_at
                }
            };
        }) as RetrievedContextItem[];
    },

    async saveDevPageExtraction(params: {
        url: string;
        title?: string | null;
        source?: string;
        payload: Record<string, any>;
    }): Promise<string> {
        const db = getDb();
        const payload = params.payload || {};
        const nodeCount = Number(payload.node_count || (Array.isArray(payload.hierarchy) ? payload.hierarchy.length : 0) || 0);
        const linkCount = Number(Array.isArray(payload.hyperlinks) ? payload.hyperlinks.length : (payload.link_count || 0));
        const hierarchyText = typeof payload.hierarchy_text === "string" ? payload.hierarchy_text : null;
        const plainText = typeof payload.plain_text === "string" ? payload.plain_text : null;
        const res = await db.query(
            `INSERT INTO dev_page_extractions (
                url, title, source, payload_json, hierarchy_text, plain_text, node_count, link_count
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [
                params.url,
                params.title || null,
                params.source || "extension",
                JSON.stringify(payload),
                hierarchyText,
                plainText,
                Number.isFinite(nodeCount) ? nodeCount : 0,
                Number.isFinite(linkCount) ? linkCount : 0
            ]
        );
        return (res.rows[0] as any).id as string;
    },

    async getDevPageExtractions(limit: number = 100): Promise<DevPageExtraction[]> {
        const db = getDb();
        const safeLimit = Math.max(1, Math.min(500, Math.floor(limit || 100)));
        const res = await db.query(
            `SELECT id, url, title, source, payload_json, hierarchy_text, plain_text, node_count, link_count, created_at
             FROM dev_page_extractions
             ORDER BY created_at DESC
             LIMIT $1`,
            [safeLimit]
        );
        return res.rows.map((row: any) => ({
            ...row,
            payload_json: typeof row.payload_json === "string" ? JSON.parse(row.payload_json || "{}") : (row.payload_json || {})
        })) as DevPageExtraction[];
    },

    async getDevPageExtraction(id: string): Promise<DevPageExtraction | null> {
        const db = getDb();
        const res = await db.query(
            `SELECT id, url, title, source, payload_json, hierarchy_text, plain_text, node_count, link_count, created_at
             FROM dev_page_extractions
             WHERE id = $1
             LIMIT 1`,
            [id]
        );
        if (res.rows.length === 0) return null;
        const row: any = res.rows[0];
        return {
            ...row,
            payload_json: typeof row.payload_json === "string" ? JSON.parse(row.payload_json || "{}") : (row.payload_json || {})
        } as DevPageExtraction;
    },

    async deleteDevPageExtraction(id: string): Promise<void> {
        const db = getDb();
        await db.query("DELETE FROM dev_page_extractions WHERE id = $1", [id]);
    },

    async saveChatScopeSelection(scopeKey: string, selectedSpaceIds: string[], selectedSourceTypes: ContextSourceType[]): Promise<void> {
        const db = getDb();
        await db.query(
            `INSERT INTO chat_scope_selections (scope_key, selected_space_ids, selected_source_types)
             VALUES ($1, $2, $3)
             ON CONFLICT (scope_key)
             DO UPDATE SET
                selected_space_ids = EXCLUDED.selected_space_ids,
                selected_source_types = EXCLUDED.selected_source_types,
                updated_at = NOW()`,
            [scopeKey, JSON.stringify(selectedSpaceIds), JSON.stringify(selectedSourceTypes)]
        );
    },

    async getChatScopeSelection(scopeKey: string): Promise<{ selected_space_ids: string[]; selected_source_types: ContextSourceType[] } | null> {
        const db = getDb();
        const res = await db.query(
            "SELECT selected_space_ids, selected_source_types FROM chat_scope_selections WHERE scope_key = $1 LIMIT 1",
            [scopeKey]
        );
        if (res.rows.length === 0) return null;

        const row = res.rows[0] as any;
        const parsedSpaceIds = Array.isArray(row.selected_space_ids)
            ? row.selected_space_ids
            : (typeof row.selected_space_ids === "string" ? JSON.parse(row.selected_space_ids || "[]") : []);
        const parsedSourceTypes = Array.isArray(row.selected_source_types)
            ? row.selected_source_types
            : (typeof row.selected_source_types === "string" ? JSON.parse(row.selected_source_types || "[]") : []);
        return {
            selected_space_ids: parsedSpaceIds,
            selected_source_types: (parsedSourceTypes.length > 0 ? parsedSourceTypes : ['pdf', 'bookmark', 'snip']) as ContextSourceType[]
        };
    }
};
