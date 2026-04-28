import { create } from 'zustand';
import { dbService } from '@/services/db-service';
import { extractionService } from '@/services/extraction-service';
import { pdfStore } from '@/services/pdf-store';
import { apiService, type BookmarkStructuredSection } from '@/services/api-service';

export type ContextSourceType = 'pdf' | 'bookmark' | 'snip';

export type JobStatus = 'queued' | 'processing' | 'paused' | 'completed' | 'error';

export interface ExtractionJob {
    documentId: string;
    filename: string;
    jobType?: 'pdf' | 'bookmark' | 'snip';
    sourceId?: string;
    sourceType?: ContextSourceType;
    sourceUrl?: string;
    status: JobStatus;
    totalPages: number;
    processedPages: number;
    progressLabel?: string;
    createdAt?: string;
    error?: string;
    file?: File;
    debugInfo?: Record<number, { ocrText: string, prompt: string, rawResponse: string }>;
    extractedChunks?: string[];
    dismissed_from_queue?: boolean;
}

export interface TrashedJob {
    documentId: string;
    filename: string;
    totalPages: number;
    processedPages: number;
    deletedAt: string;
    status: JobStatus;
}

const TRASH_DURATION_KEY = 'maxcavator-trash-duration-hours';

const buildInitialContextFromStructuredSections = (sections: BookmarkStructuredSection[] | undefined, sourceTitle: string, bookmarkSummary: string) => {
    const ocrSections = (sections || []).filter((section) => (section.channel || 'html') === 'ocr');
    const tailSection = (ocrSections.length > 0 ? ocrSections[ocrSections.length - 1] : (sections || [])[Math.max(0, (sections || []).length - 1)]) || null;
    if (!tailSection) {
        return {
            previous_screenshot_heading: sourceTitle,
            previous_screenshot_summary: bookmarkSummary,
            previous_tail_chunks: [],
            previous_context_prefix: [sourceTitle, bookmarkSummary].filter(Boolean)
        };
    }

    return {
        previous_screenshot_heading: tailSection.heading || sourceTitle,
        previous_screenshot_summary: tailSection.summary || bookmarkSummary,
        previous_tail_chunks: (tailSection.paragraphs || []).slice(-2).map((paragraph) => ({
            heading: paragraph.heading || tailSection.heading || sourceTitle,
            summary: paragraph.summary || paragraph.text.slice(0, 220),
            text: paragraph.text,
            layout_hint: paragraph.layout_hint || 'bottom'
        })),
        previous_context_prefix: (tailSection.context_prefix && tailSection.context_prefix.length > 0)
            ? tailSection.context_prefix
            : [sourceTitle, tailSection.heading || sourceTitle].filter(Boolean)
    };
};

const buildTraceVectorText = (
    sourceTitle: string,
    summary: string,
    topicCrumbs?: string[]
) => {
    const title = (sourceTitle || '').trim();
    const crumbs = (topicCrumbs || []).filter(c => c && c.trim()).join(' › ');
    const prefix = crumbs ? `${title} › ${crumbs}` : title;
    return `(${prefix}: ${String(summary || '').trim()})`;
};

interface ExtractionState {
    jobs: Record<string, ExtractionJob>;
    contextJobs: Record<string, ExtractionJob>;
    trashedJobs: Record<string, TrashedJob>;
    trashAutoDeleteHours: number;
    totalTables: number;
    isLoading: boolean;
    loadJobs: () => Promise<void>;
    addJob: (file: File, sourceUrl?: string) => Promise<void>;
    addJobFromUrl: (url: string, customFilename?: string) => Promise<void>;
    startJob: (docId: string) => Promise<void>;
    updateJob: (id: string, updates: Partial<ExtractionJob>) => void;
    pauseJob: (id: string) => void;
    resumeJob: (id: string) => void;
    dismissJob: (id: string) => Promise<void>;
    trashJob: (id: string) => Promise<void>;
    restoreJob: (id: string) => Promise<void>;
    permanentlyDeleteJob: (id: string) => Promise<void>;
    emptyTrash: () => Promise<void>;
    setTrashAutoDeleteHours: (hours: number) => void;
    testPage: (docId: string, pageNum: number) => Promise<{ text: string, imageBlob: Blob }>;
    renderPage: (docId: string, pageNum: number) => Promise<{ imageBlob: Blob }>;
    extractPdfText: (docId: string, pageNum: number) => Promise<{ text: string }>;
    testAi: (text: string) => Promise<{ tables: any[], debug_info?: any }>;
    _processJob: (file: File, docId: string, startPage: number) => Promise<void>;
    focusedDocumentIds: string[];
    setFocusedDocumentIds: (ids: string[]) => void;
    focusedSpaceIds: string[];
    setFocusedSpaceIds: (ids: string[]) => void;
    focusedSourceTypes: ContextSourceType[];
    setFocusedSourceTypes: (types: ContextSourceType[]) => void;
    updateContextJob: (id: string, updates: Partial<ExtractionJob>) => void;
    dismissContextJob: (id: string) => void;
    addScreenSnipToContext: (file: File, spaceId?: string, title?: string) => Promise<string>;
    addBookmarkToContext: (url: string, spaceId?: string, supplementalScreenshots?: File[]) => Promise<string>;
    addDevExtractionToContext: (extractionId: string, spaceId?: string) => Promise<string>;
}

