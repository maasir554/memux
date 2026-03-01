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
    legacy_document_id?: string | null;
    created_at: string;
    updated_at: string;
    deleted_at?: string | null;
}

export interface ContextSegment {
    id: string;
    source_id: string;
    segment_type: 'table_row' | 'paragraph' | 'ocr_block' | 'caption';
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

export interface RetrievedContextItem {
    id: string;
    source_id: string;
    source_type: ContextSourceType;
    space_id: string;
    title: string;
    location_label: string;
    text_summary: string;
    structured_payload?: any;
    similarity_score: number;
    citation_payload: {
        source_id: string;
        source_type: ContextSourceType;
        title: string;
        page_number?: number | null;
        original_uri?: string | null;
        canonical_uri?: string | null;
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
    }
};