export const useExtractionStore = create<ExtractionState>((set, get) => ({
    jobs: {},
    contextJobs: {},
    trashedJobs: {},
    trashAutoDeleteHours: parseInt(localStorage.getItem(TRASH_DURATION_KEY) || '5', 10),
    totalTables: 0,
    isLoading: true,
    focusedDocumentIds: [],
    setFocusedDocumentIds: (ids) => set({ focusedDocumentIds: ids }),
    focusedSpaceIds: [],
    setFocusedSpaceIds: (ids) => set({ focusedSpaceIds: ids }),
    focusedSourceTypes: ['pdf', 'bookmark', 'snip'],
    setFocusedSourceTypes: (types) => set({ focusedSourceTypes: types }),
    updateContextJob: (id, updates) => set((state) => ({
        contextJobs: {
            ...state.contextJobs,
            [id]: { ...state.contextJobs[id], ...updates }
        }
    })),
    dismissContextJob: (id) => set((state) => {
        const existing = state.contextJobs[id];
        if (!existing) return state;
        return {
            contextJobs: {
                ...state.contextJobs,
                [id]: { ...existing, dismissed_from_queue: true }
            }
        };
    }),

    loadJobs: async () => {
        try {
            await dbService.getDefaultContextSpace();

            // Auto-purge expired trash
            const hours = get().trashAutoDeleteHours;
            const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
            const purgedIds = await dbService.purgeExpiredTrash(cutoff);
            for (const id of purgedIds) {
                await pdfStore.deletePdf(id);
            }
            if (purgedIds.length > 0) {
                console.log(`Auto-purged ${purgedIds.length} expired trashed document(s)`);
            }

            // Load active documents
            const docs = await dbService.getAllDocuments();
            const jobs: Record<string, ExtractionJob> = {};

            for (const doc of docs) {
                const file = await pdfStore.getPdf(doc.id);
                const status = doc.status === 'processing' ? 'paused' : doc.status as JobStatus;

                jobs[doc.id] = {
                    documentId: doc.id,
                    filename: doc.filename,
                    jobType: 'pdf',
                    status,
                    totalPages: doc.total_pages,
                    processedPages: doc.processed_pages,
                    createdAt: doc.created_at,
                    file: file ?? undefined,
                    dismissed_from_queue: doc.dismissed_from_queue || false,
                };
            }

            // Load trashed documents
            const trashedDocs = await dbService.getTrashedDocuments();
            const trashedJobs: Record<string, TrashedJob> = {};
            for (const doc of trashedDocs) {
                trashedJobs[doc.id] = {
                    documentId: doc.id,
                    filename: doc.filename,
                    totalPages: doc.total_pages,
                    processedPages: doc.processed_pages,
                    deletedAt: doc.deleted_at!,
                    status: doc.status as JobStatus,
                };
            }

            // Fetch total table count
            const totalTables = await dbService.getTotalTableCount();

            set({ jobs, trashedJobs, totalTables, isLoading: false });
        } catch (e) {
            console.error('Failed to load jobs from database:', e);
            set({ isLoading: false });
        }
    },

    addJobFromUrl: async (url: string, customFilename?: string) => {
        try {
            // Try direct fetch first
            let res = await fetch(url).catch(() => null);

            // If failed or CORS error (often opaque response or throw), try proxy
            if (!res || !res.ok) {
                console.log("Direct fetch failed, trying proxy...");
                const proxyUrl = `http://localhost:8000/proxy_pdf?url=${encodeURIComponent(url)}`;
                res = await fetch(proxyUrl);
            }

            if (!res.ok) throw new Error("Failed to fetch PDF");

            const blob = await res.blob();
            const urlFilename = url.split('/').pop() || "downloaded_doc.pdf";
            const filename = customFilename ? `${customFilename}.pdf` : urlFilename;
            const file = new File([blob], filename, { type: "application/pdf" });

            await get().addJob(file, url);
        } catch (e: any) {
            console.error("Error adding job from URL", e);
            throw e;
        }
    },

    addJob: async (file: File, sourceUrl?: string) => {
        const docId = await dbService.addDocument(file.name, sourceUrl);

        // Persist the PDF blob to IndexedDB
        await pdfStore.savePdf(docId, file);
        await dbService.ensurePdfContextSource(docId);

        set((state) => ({
            jobs: {
                ...state.jobs,
                [docId]: {
                    documentId: docId,
                    filename: file.name,
                    jobType: 'pdf',
                    status: 'queued',
                    totalPages: 0,
                    processedPages: 0,
                    createdAt: new Date().toISOString(),
                    file: file
                }
            }
        }));
    },

    startJob: async (docId: string) => {
        const job = get().jobs[docId];
        if (job && job.file && (job.status === 'queued' || job.status === 'paused' || job.status === 'error')) {
            get()._processJob(job.file, docId, job.processedPages + 1);
        }
    },

    testPage: async (docId: string, pageNum: number) => {
        const job = get().jobs[docId];
        if (!job || !job.file) throw new Error("Document not found");

        // This will be implemented when we update the worker to support single page extraction
        // For now, we need to import the service dynamically to avoid circular deps if any
        const result = await extractionService.testPage(job.file, pageNum);
        return result;
    },

    renderPage: async (docId: string, pageNum: number) => {
        const job = get().jobs[docId];
        if (!job || !job.file) throw new Error("Document not found");

        const result = await extractionService.renderPage(job.file, pageNum);
        return result;
    },

    extractPdfText: async (docId: string, pageNum: number) => {
        const job = get().jobs[docId];
        if (!job || !job.file) throw new Error("Document not found");

        const result = await extractionService.extractPdfText(job.file, pageNum);
        return result;
    },

    testAi: async (text: string) => {
        return await apiService.extractTables(text);
    },

    addScreenSnipToContext: async (file: File, spaceId?: string, title?: string) => {
        const activityId = `snip:${Date.now()}`;
        set((state) => ({
            contextJobs: {
                ...state.contextJobs,
                [activityId]: {
                    documentId: activityId,
                    filename: title || file.name || 'Screen Snip',
                    jobType: 'snip',
                    sourceType: 'snip',
                    status: 'processing',
                    totalPages: 5,
                    processedPages: 0,
                    progressLabel: 'Preparing screen snip...',
                    createdAt: new Date().toISOString(),
                }
            }
        }));

        const defaultSpace = await dbService.getDefaultContextSpace();
        const targetSpaceId = spaceId || defaultSpace.id;

        const source = await dbService.createContextSource({
            spaceId: targetSpaceId,
            sourceType: 'snip',
            title: title || file.name || 'Screen Snip',
            status: 'processing',
            metadata: {
                filename: file.name,
                mime_type: file.type
            }
        });

        get().updateContextJob(activityId, {
            sourceId: source.id,
            status: 'processing',
            processedPages: 1,
            progressLabel: 'Saved image asset'
        });

        try {
            const assetId = await dbService.addContextAsset({
                sourceId: source.id,
                assetType: 'image',
                assetUri: `asset:${source.id}`,
                mimeType: file.type,
                byteSize: file.size,
                metadata: {
                    role: 'primary_screenshot',
                    filename: file.name
                }
            });
            await pdfStore.saveAsset(assetId, file, { name: file.name, type: file.type });

            const base64 = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });

            get().updateContextJob(activityId, {
                status: 'processing',
                processedPages: 2,
                progressLabel: 'Running OCR on snip'
            });
            const ocr = await apiService.visionOcr(base64);

            get().updateContextJob(activityId, {
                status: 'processing',
                processedPages: 3,
                progressLabel: 'Smart chunking snip text'
            });
            const smartChunkResp = await apiService.smartChunkSnip(ocr.text || "");
            let smartChunks = (smartChunkResp.chunks || []).filter(c => (c.text || "").trim());

            if (smartChunks.length === 0) {
                const fallback = await apiService.chunkContext('snip', [ocr.text || ""], { source_id: source.id });
                smartChunks = (fallback.chunks || []).filter(Boolean).map((text, index) => ({
                    heading: `Screen Snip Section ${index + 1}`,
                    text,
                    summary: text.slice(0, 220)
                }));
            }
            const screenshotSummary = (smartChunkResp.screenshot_summary || "").trim()
                || smartChunks.slice(0, 3).map(chunk => chunk.summary || chunk.text).join(" ").slice(0, 360);

            get().updateContextJob(activityId, {
                status: 'processing',
                processedPages: 4,
                progressLabel: `Created ${smartChunks.length} smart chunks`
            });

            const embeddingInputs: string[] = [];
            if (screenshotSummary) {
                embeddingInputs.push(screenshotSummary);
            }
            embeddingInputs.push(...smartChunks.map(chunk => chunk.summary || chunk.text));
            const allEmbeddings = embeddingInputs.length > 0
                ? await apiService.generateEmbeddings(embeddingInputs)
                : [];
            const snipSummaryEmbedding = screenshotSummary ? allEmbeddings[0] : null;
            const detailEmbeddings = screenshotSummary ? allEmbeddings.slice(1) : allEmbeddings;

            if (screenshotSummary) {
            await dbService.saveContextSegments({
                    sourceId: source.id,
                    segmentType: 'caption',
                    chunks: [{
                        text: screenshotSummary,
                        embedding: snipSummaryEmbedding || undefined,
                        pageNumber: 1,
                        index: 0,
                        locator: {
                            asset_id: assetId,
                            screenshot_id: assetId,
                            is_summary: true,
                            chunk_id: 'snip_summary'
                        },
                        structured: {
                            heading: 'Screenshot Summary',
                            summary: screenshotSummary,
                            screenshot_id: assetId,
                            chunk_id: 'snip_summary',
                            chunk_kind: 'snip_summary'
                        },
                        tokenCount: screenshotSummary.length
                    }]
                });
            }

            await dbService.saveContextSegments({
                sourceId: source.id,
                segmentType: 'ocr_block',
                chunks: smartChunks.map((chunk, index) => ({
                    text: chunk.text,
                    embedding: detailEmbeddings[index],
                    pageNumber: 1,
                    index: index + 1,
                    locator: {
                        asset_id: assetId,
                        screenshot_id: assetId,
                        chunk_ref: `snip_chunk_${index + 1}`,
                        chunk_id: `snip_chunk_${index + 1}`
                    },
                    structured: {
                        heading: chunk.heading,
                        summary: chunk.summary,
                        screenshot_id: assetId,
                        chunk_id: `snip_chunk_${index + 1}`,
                        source_snip_summary: screenshotSummary
                    },
                    tokenCount: chunk.text.length
                }))
            });

            await dbService.updateContextSource(source.id, {
                status: 'completed',
                sourceEmbedding: snipSummaryEmbedding || detailEmbeddings[0] || null,
                summary: screenshotSummary || smartChunks[0]?.summary || smartChunks[0]?.text?.slice(0, 220) || 'Screen snip captured'
            });

            get().updateContextJob(activityId, {
                status: 'completed',
                processedPages: 5,
                progressLabel: 'Screen snip indexed',
                debugInfo: {
                    1: {
                        ocrText: ocr.text || "",
                        prompt: "Vision OCR extraction",
                        rawResponse: JSON.stringify(ocr.debug_info || {}, null, 2)
                    },
                    2: {
                        ocrText: smartChunks.map(chunk => `[${chunk.heading}] ${chunk.text}`).join('\n\n'),
                        prompt: "Smart chunking result",
                        rawResponse: JSON.stringify({
                            screenshot_summary: screenshotSummary,
                            debug: smartChunkResp.debug_info || { chunk_count: smartChunks.length }
                        }, null, 2)
                    }
                },
                extractedChunks: [
                    ...(screenshotSummary ? [`[Screenshot Summary] ${screenshotSummary}`] : []),
                    ...smartChunks.map(chunk => `${chunk.heading}: ${chunk.text}`)
                ]
            });

            return source.id;
        } catch (error: any) {
            await dbService.updateContextSource(source.id, {
                status: 'error',
                metadata: {
                    ...(source.metadata_json || {}),
                    error: error?.message || 'Screen snip ingestion failed'
                }
            });
            get().updateContextJob(activityId, {
                status: 'error',
                error: error?.message || 'Screen snip ingestion failed',
                progressLabel: 'Screen snip failed'
            });
            throw error;
        }
    },

    addBookmarkToContext: async (url: string, spaceId?: string, supplementalScreenshots?: File[]) => {
        const activityId = `bookmark:${Date.now()}`;
        set((state) => ({
            contextJobs: {
                ...state.contextJobs,
                [activityId]: {
                    documentId: activityId,
                    filename: url,
                    jobType: 'bookmark',
                    sourceType: 'bookmark',
                    sourceUrl: url,
                    status: 'processing',
                    totalPages: 7,
                    processedPages: 0,
                    progressLabel: 'Capture: fetching webpage',
                    createdAt: new Date().toISOString(),
                }
            }
        }));

        const defaultSpace = await dbService.getDefaultContextSpace();
        const targetSpaceId = spaceId || defaultSpace.id;

        get().updateContextJob(activityId, {
            status: 'processing',
            processedPages: 1,
            progressLabel: 'Capture: website + screenshots'
        });
        let capture;
        try {
            capture = await apiService.captureBookmark(url, 'dual');
        } catch (error: any) {
            get().updateContextJob(activityId, {
                status: 'error',
                error: error?.message || 'Failed to capture website',
                progressLabel: 'Website capture failed'
            });
            throw error;
        }

        const canonical = capture.canonical_url || capture.original_url || url;

        const cleanText = (capture.text_blocks || []).join('\n\n');

        get().updateContextJob(activityId, {
            status: 'processing',
            processedPages: 2,
            progressLabel: 'Building Golden Hierarchy...'
        });

        let hierarchyFragments: any[] = [];
        try {
            const devFragmentsRes = await apiService.processDevBookmarkFragments({
                source_title: capture.title,
                raw_text: cleanText,
                hierarchy_text: JSON.stringify(capture.structured_blocks || [])
            });
            hierarchyFragments = devFragmentsRes.fragments || [];
        } catch (e) {
            console.error("Failed to build golden hierarchy", e);
        }

        const screenshotItems = (capture.screenshots || []).map((item) => ({
            image_base64: item.image_base64,
            mime_type: item.mime_type || 'image/png'
        }));
        const extraScreenshots = (supplementalScreenshots || []).filter((file) => file.type.startsWith('image/'));
        const totalSteps = Math.max(7, 5 + screenshotItems.length * 2 + extraScreenshots.length * 2);

        get().updateContextJob(activityId, { totalPages: totalSteps });

        // Infer a brand-aware title from the first screenshot using the vision model.
        // Prefer capture.screenshots (backend-captured), fall back to the extension's supplemental screenshots.
        let enrichedTitle = capture.title || canonical;
        let firstScreenshotBase64 = screenshotItems[0]?.image_base64;
        if (!firstScreenshotBase64 && extraScreenshots.length > 0) {
            // Convert the first supplemental File to base64
            const file = extraScreenshots[0];
            firstScreenshotBase64 = await new Promise<string>((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
                reader.onerror = () => resolve('');
                reader.readAsDataURL(file);
            });
        }
        console.log('[title inference] firstScreenshotBase64 available:', !!firstScreenshotBase64, '| raw title:', capture.title);
        if (firstScreenshotBase64) {
            get().updateContextJob(activityId, {
                status: 'processing',
                progressLabel: 'Inferring page title...'
            });
            enrichedTitle = await apiService.inferBookmarkTitle(firstScreenshotBase64, capture.title || '');
            console.log('[title inference] result:', enrichedTitle);
        }

        const source = await dbService.createBookmarkSourceVersion({
            spaceId: targetSpaceId,
            title: enrichedTitle,
            originalUri: capture.original_url || url,
            canonicalUri: canonical,
            status: 'processing',
            summary: enrichedTitle,
            metadata: capture.metadata || {},
            contentHash: capture.metadata?.signature || null,
            sourceEmbedding: null
        });

        let currentProcessed = 3;

        try {
            const screenshotAssetIdByIndex = new Map<number, string>();
            const allScreenshotResults: any[] = [];
            let previousContext: any = {};

            const blobToBase64 = async (blob: Blob): Promise<string> => {
                return await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
            };

            // Process auto-captured screenshots
            for (let i = 0; i < screenshotItems.length; i++) {
                currentProcessed++;
                const screenshot = screenshotItems[i];
                const b64 = screenshot.image_base64;
                const mimeType = screenshot.mime_type || 'image/png';
                const byteChars = atob(b64);
                const byteNumbers = new Array(byteChars.length);
                for (let j = 0; j < byteChars.length; j++) {
                    byteNumbers[j] = byteChars.charCodeAt(j);
                }
                const byteArray = new Uint8Array(byteNumbers);
                const blob = new Blob([byteArray], { type: mimeType });
                const extension = mimeType.includes("jpeg") ? "jpg"
                    : mimeType.includes("webp") ? "webp"
                        : mimeType.includes("gif") ? "gif"
                            : "png";

                get().updateContextJob(activityId, {
                    status: 'processing',
                    processedPages: currentProcessed,
                    progressLabel: `Analyzing Screenshot ${i + 1}/${screenshotItems.length}`
                });

                const assetId = await dbService.addContextAsset({
                    sourceId: source.id,
                    assetType: 'screenshot',
                    assetUri: `asset:${source.id}:screenshot:v${source.version_no || 1}:${i}`,
                    mimeType,
                    byteSize: blob.size,
                    metadata: { index: i, mime_type: mimeType, version_no: source.version_no || 1 }
                });
                await pdfStore.saveAsset(assetId, blob, { name: `bookmark-${source.id}-${i}.${extension}`, type: mimeType });
                screenshotAssetIdByIndex.set(i, assetId);

                const fused = await apiService.fuseScreenshotWithHierarchy({
                    ocr_text: '',
                    hierarchy_fragments: hierarchyFragments,
                    screenshot_index: i,
                    previous_context: previousContext,
                    base64_image: b64
                });

                allScreenshotResults.push({
                    ...fused,
                    asset_id: assetId
                });

                previousContext = {
                    previous_screenshot_heading: fused.screenshot_heading,
                    previous_screenshot_summary: fused.screenshot_summary,
                    previous_context_prefix: fused.chunks?.[fused.chunks.length - 1]?.context_prefix || [],
                    previous_tail_chunks: fused.chunks?.slice(-2) || []
                };
            }

            get().updateContextJob(activityId, {
                status: 'processing',
                processedPages: 3 + screenshotItems.length,
                progressLabel: 'LLM summaries: preparing embeddings'
            });

            const sections = allScreenshotResults.map((res: any) => ({
                section_id: `screenshot_${res.screenshot_index}`,
                heading: res.screenshot_heading || `Section ${res.screenshot_index + 1}`,
                summary: res.screenshot_summary || '',
                order: res.screenshot_index + 1,
                channel: 'ocr' as const,
                context_prefix: res.context_prefix || [],
                continued_from_previous: res.continued_from_previous || false,
                inherited_heading: res.inherited_heading || null,
                paragraphs: (res.chunks || []).map((chk: any, idx: number) => ({
                    paragraph_id: `screenshot_${res.screenshot_index}_chunk_${idx}`,
                    heading: chk.heading || res.screenshot_heading || `Section ${res.screenshot_index + 1}`,
                    summary: chk.summary || '',
                    text: chk.text || '',
                    order: idx + 1,
                    channel: 'ocr' as const,
                    context_prefix: chk.context_prefix || [],
                    layout_hint: chk.layout_hint || null,
                    continued_from_previous: chk.continued_from_previous || false,
                    inherited_heading: chk.inherited_heading || null,
                    mapped_html_fragment_id: chk.mapped_html_fragment_id || null,
                    screenshot_index: res.screenshot_index
                }))
            }));

            const bookmarkSummary = (capture.title || "").trim()
                || `Bookmark snapshot for ${canonical}`;

            get().updateContextJob(activityId, {
                status: 'processing',
                processedPages: 3 + screenshotItems.length,
                progressLabel: 'LLM summaries: preparing embeddings'
            });

            const paragraphSummaries: string[] = [];
            const paragraphTraceTexts: string[] = [];

            for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
                const section = sections[sectionIndex];
                for (const paragraph of section.paragraphs || []) {
                    const paragraphSummary = (paragraph.summary || "").trim() || paragraph.text.slice(0, 220);
                    paragraphSummaries.push(paragraphSummary);

                    const traceText = buildTraceVectorText(
                        capture.title || source.title || canonical,
                        paragraphSummary,
                        paragraph.context_prefix || section.context_prefix || []
                    );
                    paragraphTraceTexts.push(traceText);
                }
            }

            const embeddingInputs = [
                bookmarkSummary,
                ...paragraphTraceTexts
            ];
            const embedBatches = async (texts: string[], batchSize: number = 64): Promise<number[][]> => {
                const out: number[][] = [];
                for (let i = 0; i < texts.length; i += batchSize) {
                    const batch = texts.slice(i, i + batchSize).map(t => (t || "").slice(0, 1500));
                    if (batch.length === 0) continue;
                    const vectors = await apiService.generateEmbeddings(batch);
                    out.push(...vectors);
                }
                return out;
            };

            const embeddings = embeddingInputs.length > 0 ? await embedBatches(embeddingInputs, 64) : [];

            let embeddingCursor = 0;
            const sourceEmbedding = embeddings[embeddingCursor] || null;
            embeddingCursor += 1;

            const paragraphEmbeddings: Array<number[] | undefined> = paragraphTraceTexts.map(() => embeddings[embeddingCursor++]);

            await dbService.saveContextSegments({
                sourceId: source.id,
                segmentType: 'bookmark_summary',
                chunks: [{
                    text: bookmarkSummary,
                    embedding: sourceEmbedding || undefined,
                    pageNumber: null,
                    index: 0,
                    locator: {
                        canonical_url: canonical
                    },
                    structured: {
                        chunk_id: 'bookmark_summary',
                        summary: bookmarkSummary
                    },
                    tokenCount: bookmarkSummary.length
                }]
            });

            const paragraphChunks: Array<{
                text: string;
                embedding?: number[] | null;
                pageNumber?: number | null;
                index: number;
                structured?: Record<string, any>;
                locator?: Record<string, any>;
                tokenCount?: number | null;
            }> = [];

            let globalParagraphIndex = 0;
            for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
                const section = sections[sectionIndex];
                for (const paragraph of section.paragraphs || []) {
                    const paragraphSummary = paragraphSummaries[globalParagraphIndex];
                    const paragraphEmbedding = paragraphEmbeddings[globalParagraphIndex];
                    const traceText = paragraphTraceTexts[globalParagraphIndex];
                    const screenshotIndex = paragraph.screenshot_index;
                    const ocrAssetId = typeof screenshotIndex === "number"
                        ? (screenshotAssetIdByIndex.get(screenshotIndex) || null)
                        : null;

                    paragraphChunks.push({
                        text: traceText,
                        embedding: paragraphEmbedding,
                        pageNumber: null,
                        index: paragraph.order || globalParagraphIndex + 1,
                        locator: {
                            canonical_url: canonical,
                            dom_path: paragraph.dom_path || null,
                            tag_name: paragraph.tag_name || null,
                            asset_id: ocrAssetId
                        },
                        structured: {
                            chunk_id: paragraph.paragraph_id || `para_${globalParagraphIndex + 1}`,
                            parent_chunk_id: 'bookmark_summary',
                            paragraph_id: paragraph.paragraph_id || `para_${globalParagraphIndex + 1}`,
                            heading: paragraph.heading || section.heading || `Section ${sectionIndex + 1}`,
                            summary: paragraphSummary,
                            source_summary: bookmarkSummary,
                            raw_text: paragraph.text,
                            channel: paragraph.channel || 'html',
                            context_prefix: paragraph.context_prefix || section.context_prefix || [],
                            layout_hint: paragraph.layout_hint || null,
                            continued_from_previous: Boolean(paragraph.continued_from_previous || section.continued_from_previous),
                            inherited_heading: paragraph.inherited_heading || section.inherited_heading || null
                        },
                        tokenCount: Math.ceil(paragraph.text.length / 4)
                    });
                    globalParagraphIndex += 1;
                }
            }

            await dbService.saveContextSegments({
                sourceId: source.id,
                segmentType: 'paragraph',
                chunks: paragraphChunks
            });


            let nextParagraphIndex = paragraphChunks
                .map((chunk, idx) => Number(chunk.index || idx + 1))
                .reduce((max, value) => Math.max(max, value), 0) + 1;

            let indexedExtraParagraphs = 0;
            const extraScreenshotSummaries: string[] = [];
            const extraScreenshotInputs: Array<{
                localIndex: number;
                assetId: string;
                ocrText: string;
                label: string;
            }> = [];

            const BATCH_SIZE = 3;
            for (let batchStart = 0; batchStart < extraScreenshots.length; batchStart += BATCH_SIZE) {
                const batchEnd = Math.min(batchStart + BATCH_SIZE, extraScreenshots.length);
                const batchFiles = extraScreenshots.slice(batchStart, batchEnd);

                await Promise.all(batchFiles.map(async (file, idxInBatch) => {
                    const extraIdx = batchStart + idxInBatch;
                    const imageBlob = file;
                    const mimeType = file.type || 'image/png';
                    const extension = mimeType.includes("jpeg") ? "jpg"
                        : mimeType.includes("webp") ? "webp"
                            : mimeType.includes("gif") ? "gif"
                                : "png";

                    get().updateContextJob(activityId, {
                        status: 'processing',
                        processedPages: Math.min(
                            get().contextJobs[activityId]?.totalPages || totalSteps,
                            4 + screenshotItems.length + extraIdx
                        ),
                        progressLabel: `Indexing manual screenshot ${extraIdx + 1}/${extraScreenshots.length}`
                    });

                    const assetId = await dbService.addContextAsset({
                        sourceId: source.id,
                        assetType: 'screenshot',
                        assetUri: `asset:${source.id}:manual_screenshot:v${source.version_no || 1}:${extraIdx}`,
                        mimeType,
                        byteSize: imageBlob.size,
                        metadata: {
                            role: 'manual_bookmark_screenshot',
                            index: extraIdx,
                            mime_type: mimeType,
                            version_no: source.version_no || 1
                        }
                    });
                    await pdfStore.saveAsset(assetId, imageBlob, {
                        name: `bookmark-${source.id}-manual-${extraIdx}.${extension}`,
                        type: mimeType
                    });

                    const base64 = await blobToBase64(imageBlob);
                    const ocr = await apiService.visionOcr(base64);
                    const ocrText = (ocr.text || '').trim();
                    if (!ocrText) return;

                    extraScreenshotInputs.push({
                        localIndex: extraIdx,
                        assetId,
                        ocrText,
                        label: file.name || `Manual Screenshot ${extraIdx + 1}`
                    });
                }));
            }
            
            // Restore order since Promise.all could finish out of order
            extraScreenshotInputs.sort((a, b) => a.localIndex - b.localIndex);

            if (extraScreenshotInputs.length > 0) {
                get().updateContextJob(activityId, {
                    status: 'processing',
                    processedPages: Math.min(
                        get().contextJobs[activityId]?.totalPages || totalSteps,
                        4 + screenshotItems.length + extraScreenshotInputs.length
                    ),
                    progressLabel: 'Resolving screenshot continuation context'
                });

                const sequence = await apiService.processBookmarkScreenshotSequence({
                    source_title: capture.title || source.title || canonical,
                    bookmark_summary_context: bookmarkSummary,
                    screenshots: extraScreenshotInputs.map((item, idx) => ({
                        screenshot_index: idx,
                        ocr_text: item.ocrText,
                        asset_id: item.assetId
                    })),
                    initial_context: buildInitialContextFromStructuredSections(
                        sections,
                        capture.title || source.title || canonical,
                        bookmarkSummary
                    )
                });

                for (const result of sequence.screenshots || []) {
                    const input = extraScreenshotInputs[result.screenshot_index];
                    if (!input) continue;

                    const smartChunks = (result.chunks || []).filter((chunk) => (chunk.text || '').trim());
                    if (smartChunks.length === 0) continue;

                    const sectionSummary = (result.screenshot_summary || '').trim()
                        || smartChunks.slice(0, 3).map((chunk) => chunk.summary || chunk.text).join(' ').slice(0, 380);
                    if (sectionSummary) {
                        extraScreenshotSummaries.push(sectionSummary);
                    }

                    const embeddingInputs = [
                        ...smartChunks.map((chunk) => chunk.summary || chunk.text)
                    ].map((text) => (text || '').slice(0, 1500));
                    const paragraphEmbeddings = embeddingInputs.length > 0
                        ? await apiService.generateEmbeddings(embeddingInputs)
                        : [];
                    const sectionHeading = result.screenshot_heading || input.label || `Manual Screenshot ${input.localIndex + 1}`;

                    await dbService.saveContextSegments({
                        sourceId: source.id,
                        segmentType: 'paragraph',
                        chunks: smartChunks.map((chunk, idx) => ({
                            text: buildTraceVectorText(
                                capture.title || source.title || canonical,
                                chunk.summary || chunk.text,
                                chunk.context_prefix || result.context_prefix || [chunk.heading || sectionHeading]
                            ),
                            embedding: paragraphEmbeddings[idx],
                            pageNumber: null,
                            index: nextParagraphIndex + idx,
                            locator: {
                                canonical_url: canonical,
                                asset_id: input.assetId,
                                screenshot_id: input.assetId,
                                screenshot_index: result.screenshot_index
                            },
                            structured: {
                                chunk_id: `manual_ss_para_${input.localIndex}_${idx + 1}_${Date.now()}`,
                                parent_chunk_id: 'bookmark_summary',
                                paragraph_id: `manual_ss_para_${input.localIndex}_${idx + 1}_${Date.now()}`,
                                heading: chunk.heading || sectionHeading,
                                summary: chunk.summary || '',
                                source_summary: bookmarkSummary,
                                raw_text: chunk.text,
                                channel: 'ocr',
                                asset_id: input.assetId,
                                screenshot_index: result.screenshot_index,
                                context_prefix: chunk.context_prefix || result.context_prefix || [],
                                layout_hint: chunk.layout_hint || null,
                                continued_from_previous: Boolean(chunk.continued_from_previous || result.continued_from_previous)
                            },
                            tokenCount: chunk.text.length
                        }))
                    });
                    nextParagraphIndex += smartChunks.length;
                    indexedExtraParagraphs += smartChunks.length;
                }
            }

            let bookmarkSummaryForRetrieval = bookmarkSummary;
            let sourceEmbeddingForRetrieval = sourceEmbedding;
            if (extraScreenshotSummaries.length > 0) {
                const extrasForSummary = extraScreenshotSummaries
                    .slice(0, 4)
                    .map((summary, idx) => `Screenshot ${idx + 1}: ${summary}`);
                bookmarkSummaryForRetrieval = [
                    bookmarkSummary,
                    "Supplemental screenshot context:",
                    ...extrasForSummary
                ].join("\n").slice(0, 1200);

                try {
                    const refreshedSummaryEmbedding = await apiService.generateEmbeddings([
                        bookmarkSummaryForRetrieval.slice(0, 1500)
                    ]);
                    if (refreshedSummaryEmbedding && refreshedSummaryEmbedding[0]) {
                        sourceEmbeddingForRetrieval = refreshedSummaryEmbedding[0];
                        await dbService.saveContextSegments({
                            sourceId: source.id,
                            segmentType: 'bookmark_summary',
                            chunks: [{
                                text: bookmarkSummaryForRetrieval,
                                embedding: refreshedSummaryEmbedding[0],
                                pageNumber: null,
                                index: 1,
                                locator: {
                                    canonical_url: canonical
                                },
                                structured: {
                                    chunk_id: 'bookmark_summary',
                                    summary: bookmarkSummaryForRetrieval,
                                    refreshed_from_screenshot_ingest: true
                                },
                                tokenCount: bookmarkSummaryForRetrieval.length
                            }]
                        });
                    }
                } catch (embedError) {
                    console.error("Failed to refresh bookmark summary embedding after screenshot indexing:", embedError);
                }
            }

            const cleanText = sections
                .flatMap((section) => [
                    section.heading,
                    ...(section.paragraphs || []).map((paragraph: any) => paragraph.text)
                ])
                .join('\n\n')
                .slice(0, 1_500_000);
            if (cleanText.trim()) {
                const textBlob = new Blob([cleanText], { type: 'text/plain' });
                const textAssetId = await dbService.addContextAsset({
                    sourceId: source.id,
                    assetType: 'text',
                    assetUri: `asset:${source.id}:clean_text`,
                    mimeType: 'text/plain',
                    byteSize: textBlob.size,
                    metadata: {
                        role: 'clean_text',
                        char_count: cleanText.length,
                        version_no: source.version_no || 1
                    }
                });
                await pdfStore.saveAsset(textAssetId, textBlob, {
                    name: `bookmark-${source.id}-clean.txt`,
                    type: 'text/plain'
                });
            }

            const latest = await dbService.getLatestBookmarkSourceByCanonical(targetSpaceId, canonical);

            await dbService.updateContextSource(source.id, {
                status: 'completed',
                title: enrichedTitle || capture.title || source.title,
                originalUri: capture.original_url || source.original_uri || null,
                canonicalUri: canonical,
                sourceEmbedding: sourceEmbeddingForRetrieval,
                summary: bookmarkSummaryForRetrieval,
                contentHash: capture.metadata?.signature || null,
                metadata: {
                    ...(capture.metadata || {}),
                    processing_mode: 'hybrid_dom_llm',
                    snapshot_policy: 'version_history',
                    supersedes_source_id: latest?.id || null,
                    version_no: source.version_no || 1,
                    screenshot_count: screenshotItems.length + extraScreenshots.length,
                    manual_screenshot_count: extraScreenshots.length,
                    section_count: sections.length,
                    paragraph_count: paragraphChunks.length + indexedExtraParagraphs
                }
            });

            const finalDebug = {
                ...(get().contextJobs[activityId]?.debugInfo || {}),
                [999]: {
                    ocrText: sections.slice(0, 8).map((section) => {
                        const sectionTitle = `[${section.section_id}] ${section.heading}`;
                        const lines = (section.paragraphs || []).slice(0, 2).map((paragraph: any) => paragraph.text);
                        return [sectionTitle, ...lines].join('\n');
                    }).join('\n\n'),
                    prompt: 'Final hierarchical chunk output',
                    rawResponse: JSON.stringify({
                        source_id: source.id,
                        bookmark_summary: bookmarkSummaryForRetrieval,
                        section_count: sections.length,
                        paragraph_count: paragraphChunks.length,
                        version_no: source.version_no || 1,
                        source_group_key: source.source_group_key || source.id
                    }, null, 2)
                }
            };
            get().updateContextJob(activityId, {
                status: 'completed',
                processedPages: (get().contextJobs[activityId]?.totalPages || 1),
                progressLabel: `Indexed bookmark v${source.version_no || 1}: ${sections.length} sections, ${paragraphChunks.length} paragraphs`,
                extractedChunks: [
                    `[Bookmark Summary] ${bookmarkSummaryForRetrieval}`,
                    ...sections.slice(0, 12).map((section) => `[${section.section_id}] ${section.heading}: ${section.summary || ''}`),
                    ...paragraphChunks.slice(0, 24).map((chunk: any) => {
                        const sectionId = chunk.structured?.section_id || 'section';
                        const paragraphId = chunk.structured?.paragraph_id || 'paragraph';
                        return `[${sectionId}/${paragraphId}] ${chunk.text}`;
                    })
                ],
                debugInfo: finalDebug
            });

            // Background post-processing: deduplicate near-identical segments (UI noise cleanup)
            const sourceIdForDedup = source.id;
            setTimeout(() => {
                dbService.deduplicateSourceSegments(sourceIdForDedup, 0.90)
                    .then(removed => {
                        if (removed > 0) console.log(`[dedup] Removed ${removed} duplicate segments from bookmark ${sourceIdForDedup}`);
                    })
                    .catch(err => console.warn('[dedup] Background deduplication error:', err));
            }, 800);

            return source.id;
        } catch (error: any) {
            await dbService.updateContextSource(source.id, {
                status: 'error',
                metadata: {
                    ...(source.metadata_json || {}),
                    error: error?.message || 'Bookmark ingestion failed'
                }
            });
            get().updateContextJob(activityId, {
                status: 'error',
                error: error?.message || 'Bookmark ingestion failed',
                progressLabel: 'Bookmark indexing failed'
            });
            throw error;
        }
    },

    updateJob: (id, updates) => set((state) => ({
        jobs: {
            ...state.jobs,
            [id]: { ...state.jobs[id], ...updates }
        }
    })),

    pauseJob: (id) => {
        get().updateJob(id, { status: 'paused' });
        dbService.updateDocumentStatus(id, 'paused', get().jobs[id].processedPages);
    },

    resumeJob: (id) => {
        const job = get().jobs[id];
        if (job && job.file && job.status === 'paused') {
            get()._processJob(job.file, id, job.processedPages + 1);
        }
    },

    dismissJob: async (id) => {
        await dbService.dismissDocument(id);
        set((state) => {
            const job = state.jobs[id];
            if (!job) return state;
            return {
                jobs: {
                    ...state.jobs,
                    [id]: { ...job, dismissed_from_queue: true }
                }
            };
        });
    },

    trashJob: async (id) => {
        await dbService.softDeleteDocument(id);
        const job = get().jobs[id];
        if (!job) return;

        const trashedJob: TrashedJob = {
            documentId: id,
            filename: job.filename,
            totalPages: job.totalPages,
            processedPages: job.processedPages,
            deletedAt: new Date().toISOString(),
            status: job.status,
        };

        set((state) => {
            const { [id]: _, ...remainingJobs } = state.jobs;
            return {
                jobs: remainingJobs,
                trashedJobs: { ...state.trashedJobs, [id]: trashedJob },
            };
        });
    },

    restoreJob: async (id) => {
        await dbService.restoreDocument(id);
        const trashed = get().trashedJobs[id];
        if (!trashed) return;

        const file = await pdfStore.getPdf(id);
        const restoredJob: ExtractionJob = {
            documentId: id,
            filename: trashed.filename,
            jobType: 'pdf',
            status: trashed.status === 'processing' ? 'paused' : trashed.status,
            totalPages: trashed.totalPages,
            processedPages: trashed.processedPages,
            createdAt: trashed.deletedAt,
            file: file ?? undefined,
        };

        set((state) => {
            const { [id]: _, ...remainingTrashed } = state.trashedJobs;
            return {
                trashedJobs: remainingTrashed,
                jobs: { ...state.jobs, [id]: restoredJob },
            };
        });
    },

    permanentlyDeleteJob: async (id) => {
        await dbService.permanentlyDeleteDocument(id);
        await pdfStore.deletePdf(id);

        set((state) => {
            const { [id]: _, ...remainingTrashed } = state.trashedJobs;
            return { trashedJobs: remainingTrashed };
        });
    },

    emptyTrash: async () => {
        const trashed = get().trashedJobs;
        for (const id of Object.keys(trashed)) {
            await dbService.permanentlyDeleteDocument(id);
            await pdfStore.deletePdf(id);
        }
        set({ trashedJobs: {} });
    },

    setTrashAutoDeleteHours: (hours) => {
        localStorage.setItem(TRASH_DURATION_KEY, String(hours));
        set({ trashAutoDeleteHours: hours });
    },

    addDevExtractionToContext: async (extractionId: string, spaceId?: string) => {
        const extractions = await dbService.getDevPageExtractions(500);
        const devExt = extractions.find(e => e.id === extractionId);
        if (!devExt) throw new Error("Dev extraction not found");

        const payload = devExt.payload_json || {};
        const url = devExt.url;
        const title = devExt.title || url;

        const defaultSpace = await dbService.getDefaultContextSpace();
        const targetSpaceId = spaceId || defaultSpace.id;

        const activityId = `devextract:${Date.now()}`;
        set((state) => ({
            contextJobs: {
                ...state.contextJobs,
                [activityId]: {
                    documentId: activityId,
                    filename: title,
                    jobType: 'bookmark',
                    sourceType: 'bookmark',
                    sourceUrl: url,
                    status: 'processing',
                    totalPages: 4,
                    processedPages: 1,
                    progressLabel: 'Preparing DEV extraction vectors...',
                    createdAt: new Date().toISOString(),
                }
            }
        }));

        try {
            const source = await dbService.createBookmarkSourceVersion({
                spaceId: targetSpaceId,
                title: title,
                originalUri: url,
                canonicalUri: payload.source_url || url,
                status: 'processing',
                summary: title,
                metadata: {
                    dev_extraction: true,
                    node_count: devExt.node_count,
                    link_count: devExt.link_count
                },
                contentHash: null,
                sourceEmbedding: null
            });

            // Re-use logic for vectors
            // 1. Vectorize text fragments
            let fragments = payload.dev_bookmark_refinement?.fragments;
            if (!Array.isArray(fragments) && payload.extractor === "dev_bookmark_fragment_refiner_v1") {
                fragments = payload.fragments;
            }
            if (!Array.isArray(fragments)) {
                fragments = [];
            }

            const textsToEmbed: string[] = [title];
            for (const f of fragments) {
                const heading = f.hierarchy?.heading || "General";
                const topic = f.hierarchy?.topic || "Topic";
                const summary = f.summary || f.text.slice(0, 150);
                textsToEmbed.push(`(${title}): [${heading} > ${topic}] ${summary}`);
            }

            // Vectors for Links
            const hyperlinks = Array.isArray(payload.hyperlinks) ? payload.hyperlinks : [];
            for (const link of hyperlinks) {
                textsToEmbed.push(`(${title}): Hyperlink - ${link.title || link.href}`);
            }

            // Vectors for Images
            const images = Array.isArray(payload.images) ? payload.images : [];
            for (const img of images) {
                textsToEmbed.push(`(${title}): Image - ${img.alt || img.title || img.src}`);
            }

            get().updateContextJob(activityId, {
                processedPages: 2,
                progressLabel: `Embedding ${textsToEmbed.length} segments (includes ${hyperlinks.length} links, ${images.length} images)...`
            });

            const embedBatches = async (texts: string[], batchSize: number = 64): Promise<number[][]> => {
                const out: number[][] = [];
                for (let i = 0; i < texts.length; i += batchSize) {
                    const batch = texts.slice(i, i + batchSize).map(t => (t || "").slice(0, 1500));
                    if (batch.length === 0) continue;
                    const vectors = await apiService.generateEmbeddings(batch);
                    out.push(...vectors);
                }
                return out;
            };

            const embeddings = textsToEmbed.length > 0 ? await embedBatches(textsToEmbed, 32) : [];
            let embeddingCursor = 0;
            const sourceEmbedding = embeddings[embeddingCursor++];

            // Save source summary
            await dbService.saveContextSegments({
                sourceId: source.id,
                segmentType: 'bookmark_summary',
                chunks: [{
                    text: title,
                    embedding: sourceEmbedding,
                    pageNumber: null,
                    index: 0,
                    locator: { canonical_url: payload.source_url || url },
                    structured: { chunk_id: 'bookmark_summary', summary: title },
                    tokenCount: Math.ceil(title.length / 4)
                }]
            });

            // Save fragments
            if (fragments.length > 0) {
                await dbService.saveContextSegments({
                    sourceId: source.id,
                    segmentType: 'paragraph',
                    chunks: fragments.map((f: any, idx: number) => ({
                        text: textsToEmbed[embeddingCursor + idx], // wait mapping
                        embedding: embeddings[embeddingCursor + idx],
                        pageNumber: null,
                        index: idx + 1,
                        locator: {
                            canonical_url: payload.source_url || url,
                            dom_path: f.trace_path || null
                        },
                        structured: {
                            chunk_id: f.fragment_id || `frag_${idx + 1}`,
                            heading: f.hierarchy?.heading || 'General',
                            summary: f.summary || f.text.slice(0, 150),
                            raw_text: f.text,
                            channel: 'html',
                            context_prefix: f.context_prefix || []
                        },
                        tokenCount: Math.ceil(f.text.length / 4)
                    }))
                });
                embeddingCursor += fragments.length;
            }

            // Save links
            if (hyperlinks.length > 0) {
                get().updateContextJob(activityId, {
                    processedPages: 3,
                    progressLabel: `Saving link & image vectors...`
                });

                await dbService.saveContextSegments({
                    sourceId: source.id,
                    segmentType: 'link',
                    chunks: hyperlinks.map((link: any, idx: number) => ({
                        text: textsToEmbed[embeddingCursor + idx],
                        embedding: embeddings[embeddingCursor + idx],
                        pageNumber: null,
                        index: idx + 1,
                        locator: {
                            canonical_url: link.href || '',
                            rel: link.rel || '',
                        },
                        structured: {
                            chunk_id: `link_${idx + 1}`,
                            link_title: link.title || '',
                            summary: `Hyperlink: ${link.title || link.href}`,
                        },
                        tokenCount: Math.ceil((link.title || link.href || '').length / 4)
                    }))
                });
                embeddingCursor += hyperlinks.length;
            }

            // Save images
            if (images.length > 0) {
                await dbService.saveContextSegments({
                    sourceId: source.id,
                    segmentType: 'image_link',
                    chunks: images.map((img: any, idx: number) => ({
                        text: textsToEmbed[embeddingCursor + idx],
                        embedding: embeddings[embeddingCursor + idx],
                        pageNumber: null,
                        index: idx + 1,
                        locator: {
                            canonical_url: img.src || '',
                            alt: img.alt || '',
                        },
                        structured: {
                            chunk_id: `image_${idx + 1}`,
                            image_title: img.title || '',
                            summary: `Image Link: ${img.alt || img.title || img.src}`,
                        },
                        tokenCount: Math.ceil((img.alt || img.src || '').length / 4)
                    }))
                });
                embeddingCursor += images.length;
            }

            await dbService.updateContextSource(source.id, { status: 'completed' });
            get().updateContextJob(activityId, {
                status: 'completed',
                processedPages: 4,
                progressLabel: 'Vectors extracted and saved successfully'
            });
            setTimeout(() => get().dismissContextJob(activityId), 5000);
            return source.id;

        } catch (error: any) {
            console.error("Dev Extract Ingestion error", error);
            get().updateContextJob(activityId, {
                status: 'error',
                error: error.message || 'Ingestion failed',
                progressLabel: 'Failed'
            });
            throw error;
        }
    },


    _processJob: async (file: File, docId: string, startPage: number) => {
        const { updateJob } = get();
        updateJob(docId, { status: 'processing' });

        try {
            const { renderPdfPageMainThread, getPdfPageCount } = await import('@/services/pdf-renderer');
            const { apiService } = await import('@/services/api-service');

            const totalPages = await getPdfPageCount(file);
            updateJob(docId, { totalPages });

            // Save totalPages to DB immediately so it persists on reload
            dbService.updateDocumentStatus(docId, 'processing', startPage - 1, totalPages);

            const firstPagesText: string[] = [];

            for (let i = startPage; i <= totalPages; i++) {
                // Check if paused
                const currentStatus = get().jobs[docId]?.status;
                if (currentStatus === 'paused') return;

                updateJob(docId, { processedPages: i - 1 });

                // 1. Render page on main thread (proper font support)
                const { imageBlob } = await renderPdfPageMainThread(file, i);

                // 2. Convert to base64 for Vision OCR
                const base64 = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(imageBlob);
                });

                // 3. Vision OCR
                const { text } = await apiService.visionOcr(base64);
                console.log(`Page ${i} text extracted (${text.length} chars)`);

                // Collect text for summary from first 2 pages
                if (i <= 2 && text.trim().length > 0) {
                    firstPagesText.push(text);
                }

                if (firstPagesText.length > 0 && (i === 2 || i === totalPages)) {
                    try {
                        console.log("Generating PDF summary from first pages...");
                        const { title, summary } = await apiService.extractPdfSummary(firstPagesText);

                        const documentName = title || file.name;
                        let nameEmbedding: number[] | undefined;

                        try {
                            const embeddings = await apiService.generateEmbeddings([documentName]);
                            if (embeddings && embeddings.length > 0) {
                                nameEmbedding = embeddings[0];
                            }
                        } catch (e) {
                            console.error("Failed to generate embedding for document name:", e);
                        }

                        // Update document in DB with title (filename) and summary
                        await dbService.updateDocumentTitleAndSummary(docId, documentName, summary, nameEmbedding);

                        // Instantly update the UI name
                        updateJob(docId, { filename: documentName });

                        // Only generate once
                        firstPagesText.length = 0;
                    } catch (e) {
                        console.error("Failed to generate PDF summary:", e);
                    }
                }

                // 4. AI Extraction
                if (text) {
                    try {
                        let previousTablesParams = undefined;
                        if (i > 1) {
                            try {
                                const rawPreviousTables = await dbService.getPdfTablesByPage(docId, i - 1);
                                if (rawPreviousTables && rawPreviousTables.length > 0) {
                                    previousTablesParams = rawPreviousTables.map(t => ({
                                        table_name: t.table_name,
                                        schema_fields: t.schema_json
                                    }));
                                }
                            } catch (e) {
                                console.error("Failed to fetch previous page tables:", e);
                            }
                        }

                        const { tables, debug_info } = await apiService.extractTables(text, previousTablesParams);

                        if (debug_info) {
                            const currentJob = get().jobs[docId];
                            updateJob(docId, {
                                debugInfo: {
                                    ...(currentJob.debugInfo || {}),
                                    [i]: {
                                        ocrText: debug_info.ocr_text,
                                        prompt: debug_info.prompt_sent,
                                        rawResponse: debug_info.raw_response
                                    }
                                }
                            });
                        }
                        console.log(`Extracted ${tables.length} tables from page ${i}`);
                        if (tables.length > 0) {
                            // First, we need to process the tables to see which are new and which are continuations
                            // Fetch ALL currently saved tables for this document to check for continuations
                            const existingDocTables = await dbService.getPdfTables(docId);
                            const newTablesToSave = [];

                            for (const table of tables) {
                                // Check if this table already exists (is a continuation)
                                const existingTable = existingDocTables.find(t => t.table_name === table.table_name);

                                if (existingTable) {
                                    console.log(`Found continuation for table: ${table.table_name}`);

                                    // 1. Check if we need to update the schema or notes of the existing table based on bottom-page context
                                    let needsUpdate = false;
                                    let newNotes = existingTable.notes;
                                    let newSchema = existingTable.schema_json;
                                    // Because it was JSON.stringified in db, it comes out as parsed array depending on PGlite driver. 
                                    // Assume it's parsed, if it's string we'd parse it. But dbService saves it as JSON string, PGlite JSONb returns object.

                                    if (table.updated_notes && table.updated_notes !== existingTable.notes) {
                                        newNotes = table.updated_notes;
                                        needsUpdate = true;
                                    } else if (table.notes && table.notes !== existingTable.notes && table.notes.trim() !== "") {
                                        // Fallback: AI sometimes ignores `updated_notes` and just populates `notes`
                                        // with the new information found on the current page.
                                        const oldStr = (existingTable.notes || "").trim();
                                        const newStr = table.notes.trim();

                                        if (newStr.length > oldStr.length + 10) {
                                            newNotes = newStr; // Assume it's a completely better rewritten note
                                            needsUpdate = true;
                                        } else if (newStr.length > 3 && !oldStr.includes(newStr)) {
                                            // If it contains new small info (like an abbreviation key), concatenate them
                                            newNotes = oldStr ? `${oldStr} | ${newStr}` : newStr;
                                            needsUpdate = true;
                                        }
                                    }

                                    if (table.updated_schema_fields) {
                                        newSchema = table.updated_schema_fields;
                                        needsUpdate = true;
                                    }

                                    let newSummaryEmbedding: number[] | undefined;

                                    if (needsUpdate) {
                                        console.log(`Updating schema/notes for continued table: ${table.table_name}`);

                                        // Regenerate table embedding if notes changed to ensure Top-Down RAG works
                                        if (newNotes !== existingTable.notes) {
                                            try {
                                                const searchString = `${existingTable.summary || table.summary || ""}\nNotes: ${newNotes}`;
                                                const embeddings = await apiService.generateEmbeddings([searchString]);
                                                if (embeddings && embeddings.length > 0) {
                                                    newSummaryEmbedding = embeddings[0];
                                                }
                                            } catch (e) {
                                                console.error("Failed to regenerate table summary embedding", e);
                                            }
                                        }

                                        await dbService.updatePdfTableSchemaAndNotes(
                                            existingTable.id,
                                            newSchema,
                                            newNotes,
                                            newSummaryEmbedding
                                        );
                                    }

                                    // 2. Generate embeddings for the chunks of this continued table
                                    try {
                                        const chunkTextsToEmbed = (table.chunks || []).map((c: any) => c.text_summary || "");
                                        if (chunkTextsToEmbed.length > 0) {
                                            const embeddings = await apiService.generateEmbeddings(chunkTextsToEmbed);
                                            for (let j = 0; j < table.chunks.length; j++) {
                                                table.chunks[j].summary_embedding = embeddings[j];
                                            }
                                        }
                                    } catch (e) {
                                        console.error("Failed to generate chunk embeddings for continued table.", e);
                                    }

                                    // 3. Insert the new chunks linking back to the EXISTING table ID
                                    if (table.chunks && table.chunks.length > 0) {
                                        await dbService.saveChunks(existingTable.id, docId, table.chunks, i);
                                    }

                                } else {
                                    // It's a brand new table
                                    console.log(`Found NEW table: ${table.table_name}`);

                                    // Use updated schema/notes if provided even on first page (unlikely, but safest)
                                    if (table.updated_schema_fields) table.schema_fields = table.updated_schema_fields;
                                    if (table.updated_notes) table.notes = table.updated_notes;

                                    newTablesToSave.push(table);
                                }
                            }

                            // Now generate embeddings and save only the TRULY new tables
                            if (newTablesToSave.length > 0) {
                                try {
                                    const textsToEmbed: string[] = [];

                                    // Collect all texts
                                    for (const table of newTablesToSave) {
                                        const summaryText = table.summary || "";
                                        const notesText = table.notes ? `\nNotes: ${table.notes}` : "";
                                        textsToEmbed.push(summaryText + notesText);

                                        for (const chunk of table.chunks || []) {
                                            textsToEmbed.push(chunk.text_summary || "");
                                        }
                                    }

                                    if (textsToEmbed.length > 0) {
                                        console.log(`Generating embeddings for ${textsToEmbed.length} items (New Tables)...`);
                                        const embeddings = await apiService.generateEmbeddings(textsToEmbed);

                                        // Map embeddings back to objects
                                        let embIndex = 0;
                                        for (const table of newTablesToSave) {
                                            table.summary_embedding = embeddings[embIndex++];
                                            for (const chunk of table.chunks || []) {
                                                chunk.summary_embedding = embeddings[embIndex++];
                                            }
                                        }
                                    }
                                } catch (e) {
                                    console.error("Failed to generate embeddings. Proceeding without them.", e);
                                }

                                await dbService.saveExtractedData(newTablesToSave, docId, i);

                                // Increment totalTables state ONLY for new tables
                                set((state) => ({ totalTables: state.totalTables + newTablesToSave.length }));
                            }
                        }
                    } catch (e) {
                        console.error("AI Extraction failed:", e);
                    }
                }

                updateJob(docId, { processedPages: i });

                // Update DB on EVERY page exactly, to support resuming instantly if tab closed
                dbService.updateDocumentStatus(docId, 'processing', i);
            }

            // If finished and not paused
            const finalStatus = get().jobs[docId]?.status;
            if (finalStatus !== 'paused') {
                updateJob(docId, { status: 'completed' });
                dbService.updateDocumentStatus(docId, 'completed', get().jobs[docId].totalPages);
            }

        } catch (err: any) {
            console.error("Extraction failed for", docId, err);
            updateJob(docId, { status: 'error', error: err.message });
            dbService.updateDocumentStatus(docId, 'error', 0);
        }
    }
}));
