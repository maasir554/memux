import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { dbService, type ContextAsset, type ContextSegment, type ContextSource } from "@/services/db-service";
import { pdfStore } from "@/services/pdf-store";
import { useExtractionStore } from "@/store/extraction-store";
import { apiService } from "@/services/api-service";
import { memuxExtensionBridge } from "@/services/memux-extension-bridge";
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Eraser, ExternalLink, FileText, Image as ImageIcon, Link2, Loader2, MessageSquare, MoreVertical, TableProperties, Trash } from "lucide-react";

interface ContextSourceDetailsViewProps {
    sourceId: string;
}

function parseJson(input: unknown): any {
    if (input === null || input === undefined) return null;
    if (typeof input === "object") return input;
    if (typeof input === "string") {
        try {
            return JSON.parse(input);
        } catch {
            return input;
        }
    }
    return input;
}

function compactText(value: string, max = 180): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max)}...`;
}

function buildTraceVectorText(trace: string[] | undefined, summary: string, fallbackHeading?: string) {
    const normalizedTrace = (Array.isArray(trace) ? trace : [])
        .map((part) => String(part || "").trim())
        .filter(Boolean);
    const traceText = normalizedTrace.length > 0
        ? `Trace: ${normalizedTrace.join(" > ")}`
        : (fallbackHeading || "").trim();
    return [
        traceText,
        String(summary || "").trim()
    ].filter(Boolean).join("\n");
}

function buildInitialContextFromSegments(segments: ContextSegment[], sourceTitle: string, bookmarkSummary: string) {
    const parsed = segments
        .map((segment) => ({
            segment,
            structured: parseJson(segment.structured_json),
        }))
        .filter(({ segment, structured }) =>
            (segment.segment_type === "section_summary" || segment.segment_type === "paragraph")
            && structured
            && structured.channel === "ocr"
        );

    const lastSection = [...parsed]
        .reverse()
        .find(({ segment }) => segment.segment_type === "section_summary");

    const tailParagraphs = parsed
        .filter(({ segment }) => segment.segment_type === "paragraph")
        .slice(-2);

    return {
        previous_screenshot_heading: lastSection?.structured?.heading || sourceTitle,
        previous_screenshot_summary: lastSection?.segment?.text_content || bookmarkSummary,
        previous_tail_chunks: tailParagraphs.map(({ segment, structured }) => ({
            heading: structured?.heading || sourceTitle,
            summary: structured?.summary || segment.text_content.slice(0, 220),
            text: segment.text_content,
            layout_hint: structured?.layout_hint || "bottom"
        })),
        previous_context_prefix: (Array.isArray(lastSection?.structured?.context_prefix) && lastSection?.structured?.context_prefix.length > 0)
            ? lastSection?.structured?.context_prefix
            : [sourceTitle, lastSection?.structured?.heading || sourceTitle].filter(Boolean)
    };
}

function formatAiProcessedContent(structured: any): string {
    if (!structured || typeof structured !== "object") {
        return "No AI-processed metadata available for this chunk.";
    }

    const blocks: string[] = [];
    if (structured.heading) blocks.push(`Heading:\n${String(structured.heading)}`);
    if (structured.summary) blocks.push(`Chunk Summary:\n${String(structured.summary)}`);
    if (structured.section_summary) blocks.push(`Section Summary:\n${String(structured.section_summary)}`);
    if (structured.source_summary) blocks.push(`Bookmark Summary Context:\n${String(structured.source_summary)}`);

    const meta: string[] = [];
    if (structured.section_id) meta.push(`section_id: ${String(structured.section_id)}`);
    if (structured.paragraph_id) meta.push(`paragraph_id: ${String(structured.paragraph_id)}`);
    if (structured.chunk_id) meta.push(`chunk_id: ${String(structured.chunk_id)}`);
    if (structured.channel) meta.push(`channel: ${String(structured.channel)}`);
    if (meta.length > 0) {
        blocks.push(`Metadata:\n${meta.join("\n")}`);
    }

    return blocks.length > 0
        ? blocks.join("\n\n")
        : JSON.stringify(structured, null, 2);
}

function getDisplayedChunkText(segment: ContextSegment, structured: any): string {
    if (structured && typeof structured === "object" && typeof structured.raw_text === "string" && structured.raw_text.trim()) {
        return structured.raw_text;
    }
    return segment.text_content || "";
}

interface BookmarkParagraphNode {
    segment: ContextSegment;
    sectionId: string;
    paragraphId: string;
    heading: string;
    channel: string;
    summary: string;
}

interface BookmarkSectionNode {
    sectionId: string;
    heading: string;
    summary: string;
    channel: string;
    sectionSegment: ContextSegment | null;
    paragraphs: BookmarkParagraphNode[];
    order: number;
}

interface IngestJob {
    id: string;
    label: string;
    status: "processing" | "completed" | "error";
    message: string;
}

export function ContextSourceDetailsView({ sourceId }: ContextSourceDetailsViewProps) {
    const [, setLocation] = useLocation();
    const setFocusedSpaceIds = useExtractionStore(state => state.setFocusedSpaceIds);
    const [source, setSource] = useState<ContextSource | null>(null);
    const [segments, setSegments] = useState<ContextSegment[]>([]);
    const [assets, setAssets] = useState<ContextAsset[]>([]);
    const [versions, setVersions] = useState<ContextSource[]>([]);
    const [assetPreviewUrls, setAssetPreviewUrls] = useState<Record<string, string>>({});
    const [selectedSegment, setSelectedSegment] = useState<ContextSegment | null>(null);
    const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
    const [isDeleteOpen, setIsDeleteOpen] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isDropActive, setIsDropActive] = useState(false);
    const [ingestJobs, setIngestJobs] = useState<IngestJob[]>([]);
    const [isCaptureStudioOpen, setIsCaptureStudioOpen] = useState(false);
    const [isScreenShareActive, setIsScreenShareActive] = useState(false);
    const [screenCaptureCount, setScreenCaptureCount] = useState(0);
    const [isCapturingFrame, setIsCapturingFrame] = useState(false);
    const [isAutoCapturing, setIsAutoCapturing] = useState(false);
    const [autoCaptureMaxShots, setAutoCaptureMaxShots] = useState("18");
    const [isSnipPreviewOpen, setIsSnipPreviewOpen] = useState(false);
    const [snipZoom, setSnipZoom] = useState(1);
    const [snipNaturalSize, setSnipNaturalSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const [snipFitSize, setSnipFitSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const [isBookmarkScreenshotViewerOpen, setIsBookmarkScreenshotViewerOpen] = useState(false);
    const [bookmarkScreenshotIndex, setBookmarkScreenshotIndex] = useState(0);
    const [bookmarkScreenshotZoom, setBookmarkScreenshotZoom] = useState(1);
    const [bookmarkScreenshotNaturalSize, setBookmarkScreenshotNaturalSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const [bookmarkScreenshotFitSize, setBookmarkScreenshotFitSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const [isLoading, setIsLoading] = useState(true);
    const [dedupThreshold, setDedupThreshold] = useState("90");
    const [isDedupRunning, setIsDedupRunning] = useState(false);
    const [dedupResult, setDedupResult] = useState<{ removed: number; ranAt: string } | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const screenVideoRef = useRef<HTMLVideoElement | null>(null);
    const screenStreamRef = useRef<MediaStream | null>(null);
    const ingestQueueRef = useRef<Promise<void>>(Promise.resolve());
    const snipViewportRef = useRef<HTMLDivElement | null>(null);
    const bookmarkScreenshotViewportRef = useRef<HTMLDivElement | null>(null);

    const stopScreenShareSession = () => {
        const stream = screenStreamRef.current;
        if (stream) {
            for (const track of stream.getTracks()) {
                track.stop();
            }
        }
        screenStreamRef.current = null;
        const video = screenVideoRef.current;
        if (video) {
            video.pause();
            (video as any).srcObject = null;
        }
        setIsScreenShareActive(false);
        setIsCapturingFrame(false);
        setIsAutoCapturing(false);
    };

    const revokePreviewUrls = (previewMap: Record<string, string>) => {
        for (const url of Object.values(previewMap)) {
            URL.revokeObjectURL(url);
        }
    };

    const buildAssetPreviews = async (assetList: ContextAsset[]) => {
        const previews: Record<string, string> = {};
        for (const asset of assetList) {
            if (!(asset.mime_type || "").startsWith("image/")) continue;
            const file = await pdfStore.getAsset(asset.id);
            if (!file) continue;
            previews[asset.id] = URL.createObjectURL(file);
        }
        setAssetPreviewUrls((prev) => {
            revokePreviewUrls(prev);
            return previews;
        });
    };

    const refreshSourceData = async () => {
        const [src, segs, ast] = await Promise.all([
            dbService.getContextSource(sourceId),
            dbService.getContextSegmentsBySource(sourceId),
            dbService.getContextAssets(sourceId),
        ]);
        setSource(src);
        setSegments(segs);
        setAssets(ast);

        if (src?.source_type === "bookmark") {
            const allVersions = await dbService.getBookmarkSourceVersions(sourceId);
            setVersions(allVersions);
        } else {
            setVersions([]);
        }

        await buildAssetPreviews(ast);
    };

    const metadata = useMemo(() => parseJson(source?.metadata_json), [source?.metadata_json]);
    const primarySnipAsset = useMemo(
        () => assets.find((asset) => asset.asset_type === "screenshot" || (asset.mime_type || "").startsWith("image/")) || null,
        [assets]
    );
    const primarySnipPreviewUrl = useMemo(
        () => (primarySnipAsset ? assetPreviewUrls[primarySnipAsset.id] : undefined),
        [primarySnipAsset, assetPreviewUrls]
    );
    const bookmarkScreenshotAssets = useMemo(
        () => assets.filter((asset) => asset.asset_type === "screenshot" && !!assetPreviewUrls[asset.id]),
        [assets, assetPreviewUrls]
    );
    const activeBookmarkScreenshot = useMemo(
        () => bookmarkScreenshotAssets[bookmarkScreenshotIndex] || null,
        [bookmarkScreenshotAssets, bookmarkScreenshotIndex]
    );
    const activeBookmarkScreenshotUrl = useMemo(
        () => (activeBookmarkScreenshot ? assetPreviewUrls[activeBookmarkScreenshot.id] : undefined),
        [activeBookmarkScreenshot, assetPreviewUrls]
    );

    useEffect(() => {
        const load = async () => {
            setIsLoading(true);
            try {
                await refreshSourceData();
            } finally {
                setIsLoading(false);
            }
        };

        load();
        return () => {
            stopScreenShareSession();
            setAssetPreviewUrls((prev) => {
                revokePreviewUrls(prev);
                return {};
            });
        };
    }, [sourceId]);

    useEffect(() => {
        if (!isSnipPreviewOpen) return;
        recomputeSnipFitSize();
        const onResize = () => recomputeSnipFitSize();
        window.addEventListener("resize", onResize);
        return () => {
            window.removeEventListener("resize", onResize);
        };
    }, [isSnipPreviewOpen, snipNaturalSize.width, snipNaturalSize.height]);

    useEffect(() => {
        if (!isBookmarkScreenshotViewerOpen) return;
        recomputeBookmarkScreenshotFitSize();
        const onResize = () => recomputeBookmarkScreenshotFitSize();
        window.addEventListener("resize", onResize);
        return () => {
            window.removeEventListener("resize", onResize);
        };
    }, [isBookmarkScreenshotViewerOpen, bookmarkScreenshotNaturalSize.width, bookmarkScreenshotNaturalSize.height, bookmarkScreenshotIndex]);

    useEffect(() => {
        if (bookmarkScreenshotAssets.length === 0) {
            setBookmarkScreenshotIndex(0);
            if (isBookmarkScreenshotViewerOpen) {
                setIsBookmarkScreenshotViewerOpen(false);
            }
            return;
        }
        if (bookmarkScreenshotIndex > bookmarkScreenshotAssets.length - 1) {
            setBookmarkScreenshotIndex(bookmarkScreenshotAssets.length - 1);
        }
    }, [bookmarkScreenshotAssets.length, bookmarkScreenshotIndex, isBookmarkScreenshotViewerOpen]);

    useEffect(() => {
        if (!isBookmarkScreenshotViewerOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (bookmarkScreenshotAssets.length <= 1) return;
            if (event.key === "ArrowRight") {
                event.preventDefault();
                setBookmarkScreenshotIndex((prev) => (prev + 1) % bookmarkScreenshotAssets.length);
                setBookmarkScreenshotZoom(1);
            } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                setBookmarkScreenshotIndex((prev) => (prev - 1 + bookmarkScreenshotAssets.length) % bookmarkScreenshotAssets.length);
                setBookmarkScreenshotZoom(1);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [isBookmarkScreenshotViewerOpen, bookmarkScreenshotAssets.length]);

    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

    const recomputeSnipFitSize = () => {
        const viewport = snipViewportRef.current;
        if (!viewport || snipNaturalSize.width <= 0 || snipNaturalSize.height <= 0) return;
        const viewportWidth = viewport.clientWidth;
        const viewportHeight = viewport.clientHeight;
        if (viewportWidth <= 0 || viewportHeight <= 0) return;

        const scale = Math.min(
            viewportWidth / snipNaturalSize.width,
            viewportHeight / snipNaturalSize.height
        );
        setSnipFitSize({
            width: Math.max(1, Math.floor(snipNaturalSize.width * scale)),
            height: Math.max(1, Math.floor(snipNaturalSize.height * scale))
        });
    };

    const applySnipZoom = (nextZoomRaw: number, anchor?: { clientX: number; clientY: number }) => {
        const nextZoom = clamp(Number(nextZoomRaw.toFixed(2)), 1, 4);
        const viewport = snipViewportRef.current;
        if (!viewport || snipFitSize.width <= 0 || snipFitSize.height <= 0) {
            setSnipZoom(nextZoom);
            return;
        }

        const rect = viewport.getBoundingClientRect();
        const anchorX = anchor ? clamp(anchor.clientX - rect.left, 0, viewport.clientWidth) : viewport.clientWidth / 2;
        const anchorY = anchor ? clamp(anchor.clientY - rect.top, 0, viewport.clientHeight) : viewport.clientHeight / 2;

        const oldWidth = snipFitSize.width * snipZoom;
        const oldHeight = snipFitSize.height * snipZoom;
        const relX = oldWidth > 0 ? (viewport.scrollLeft + anchorX) / oldWidth : 0.5;
        const relY = oldHeight > 0 ? (viewport.scrollTop + anchorY) / oldHeight : 0.5;

        setSnipZoom(nextZoom);
        requestAnimationFrame(() => {
            const nextViewport = snipViewportRef.current;
            if (!nextViewport) return;
            const newWidth = snipFitSize.width * nextZoom;
            const newHeight = snipFitSize.height * nextZoom;
            const maxLeft = Math.max(0, newWidth - nextViewport.clientWidth);
            const maxTop = Math.max(0, newHeight - nextViewport.clientHeight);
            nextViewport.scrollLeft = clamp(relX * newWidth - anchorX, 0, maxLeft);
            nextViewport.scrollTop = clamp(relY * newHeight - anchorY, 0, maxTop);
        });
    };

    const recomputeBookmarkScreenshotFitSize = () => {
        const viewport = bookmarkScreenshotViewportRef.current;
        if (!viewport || bookmarkScreenshotNaturalSize.width <= 0 || bookmarkScreenshotNaturalSize.height <= 0) return;
        const viewportWidth = viewport.clientWidth;
        const viewportHeight = viewport.clientHeight;
        if (viewportWidth <= 0 || viewportHeight <= 0) return;

        const scale = Math.min(
            viewportWidth / bookmarkScreenshotNaturalSize.width,
            viewportHeight / bookmarkScreenshotNaturalSize.height
        );
        setBookmarkScreenshotFitSize({
            width: Math.max(1, Math.floor(bookmarkScreenshotNaturalSize.width * scale)),
            height: Math.max(1, Math.floor(bookmarkScreenshotNaturalSize.height * scale))
        });
    };

    const applyBookmarkScreenshotZoom = (nextZoomRaw: number, anchor?: { clientX: number; clientY: number }) => {
        const nextZoom = clamp(Number(nextZoomRaw.toFixed(2)), 1, 4);
        const viewport = bookmarkScreenshotViewportRef.current;
        if (!viewport || bookmarkScreenshotFitSize.width <= 0 || bookmarkScreenshotFitSize.height <= 0) {
            setBookmarkScreenshotZoom(nextZoom);
            return;
        }

        const rect = viewport.getBoundingClientRect();
        const anchorX = anchor ? clamp(anchor.clientX - rect.left, 0, viewport.clientWidth) : viewport.clientWidth / 2;
        const anchorY = anchor ? clamp(anchor.clientY - rect.top, 0, viewport.clientHeight) : viewport.clientHeight / 2;

        const oldWidth = bookmarkScreenshotFitSize.width * bookmarkScreenshotZoom;
        const oldHeight = bookmarkScreenshotFitSize.height * bookmarkScreenshotZoom;
        const relX = oldWidth > 0 ? (viewport.scrollLeft + anchorX) / oldWidth : 0.5;
        const relY = oldHeight > 0 ? (viewport.scrollTop + anchorY) / oldHeight : 0.5;

        setBookmarkScreenshotZoom(nextZoom);
        requestAnimationFrame(() => {
            const nextViewport = bookmarkScreenshotViewportRef.current;
            if (!nextViewport) return;
            const newWidth = bookmarkScreenshotFitSize.width * nextZoom;
            const newHeight = bookmarkScreenshotFitSize.height * nextZoom;
            const maxLeft = Math.max(0, newWidth - nextViewport.clientWidth);
            const maxTop = Math.max(0, newHeight - nextViewport.clientHeight);
            nextViewport.scrollLeft = clamp(relX * newWidth - anchorX, 0, maxLeft);
            nextViewport.scrollTop = clamp(relY * newHeight - anchorY, 0, maxTop);
        });
    };

    const bookmarkSummary = useMemo(() => {
        if (source?.source_type !== "bookmark") return null;
        const summarySegment = segments.find(seg => seg.segment_type === "bookmark_summary");
        return (summarySegment?.text_content || source.summary || "").trim();
    }, [segments, source]);

    const visibleSegments = useMemo(() => {
        if (!source) return segments;
        if (source.source_type !== "bookmark") return segments;
        return segments.filter(seg => seg.segment_type !== "bookmark_summary");
    }, [segments, source]);

    const selectedStructured = useMemo(
        () => parseJson(selectedSegment?.structured_json),
        [selectedSegment?.structured_json]
    );

    const selectedLocator = useMemo(
        () => parseJson(selectedSegment?.locator_json),
        [selectedSegment?.locator_json]
    );

    const bookmarkHierarchy = useMemo<BookmarkSectionNode[]>(() => {
        if (source?.source_type !== "bookmark") return [];

        const sectionMap = new Map<string, BookmarkSectionNode>();
        let fallbackSectionCounter = 1;

        const getOrCreateSection = (sectionIdRaw: unknown, fallbackHeading?: string): BookmarkSectionNode => {
            const sectionId = (typeof sectionIdRaw === "string" && sectionIdRaw.trim())
                ? sectionIdRaw.trim()
                : `section_${fallbackSectionCounter++}`;
            const existing = sectionMap.get(sectionId);
            if (existing) return existing;

            const node: BookmarkSectionNode = {
                sectionId,
                heading: fallbackHeading || sectionId,
                summary: "",
                channel: "html",
                sectionSegment: null,
                paragraphs: [],
                order: Number.MAX_SAFE_INTEGER
            };
            sectionMap.set(sectionId, node);
            return node;
        };

        for (const segment of visibleSegments) {
            const structured = parseJson(segment.structured_json);
            if (segment.segment_type === "section_summary") {
                const sectionId = structured?.section_id || structured?.parent_chunk_id || `section_${segment.segment_index}`;
                const node = getOrCreateSection(sectionId, structured?.heading || `Section ${segment.segment_index}`);
                node.heading = structured?.heading || node.heading;
                node.summary = structured?.summary || segment.text_content || node.summary;
                node.channel = structured?.channel || node.channel || "html";
                node.sectionSegment = segment;
                node.order = Math.min(node.order, Number(segment.segment_index || Number.MAX_SAFE_INTEGER));
                continue;
            }

            if (segment.segment_type !== "paragraph") continue;
            const sectionId = structured?.section_id || structured?.parent_chunk_id || `section_${segment.segment_index}`;
            const node = getOrCreateSection(sectionId, structured?.heading || `Section ${segment.segment_index}`);
            node.heading = structured?.heading || node.heading;
            node.channel = structured?.channel || node.channel || "html";
            node.order = Math.min(node.order, Number(segment.segment_index || Number.MAX_SAFE_INTEGER));
            node.paragraphs.push({
                segment,
                sectionId: String(sectionId),
                paragraphId: String(structured?.paragraph_id || structured?.chunk_id || `paragraph_${segment.segment_index}`),
                heading: String(structured?.heading || node.heading || "Paragraph"),
                channel: String(structured?.channel || "html"),
                summary: String(structured?.summary || "")
            });
        }

        const hierarchy = Array.from(sectionMap.values())
            .map((section) => ({
                ...section,
                paragraphs: section.paragraphs.sort((a, b) => a.segment.segment_index - b.segment.segment_index)
            }))
            .sort((a, b) => {
                if (a.order === b.order) return a.sectionId.localeCompare(b.sectionId);
                return a.order - b.order;
            });

        return hierarchy;
    }, [source?.source_type, visibleSegments]);

    const toggleSection = (sectionId: string) => {
        setExpandedSections(prev => ({ ...prev, [sectionId]: !prev[sectionId] }));
    };

    const upsertIngestJob = (id: string, updates: Partial<IngestJob>) => {
        setIngestJobs((prev) => {
            const existing = prev.find(job => job.id === id);
            if (!existing) return prev;
            return prev.map(job => job.id === id ? { ...job, ...updates } : job);
        });
    };

    const pushIngestJob = (job: IngestJob) => {
        setIngestJobs((prev) => [job, ...prev].slice(0, 8));
    };

    const blobToBase64 = async (blob: Blob): Promise<string> => {
        return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(String(reader.result).split(",")[1] || "");
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    };

    const enqueueBookmarkScreenshot = (blob: Blob, label: string) => {
        if (!source || source.source_type !== "bookmark") return;
        ingestQueueRef.current = ingestQueueRef.current
            .then(async () => {
                const ingestId = `manual-ss-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                pushIngestJob({
                    id: ingestId,
                    label,
                    status: "processing",
                    message: "Saving screenshot and running OCR..."
                });

                try {
                    const currentSource = await dbService.getContextSource(source.id);
                    if (!currentSource) throw new Error("Bookmark source not found");

                    const metadata = parseJson(currentSource.metadata_json) || {};
                    const manualCount = Number(metadata.manual_screenshot_count || 0) + 1;

                    const assetId = await dbService.addContextAsset({
                        sourceId: currentSource.id,
                        assetType: "screenshot",
                        assetUri: `asset:${currentSource.id}:manual_screenshot:${Date.now()}`,
                        mimeType: blob.type || "image/png",
                        byteSize: blob.size,
                        metadata: {
                            role: "manual_bookmark_screenshot",
                            label,
                            manual_index: manualCount,
                            captured_at: new Date().toISOString()
                        }
                    });
                    await pdfStore.saveAsset(assetId, blob, {
                        name: label,
                        type: blob.type || "image/png"
                    });

                    const base64 = await blobToBase64(blob);
                    const ocr = await apiService.visionOcr(base64);
                    const ocrText = (ocr.text || "").trim();

                    if (!ocrText) {
                        await dbService.updateContextSource(currentSource.id, {
                            metadata: {
                                ...metadata,
                                manual_screenshot_count: manualCount,
                                last_manual_screenshot_at: new Date().toISOString()
                            }
                        });
                        await refreshSourceData();
                        upsertIngestJob(ingestId, {
                            status: "completed",
                            message: "Screenshot saved. OCR found no extractable text."
                        });
                        return;
                    }

                    upsertIngestJob(ingestId, { message: "Chunking screenshot text and generating embeddings..." });

                    const existingSegments = await dbService.getContextSegmentsBySource(currentSource.id);
                    const nextSectionIndex = (
                        existingSegments
                            .filter(seg => seg.segment_type === "section_summary")
                            .reduce((max, seg) => Math.max(max, Number(seg.segment_index || 0)), 0)
                    ) + 1;
                    const nextParagraphIndex = (
                        existingSegments
                            .filter(seg => seg.segment_type === "paragraph")
                            .reduce((max, seg) => Math.max(max, Number(seg.segment_index || 0)), 0)
                    ) + 1;
                    const nextBookmarkSummaryIndex = (
                        existingSegments
                            .filter(seg => seg.segment_type === "bookmark_summary")
                            .reduce((max, seg) => Math.max(max, Number(seg.segment_index || 0)), 0)
                    ) + 1;

                    const bookmarkSummaryContext = (
                        existingSegments.find(seg => seg.segment_type === "bookmark_summary")?.text_content
                        || currentSource.summary
                        || ""
                    ).trim();
                    const sequence = await apiService.processBookmarkScreenshotSequence({
                        source_title: currentSource.title || label,
                        bookmark_summary_context: bookmarkSummaryContext,
                        screenshots: [{
                            screenshot_index: 0,
                            ocr_text: ocrText,
                            asset_id: assetId
                        }],
                        initial_context: buildInitialContextFromSegments(existingSegments, currentSource.title || label, bookmarkSummaryContext)
                    });
                    const sequenceResult = (sequence.screenshots || [])[0];
                    const smartChunks = (sequenceResult?.chunks || []).filter(chunk => (chunk.text || "").trim());
                    const sectionHeading = sequenceResult?.screenshot_heading || `Manual Screenshot ${manualCount}`;
                    const sectionSummary = (sequenceResult?.screenshot_summary || "").trim()
                        || smartChunks.slice(0, 3).map(chunk => chunk.summary || chunk.text).join(" ").slice(0, 380);

                    if (smartChunks.length === 0) {
                        throw new Error("No meaningful screenshot chunks were produced.");
                    }

                    const refreshedBookmarkSummary = [
                        bookmarkSummaryContext,
                        sectionSummary ? `Screenshot ${manualCount}: ${sectionSummary}` : ""
                    ].filter(Boolean).join("\n").slice(0, 1200);
                    let refreshedBookmarkEmbedding: number[] | null = null;
                    if (refreshedBookmarkSummary) {
                        const refreshedEmbeddings = await apiService.generateEmbeddings([
                            refreshedBookmarkSummary.slice(0, 1500)
                        ]);
                        refreshedBookmarkEmbedding = refreshedEmbeddings[0] || null;
                    }

                    const embeddingInputs = [
                        sectionSummary,
                        ...smartChunks.map(chunk => chunk.summary || chunk.text)
                    ].map(text => (text || "").slice(0, 1500));
                    const embeddings = embeddingInputs.length > 0
                        ? await apiService.generateEmbeddings(embeddingInputs)
                        : [];

                    const sectionEmbedding = embeddings[0];
                    const paragraphEmbeddings = embeddings.slice(1);
                    const sectionId = `manual_ss_${manualCount}_${Date.now()}`;

                    await dbService.saveContextSegments({
                        sourceId: currentSource.id,
                        segmentType: "section_summary",
                        chunks: [{
                            text: buildTraceVectorText(
                                sequenceResult?.context_prefix || [currentSource.title || label, sectionHeading],
                                sectionSummary || sectionHeading,
                                sectionHeading
                            ),
                            embedding: sectionEmbedding,
                            index: nextSectionIndex,
                            pageNumber: null,
                            locator: {
                                canonical_url: currentSource.canonical_uri || null,
                                asset_id: assetId,
                                screenshot_index: 0
                            },
                            structured: {
                                chunk_id: sectionId,
                                parent_chunk_id: "bookmark_summary",
                                section_id: sectionId,
                                heading: sectionHeading,
                                summary: sectionSummary || "",
                                source_summary: bookmarkSummaryContext,
                                raw_text: smartChunks.map((chunk) => chunk.text).join("\n\n"),
                                channel: "ocr",
                                asset_id: assetId,
                                screenshot_index: 0,
                                context_prefix: sequenceResult?.context_prefix || [],
                                continued_from_previous: Boolean(sequenceResult?.continued_from_previous),
                                inherited_heading: sequenceResult?.inherited_heading || null
                            },
                            tokenCount: sectionSummary.length
                        }]
                    });

                    await dbService.saveContextSegments({
                        sourceId: currentSource.id,
                        segmentType: "paragraph",
                        chunks: smartChunks.map((chunk, idx) => ({
                            text: buildTraceVectorText(
                                chunk.context_prefix || sequenceResult?.context_prefix || [currentSource.title || label, chunk.heading || sectionHeading],
                                chunk.summary || chunk.text,
                                chunk.heading || sectionHeading
                            ),
                            embedding: paragraphEmbeddings[idx],
                            index: nextParagraphIndex + idx,
                            pageNumber: null,
                            locator: {
                                canonical_url: currentSource.canonical_uri || null,
                                asset_id: assetId,
                                screenshot_id: assetId,
                                screenshot_index: 0
                            },
                            structured: {
                                chunk_id: `${sectionId}_para_${idx + 1}`,
                                parent_chunk_id: sectionId,
                                section_id: sectionId,
                                paragraph_id: `${sectionId}_para_${idx + 1}`,
                                heading: chunk.heading || sectionHeading,
                                summary: chunk.summary || "",
                                source_summary: bookmarkSummaryContext,
                                section_summary: sectionSummary || "",
                                raw_text: chunk.text,
                                channel: "ocr",
                                asset_id: assetId,
                                screenshot_index: 0,
                                context_prefix: chunk.context_prefix || sequenceResult?.context_prefix || [],
                                layout_hint: chunk.layout_hint || null,
                                continued_from_previous: Boolean(chunk.continued_from_previous || sequenceResult?.continued_from_previous),
                                inherited_heading: sequenceResult?.inherited_heading || null
                            },
                            tokenCount: chunk.text.length
                        }))
                    });

                    if (refreshedBookmarkSummary && refreshedBookmarkEmbedding) {
                        await dbService.saveContextSegments({
                            sourceId: currentSource.id,
                            segmentType: "bookmark_summary",
                            chunks: [{
                                text: refreshedBookmarkSummary,
                                embedding: refreshedBookmarkEmbedding,
                                index: nextBookmarkSummaryIndex,
                                pageNumber: null,
                                locator: {
                                    canonical_url: currentSource.canonical_uri || null
                                },
                                structured: {
                                    chunk_id: "bookmark_summary",
                                    summary: refreshedBookmarkSummary,
                                    refreshed_from_screenshot_ingest: true
                                },
                                tokenCount: refreshedBookmarkSummary.length
                            }]
                        });
                    }

                    const sourceUpdates: Parameters<typeof dbService.updateContextSource>[1] = {
                        metadata: {
                            ...metadata,
                            manual_screenshot_count: manualCount,
                            last_manual_screenshot_at: new Date().toISOString()
                        },
                        summary: refreshedBookmarkSummary || currentSource.summary || null,
                        status: "completed"
                    };
                    if (refreshedBookmarkEmbedding) {
                        sourceUpdates.sourceEmbedding = refreshedBookmarkEmbedding;
                    }
                    await dbService.updateContextSource(currentSource.id, sourceUpdates);

                    await refreshSourceData();
                    upsertIngestJob(ingestId, {
                        status: "completed",
                        message: `Indexed ${smartChunks.length} chunk(s) from screenshot.`
                    });
                } catch (err: any) {
                    console.error("Failed to index manual bookmark screenshot:", err);
                    upsertIngestJob(ingestId, {
                        status: "error",
                        message: err?.message || "Failed to index screenshot."
                    });
                }
            })
            .catch((err) => {
                console.error("Bookmark screenshot queue failed:", err);
            });
    };

    const handleDroppedFiles = (fileList: FileList | null) => {
        if (!fileList || !source || source.source_type !== "bookmark") return;
        const files = Array.from(fileList).filter(file => file.type.startsWith("image/"));
        for (const file of files) {
            enqueueBookmarkScreenshot(file, file.name || `manual-screenshot-${Date.now()}.png`);
        }
    };

    const openBookmarkScreenshotViewerAt = (index: number) => {
        if (bookmarkScreenshotAssets.length === 0) return;
        const safeIndex = clamp(index, 0, bookmarkScreenshotAssets.length - 1);
        setBookmarkScreenshotIndex(safeIndex);
        setBookmarkScreenshotZoom(1);
        setBookmarkScreenshotNaturalSize({ width: 0, height: 0 });
        setBookmarkScreenshotFitSize({ width: 0, height: 0 });
        setIsBookmarkScreenshotViewerOpen(true);
    };

    const showPrevBookmarkScreenshot = () => {
        if (bookmarkScreenshotAssets.length <= 1) return;
        setBookmarkScreenshotIndex((prev) => (prev - 1 + bookmarkScreenshotAssets.length) % bookmarkScreenshotAssets.length);
        setBookmarkScreenshotZoom(1);
    };

    const showNextBookmarkScreenshot = () => {
        if (bookmarkScreenshotAssets.length <= 1) return;
        setBookmarkScreenshotIndex((prev) => (prev + 1) % bookmarkScreenshotAssets.length);
        setBookmarkScreenshotZoom(1);
    };

    useEffect(() => {
        if (isCaptureStudioOpen) return;
        if (!isScreenShareActive) return;
        stopScreenShareSession();
    }, [isCaptureStudioOpen]);

    useEffect(() => {
        if (!isScreenShareActive) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.repeat) return;
            if (isAutoCapturing) return;
            const target = event.target as HTMLElement | null;
            const tagName = target?.tagName?.toLowerCase() || "";
            if (tagName === "input" || tagName === "textarea") return;
            if (event.key.toLowerCase() === "c") {
                event.preventDefault();
                handleCaptureFromActiveSession();
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [isScreenShareActive, isCapturingFrame, screenCaptureCount, isAutoCapturing]);

    const handleStartScreenShareSession = async () => {
        if (!source || source.source_type !== "bookmark") return;
        if (isScreenShareActive || isAutoCapturing) return;
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { ideal: 5, max: 10 } },
                audio: false
            });
            screenStreamRef.current = stream;

            const video = screenVideoRef.current;
            if (!video) throw new Error("Preview video is not available.");
            (video as any).srcObject = stream;
            video.muted = true;
            video.playsInline = true;
            await video.play();

            const primaryTrack = stream.getVideoTracks()[0];
            if (primaryTrack) {
                primaryTrack.onended = () => {
                    stopScreenShareSession();
                };
            }

            setIsScreenShareActive(true);
            setScreenCaptureCount(0);
        } catch (err: any) {
            const failedJob: IngestJob = {
                id: `capture-failed-${Date.now()}`,
                label: "Screen Share Session",
                status: "error",
                message: err?.message || "Screen share session failed to start."
            };
            setIngestJobs((prev) => [failedJob, ...prev].slice(0, 8));
            stopScreenShareSession();
        }
    };

    const capturePreviewFrame = async (): Promise<Blob> => {
        const video = screenVideoRef.current;
        if (!video || video.readyState < 2) {
            throw new Error("Stream preview not ready for capture yet.");
        }
        const width = video.videoWidth || 1920;
        const height = video.videoHeight || 1080;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not capture screen frame");
        ctx.drawImage(video, 0, 0, width, height);

        return await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((captured) => {
                if (!captured) {
                    reject(new Error("Failed to capture screenshot from stream"));
                    return;
                }
                resolve(captured);
            }, "image/png", 0.95);
        });
    };

    const handleCaptureFromActiveSession = async () => {
        if (!isScreenShareActive || isCapturingFrame || isAutoCapturing) return;
        if (!screenVideoRef.current || screenVideoRef.current.readyState < 2) {
            const failedJob: IngestJob = {
                id: `capture-failed-${Date.now()}`,
                label: "Screen Share Capture",
                status: "error",
                message: "Stream preview not ready for capture yet."
            };
            setIngestJobs((prev) => [failedJob, ...prev].slice(0, 8));
            return;
        }

        setIsCapturingFrame(true);
        try {
            const blob = await capturePreviewFrame();

            const nextCount = screenCaptureCount + 1;
            setScreenCaptureCount(nextCount);
            enqueueBookmarkScreenshot(
                blob,
                `screen-share-shot-${String(nextCount).padStart(2, "0")}-${new Date().toISOString().replaceAll(":", "-")}.png`
            );
        } catch (err: any) {
            const failedJob: IngestJob = {
                id: `capture-failed-${Date.now()}`,
                label: "Screen Share Capture",
                status: "error",
                message: err?.message || "Failed to capture frame from session."
            };
            setIngestJobs((prev) => [failedJob, ...prev].slice(0, 8));
        } finally {
            setIsCapturingFrame(false);
        }
    };

    const handleAutoCaptureFromSharedPage = async () => {
        if (!source || source.source_type !== "bookmark") return;
        if (!isScreenShareActive) {
            const failedJob: IngestJob = {
                id: `auto-capture-failed-${Date.now()}`,
                label: "Auto Capture Page",
                status: "error",
                message: "Start Screen Share first and share the same webpage tab you want to auto-capture."
            };
            setIngestJobs((prev) => [failedJob, ...prev].slice(0, 8));
            return;
        }
        if (isCapturingFrame || isAutoCapturing) return;

        const url = source.canonical_uri || source.original_uri;
        if (!url) {
            const failedJob: IngestJob = {
                id: `auto-capture-failed-${Date.now()}`,
                label: "Auto Capture Page",
                status: "error",
                message: "Bookmark URL missing. Cannot target a page for auto-scroll."
            };
            setIngestJobs((prev) => [failedJob, ...prev].slice(0, 8));
            return;
        }

        const jobId = `auto-capture-${Date.now()}`;
        pushIngestJob({
            id: jobId,
            label: "Auto Capture Page",
            status: "processing",
            message: "Connecting to MEMUX extension and reading page scroll state..."
        });

        setIsAutoCapturing(true);
        setIsCapturingFrame(true);
        try {
            await memuxExtensionBridge.ping();
            const initial = await memuxExtensionBridge.getScrollState({ url, openIfMissing: false });
            const viewportHeight = Math.max(320, Number(initial.state.viewportHeight || 0));
            const stepPx = Math.max(280, Math.floor(viewportHeight * 0.88));
            const estimatedShots = Math.max(1, Math.ceil(Number(initial.state.maxScrollY || 0) / stepPx) + 1);
            const requestedMaxShots = Math.floor(Number(autoCaptureMaxShots || "18"));
            const maxShots = Number.isFinite(requestedMaxShots)
                ? Math.max(1, Math.min(120, requestedMaxShots))
                : 18;
            const totalShots = Math.min(maxShots, estimatedShots);
            const capped = estimatedShots > maxShots;

            for (let i = 0; i < totalShots; i += 1) {
                const y = Math.min(Number(initial.state.maxScrollY || 0), i * stepPx);
                upsertIngestJob(jobId, {
                    message: `Capturing step ${i + 1}/${totalShots}...`
                });

                await memuxExtensionBridge.scrollTo({ tabId: initial.tabId, y });
                await new Promise((resolve) => window.setTimeout(resolve, 420));

                const blob = await capturePreviewFrame();
                setScreenCaptureCount((prev) => prev + 1);
                enqueueBookmarkScreenshot(
                    blob,
                    `auto-scroll-shot-${String(i + 1).padStart(2, "0")}-${new Date().toISOString().replaceAll(":", "-")}.png`
                );
            }

            upsertIngestJob(jobId, {
                status: "completed",
                message: capped
                    ? `Captured ${totalShots} screenshots (cap reached). OCR + indexing continues in background.`
                    : `Captured ${totalShots} screenshots. OCR + indexing continues in background.`
            });
        } catch (err: any) {
            console.error("Auto capture failed:", err);
            upsertIngestJob(jobId, {
                status: "error",
                message: err?.message || "Auto capture failed. Ensure extension is loaded and the target page tab is open."
            });
        } finally {
            setIsCapturingFrame(false);
            setIsAutoCapturing(false);
        }
    };

    const handleRunDedup = async () => {
        if (!source || isDedupRunning) return;
        const thresholdNum = Math.min(100, Math.max(50, Number(dedupThreshold))) / 100;
        setIsDedupRunning(true);
        setDedupResult(null);
        try {
            const removed = await dbService.deduplicateSourceSegments(source.id, thresholdNum);
            setDedupResult({ removed, ranAt: new Date().toLocaleTimeString() });
            if (removed > 0) await refreshSourceData();
        } catch (err: any) {
            console.error("Manual dedup failed:", err);
            setDedupResult({ removed: -1, ranAt: new Date().toLocaleTimeString() });
        } finally {
            setIsDedupRunning(false);
        }
    };

    const handleDeleteSource = async () => {
        if (!source) return;
        setIsDeleting(true);
        try {
            stopScreenShareSession();
            await dbService.softDeleteContextSource(source.id);
            setIsDeleteOpen(false);
            setLocation("/");
        } catch (err) {
            console.error("Failed to delete context source:", err);
        } finally {
            setIsDeleting(false);
        }
    };

    if (isLoading) {
        return (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
                Loading source details...
            </div>
        );
    }

    if (!source) {
        return (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
                Source not found.
            </div>
        );
    }

    return (
        <div className="flex-1 flex flex-col min-h-0 gap-4">
            <Dialog open={!!selectedSegment} onOpenChange={(open) => !open && setSelectedSegment(null)}>
                <DialogContent className="max-w-[95vw] sm:max-w-6xl border border-border dark:border-white/10 bg-card dark:bg-[#2f3136] rounded-3xl">
                    <DialogHeader>
                        <DialogTitle>
                            {selectedSegment ? `Chunk #${selectedSegment.segment_index} (${selectedSegment.segment_type})` : "Chunk Details"}
                        </DialogTitle>
                    </DialogHeader>

                    {selectedSegment && source.source_type === "bookmark" && (
                        <div className="space-y-3">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div className="cx-subpanel p-3 max-h-[56vh] overflow-auto">
                                    <div className="text-xs font-semibold mb-2">Extracted Website Content</div>
                                    <pre className="text-xs whitespace-pre-wrap break-words font-mono leading-relaxed">
                                        {getDisplayedChunkText(selectedSegment, selectedStructured)}
                                    </pre>
                                </div>
                                <div className="cx-subpanel p-3 max-h-[56vh] overflow-auto">
                                    <div className="text-xs font-semibold mb-2">AI Processed Context</div>
                                    <pre className="text-xs whitespace-pre-wrap break-words font-mono leading-relaxed">
                                        {formatAiProcessedContent(selectedStructured)}
                                    </pre>
                                </div>
                            </div>
                            <div className="cx-subpanel p-3 max-h-[20vh] overflow-auto">
                                <div className="text-xs font-semibold mb-1">Locator JSON</div>
                                <pre className="text-xs whitespace-pre-wrap break-words font-mono">
                                    {JSON.stringify(selectedLocator, null, 2) || "null"}
                                </pre>
                            </div>
                        </div>
                    )}

                    {selectedSegment && source.source_type !== "bookmark" && (
                        <div className="space-y-3">
                            <div className="text-xs text-muted-foreground">
                                Page: {selectedSegment.page_number ?? "-"}
                            </div>
                            <div className="cx-subpanel p-3 max-h-[35vh] overflow-auto">
                                <div className="text-xs font-semibold mb-1">Text</div>
                                <pre className="text-xs whitespace-pre-wrap break-words font-mono">
                                    {selectedSegment.text_content || ""}
                                </pre>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div className="cx-subpanel p-3 max-h-[28vh] overflow-auto">
                                    <div className="text-xs font-semibold mb-1">Structured JSON</div>
                                    <pre className="text-xs whitespace-pre-wrap break-words font-mono">
                                        {JSON.stringify(selectedStructured, null, 2) || "null"}
                                    </pre>
                                </div>
                                <div className="cx-subpanel p-3 max-h-[28vh] overflow-auto">
                                    <div className="text-xs font-semibold mb-1">Locator JSON</div>
                                    <pre className="text-xs whitespace-pre-wrap break-words font-mono">
                                        {JSON.stringify(selectedLocator, null, 2) || "null"}
                                    </pre>
                                </div>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
            <Dialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
                <DialogContent className="sm:max-w-[420px] border border-border dark:border-white/10 bg-card dark:bg-[#2f3136] rounded-3xl">
                    <DialogHeader>
                        <DialogTitle>Delete Source?</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-2 py-2">
                        <p className="text-sm text-muted-foreground">
                            <span className="font-medium text-foreground">{source.title}</span> will be removed from context explorer.
                        </p>
                        {source.source_type === "bookmark" && (
                            <p className="text-xs text-muted-foreground">
                                This also removes related bookmark versions for this URL in this space.
                            </p>
                        )}
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsDeleteOpen(false)} disabled={isDeleting}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={handleDeleteSource} disabled={isDeleting}>
                            {isDeleting ? "Deleting..." : "Delete"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            <Dialog open={isSnipPreviewOpen} onOpenChange={(open) => {
                setIsSnipPreviewOpen(open);
                if (!open) {
                    setSnipZoom(1);
                    setSnipNaturalSize({ width: 0, height: 0 });
                    setSnipFitSize({ width: 0, height: 0 });
                }
            }}>
                <DialogContent className="max-w-[96vw] sm:max-w-6xl max-h-[92vh] overflow-hidden border border-border dark:border-white/10 bg-card dark:bg-[#2f3136] rounded-3xl">
                    <DialogHeader>
                        <DialogTitle className="flex items-center justify-between gap-3">
                            <span className="truncate">Screen Snip Preview</span>
                            <div className="flex items-center gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-8 px-2 rounded-full"
                                    onClick={() => applySnipZoom(snipZoom - 0.2)}
                                >
                                    -
                                </Button>
                                <span className="text-xs text-muted-foreground w-14 text-center">
                                    {Math.round(snipZoom * 100)}%
                                </span>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-8 px-2 rounded-full"
                                    onClick={() => applySnipZoom(snipZoom + 0.2)}
                                >
                                    +
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-8 px-3 rounded-full"
                                    onClick={() => applySnipZoom(1)}
                                >
                                    Reset
                                </Button>
                            </div>
                        </DialogTitle>
                    </DialogHeader>
                    <div
                        ref={snipViewportRef}
                        className="h-[74vh] rounded-2xl border border-border/70 dark:border-white/10 bg-black/25 overflow-auto p-3"
                        onClick={(event) => {
                            if (snipZoom > 1) {
                                applySnipZoom(1, { clientX: event.clientX, clientY: event.clientY });
                            } else {
                                applySnipZoom(2, { clientX: event.clientX, clientY: event.clientY });
                            }
                        }}
                        onMouseMove={(event) => {
                            const viewport = snipViewportRef.current;
                            if (!viewport || snipZoom <= 1) return;
                            const rect = viewport.getBoundingClientRect();
                            const ratioX = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
                            const ratioY = clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
                            const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
                            const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
                            viewport.scrollLeft = ratioX * maxLeft;
                            viewport.scrollTop = ratioY * maxTop;
                        }}
                        onWheel={(event) => {
                            if (!event.ctrlKey) return;
                            event.preventDefault();
                            const delta = event.deltaY < 0 ? 0.15 : -0.15;
                            applySnipZoom(snipZoom + delta, { clientX: event.clientX, clientY: event.clientY });
                        }}
                    >
                        {primarySnipPreviewUrl ? (
                            <div
                                style={{
                                    width: `${Math.max(1, snipFitSize.width * snipZoom)}px`,
                                    height: `${Math.max(1, snipFitSize.height * snipZoom)}px`
                                }}
                            >
                                <img
                                    src={primarySnipPreviewUrl}
                                    alt={source.title}
                                    className="select-none"
                                    style={{
                                        width: `${Math.max(1, snipFitSize.width * snipZoom)}px`,
                                        height: `${Math.max(1, snipFitSize.height * snipZoom)}px`,
                                        objectFit: "contain"
                                    }}
                                    onLoad={(event) => {
                                        const img = event.currentTarget;
                                        setSnipNaturalSize({
                                            width: img.naturalWidth || 0,
                                            height: img.naturalHeight || 0
                                        });
                                        requestAnimationFrame(() => {
                                            recomputeSnipFitSize();
                                            const viewport = snipViewportRef.current;
                                            if (viewport) {
                                                viewport.scrollLeft = 0;
                                                viewport.scrollTop = 0;
                                            }
                                        });
                                    }}
                                />
                            </div>
                        ) : (
                            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                                Snip image preview unavailable.
                            </div>
                        )}
                    </div>
                </DialogContent>
            </Dialog>
            <Dialog open={isBookmarkScreenshotViewerOpen} onOpenChange={(open) => {
                setIsBookmarkScreenshotViewerOpen(open);
                if (!open) {
                    setBookmarkScreenshotZoom(1);
                    setBookmarkScreenshotNaturalSize({ width: 0, height: 0 });
                    setBookmarkScreenshotFitSize({ width: 0, height: 0 });
                }
            }}>
                <DialogContent className="max-w-[96vw] sm:max-w-6xl max-h-[92vh] overflow-hidden border border-border dark:border-white/10 bg-card dark:bg-[#2f3136] rounded-3xl">
                    <DialogHeader>
                        <DialogTitle className="flex items-center justify-between gap-3">
                            <span className="truncate">
                                Bookmark Screenshot {bookmarkScreenshotAssets.length > 0 ? `${bookmarkScreenshotIndex + 1}/${bookmarkScreenshotAssets.length}` : ""}
                            </span>
                            <div className="flex items-center gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-8 px-2 rounded-full"
                                    onClick={() => applyBookmarkScreenshotZoom(bookmarkScreenshotZoom - 0.2)}
                                >
                                    -
                                </Button>
                                <span className="text-xs text-muted-foreground w-14 text-center">
                                    {Math.round(bookmarkScreenshotZoom * 100)}%
                                </span>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-8 px-2 rounded-full"
                                    onClick={() => applyBookmarkScreenshotZoom(bookmarkScreenshotZoom + 0.2)}
                                >
                                    +
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-8 px-3 rounded-full"
                                    onClick={() => applyBookmarkScreenshotZoom(1)}
                                >
                                    Reset
                                </Button>
                            </div>
                        </DialogTitle>
                    </DialogHeader>

                    <div className="flex items-center gap-2 mb-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 px-2 rounded-full"
                            onClick={showPrevBookmarkScreenshot}
                            disabled={bookmarkScreenshotAssets.length <= 1}
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 px-2 rounded-full"
                            onClick={showNextBookmarkScreenshot}
                            disabled={bookmarkScreenshotAssets.length <= 1}
                        >
                            <ChevronRight className="h-4 w-4" />
                        </Button>
                        <span className="text-xs text-muted-foreground">
                            Use keyboard arrows to navigate
                        </span>
                    </div>

                    <div
                        ref={bookmarkScreenshotViewportRef}
                        className="h-[70vh] rounded-2xl border border-border/70 dark:border-white/10 bg-black/25 overflow-auto p-3"
                        onClick={(event) => {
                            if (bookmarkScreenshotZoom > 1) {
                                applyBookmarkScreenshotZoom(1, { clientX: event.clientX, clientY: event.clientY });
                            } else {
                                applyBookmarkScreenshotZoom(2, { clientX: event.clientX, clientY: event.clientY });
                            }
                        }}
                        onMouseMove={(event) => {
                            const viewport = bookmarkScreenshotViewportRef.current;
                            if (!viewport || bookmarkScreenshotZoom <= 1) return;
                            const rect = viewport.getBoundingClientRect();
                            const ratioX = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
                            const ratioY = clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
                            const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
                            const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
                            viewport.scrollLeft = ratioX * maxLeft;
                            viewport.scrollTop = ratioY * maxTop;
                        }}
                        onWheel={(event) => {
                            if (!event.ctrlKey) return;
                            event.preventDefault();
                            const delta = event.deltaY < 0 ? 0.15 : -0.15;
                            applyBookmarkScreenshotZoom(bookmarkScreenshotZoom + delta, { clientX: event.clientX, clientY: event.clientY });
                        }}
                    >
                        {activeBookmarkScreenshotUrl ? (
                            <div
                                style={{
                                    width: `${Math.max(1, bookmarkScreenshotFitSize.width * bookmarkScreenshotZoom)}px`,
                                    height: `${Math.max(1, bookmarkScreenshotFitSize.height * bookmarkScreenshotZoom)}px`
                                }}
                            >
                                <img
                                    src={activeBookmarkScreenshotUrl}
                                    alt={activeBookmarkScreenshot?.asset_type || "Bookmark screenshot"}
                                    className="select-none"
                                    style={{
                                        width: `${Math.max(1, bookmarkScreenshotFitSize.width * bookmarkScreenshotZoom)}px`,
                                        height: `${Math.max(1, bookmarkScreenshotFitSize.height * bookmarkScreenshotZoom)}px`,
                                        objectFit: "contain"
                                    }}
                                    onLoad={(event) => {
                                        const img = event.currentTarget;
                                        setBookmarkScreenshotNaturalSize({
                                            width: img.naturalWidth || 0,
                                            height: img.naturalHeight || 0
                                        });
                                        requestAnimationFrame(() => {
                                            recomputeBookmarkScreenshotFitSize();
                                            const viewport = bookmarkScreenshotViewportRef.current;
                                            if (viewport) {
                                                viewport.scrollLeft = 0;
                                                viewport.scrollTop = 0;
                                            }
                                        });
                                    }}
                                />
                            </div>
                        ) : (
                            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                                Screenshot preview unavailable.
                            </div>
                        )}
                    </div>
                </DialogContent>
            </Dialog>

            <div className="flex items-center justify-between border-b border-border dark:border-white/10 pb-3">
                <div className="flex items-center gap-3 min-w-0">
                    <Button variant="ghost" size="icon" className="rounded-full" onClick={() => setLocation("/")}>
                        <ArrowLeft className="h-4 w-4" />
                    </Button>
                    {source.source_type === "bookmark" ? <Link2 className="h-5 w-5 text-muted-foreground" /> : source.source_type === "snip" ? <ImageIcon className="h-5 w-5 text-muted-foreground" /> : <FileText className="h-5 w-5 text-muted-foreground" />}
                    <div className="min-w-0">
                        <h2 className="text-xl font-semibold truncate">{source.title}</h2>
                        <p className="text-xs text-muted-foreground capitalize">
                            {source.source_type} • {source.status} • {visibleSegments.length} chunks
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {source.canonical_uri && (
                        <Button variant="outline" size="sm" className="rounded-full border-border dark:border-white/10" asChild>
                            <a href={source.canonical_uri} target="_blank" rel="noreferrer">
                                <ExternalLink className="h-4 w-4 mr-2" />
                                Open Source
                            </a>
                        </Button>
                    )}
                    {source.source_type === "pdf" && source.legacy_document_id && (
                        <Button variant="outline" size="sm" className="rounded-full border-border dark:border-white/10" onClick={() => setLocation(`/document/${source.legacy_document_id}`)}>
                            <TableProperties className="h-4 w-4 mr-2" />
                            PDF Table View
                        </Button>
                    )}
                    <Button
                        variant="outline"
                        size="sm"
                        className="rounded-full border-border dark:border-white/10"
                        onClick={() => {
                            setFocusedSpaceIds([source.space_id]);
                            setLocation(`/chat?focus_spaces=${source.space_id}`);
                        }}
                    >
                        <MessageSquare className="h-4 w-4 mr-2" />
                        Chat This Space
                    </Button>
                    {source.source_type !== "pdf" && (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-white/8 dark:hover:bg-white/8">
                                    <MoreVertical className="h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                    className="text-destructive focus:text-destructive cursor-pointer"
                                    onClick={() => setIsDeleteOpen(true)}
                                >
                                    <Trash className="mr-2 h-4 w-4" />
                                    Delete Source
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                </div>
            </div>

            {source.source_type === "bookmark" && (
                <Card className="cx-surface bg-muted/30 dark:bg-[#2a2d31]">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center justify-between">
                            <span>Bookmark Summary</span>
                            <div className="flex items-center gap-2">
                                {versions.length > 0 ? (
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-8 rounded-full border-border dark:border-white/10 text-xs"
                                            >
                                                v{source.version_no || 1}{source.is_latest ? " • latest" : ""}
                                                <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end" className="min-w-[180px]">
                                            {versions.map((version) => {
                                                const isActive = version.id === source.id;
                                                return (
                                                    <DropdownMenuItem
                                                        key={version.id}
                                                        className={`cursor-pointer ${isActive ? "bg-muted/50 dark:bg-white/10" : ""}`}
                                                        onClick={() => {
                                                            if (isActive) return;
                                                            setLocation(`/source/${version.id}`);
                                                        }}
                                                    >
                                                        <span className="text-xs font-medium">
                                                            v{version.version_no || 1}
                                                        </span>
                                                        {version.is_latest ? (
                                                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-400/25 dark:text-emerald-100">
                                                                latest
                                                            </span>
                                                        ) : null}
                                                    </DropdownMenuItem>
                                                );
                                            })}
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                ) : (
                                    <span className="text-xs text-muted-foreground font-normal">
                                        v{source.version_no || 1}{source.is_latest ? " • latest" : ""}
                                    </span>
                                )}
                            </div>
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">
                            {bookmarkSummary || "No summary generated for this bookmark yet."}
                        </p>
                    </CardContent>
                </Card>
            )}

            {source.source_type === "bookmark" && (
                <Card className="cx-surface bg-muted/30 dark:bg-[#2a2d31]">
                    <CardHeader className="pb-2 pt-4 px-4">
                        <CardTitle className="text-sm flex items-center gap-2">
                            <Eraser className="h-3.5 w-3.5 text-muted-foreground" />
                            De-duplicate Segments
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4">
                        <p className="text-xs text-muted-foreground mb-3">
                            Scans all paragraph/OCR chunks of this bookmark and removes near-identical ones (repeated nav, footers, etc.). Keeps the longest copy.
                        </p>
                        <div className="flex items-center gap-2">
                            <div className="flex items-center gap-1.5">
                                <label className="text-xs text-muted-foreground whitespace-nowrap">Threshold</label>
                                <input
                                    type="number"
                                    min={50}
                                    max={100}
                                    step={1}
                                    value={dedupThreshold}
                                    onChange={(e) => setDedupThreshold(e.target.value)}
                                    className="w-16 text-xs rounded-md border border-border dark:border-white/10 bg-background px-2 py-1 text-center focus:outline-none focus:ring-1 focus:ring-ring"
                                    disabled={isDedupRunning}
                                />
                                <span className="text-xs text-muted-foreground">%</span>
                            </div>
                            <Button
                                size="sm"
                                variant="outline"
                                className="rounded-full border-border dark:border-white/10 text-xs h-8"
                                onClick={handleRunDedup}
                                disabled={isDedupRunning}
                            >
                                {isDedupRunning ? (
                                    <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Running...</>
                                ) : (
                                    <><Eraser className="h-3.5 w-3.5 mr-1.5" /> Run Deduplication</>
                                )}
                            </Button>
                        </div>
                        {dedupResult && (
                            <p className="text-xs mt-2.5">
                                {dedupResult.removed < 0
                                    ? <span className="text-destructive">Error running deduplication. Check console.</span>
                                    : dedupResult.removed === 0
                                        ? <span className="text-muted-foreground">No duplicates found at {dedupThreshold}% threshold. (ran at {dedupResult.ranAt})</span>
                                        : <span className="text-emerald-600 dark:text-emerald-400 font-medium">✓ Removed {dedupResult.removed} duplicate segment{dedupResult.removed > 1 ? 's' : ''} (ran at {dedupResult.ranAt})</span>
                                }
                            </p>
                        )}
                    </CardContent>
                </Card>
            )}

            {source.source_type === "snip" && (
                <div className="w-full max-w-[520px] self-start space-y-3">
                    <Card className="cx-surface overflow-hidden w-full">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm">Screen Snip Preview</CardTitle>
                        </CardHeader>
                        <CardContent className="w-full">
                            {primarySnipAsset && assetPreviewUrls[primarySnipAsset.id] ? (
                                <button
                                    type="button"
                                    className="block w-full rounded-xl border border-border/70 dark:border-white/10 bg-black/20 overflow-hidden cursor-zoom-in"
                                    onClick={() => setIsSnipPreviewOpen(true)}
                                    title="Open full preview"
                                >
                                    <div className="w-full h-56 md:h-60 flex items-center justify-center p-2 overflow-hidden">
                                        <img
                                            src={assetPreviewUrls[primarySnipAsset.id]}
                                            alt={source.title}
                                            className="block w-full h-full object-contain"
                                            style={{ maxWidth: "100%", maxHeight: "100%" }}
                                        />
                                    </div>
                                </button>
                            ) : (
                                <div className="w-full h-48 rounded-xl border border-border/70 dark:border-white/10 bg-muted/20 dark:bg-[#26292d] flex items-center justify-center text-sm text-muted-foreground">
                                    Snip image preview unavailable.
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    <Card className="cx-surface w-full">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm">Source Metadata</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <pre className="text-[10px] whitespace-pre-wrap break-all font-mono text-muted-foreground max-h-[150px] overflow-auto">
                                {JSON.stringify(metadata || {}, null, 2)}
                            </pre>
                        </CardContent>
                    </Card>
                </div>
            )}

            <div className={`grid min-h-0 gap-4 items-start ${source.source_type === "bookmark" ? "grid-cols-1 lg:grid-cols-[2fr_1fr]" : "grid-cols-1"}`}>
                <Card className="min-h-0 cx-surface">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm">
                            {source.source_type === "bookmark" ? "Website Chunk Mapping" : "Chunk Mapping"}
                        </CardTitle>
                    </CardHeader>
                    <CardContent className={`overflow-auto ${source.source_type === "snip" ? "max-h-[520px]" : "max-h-[620px]"}`}>
                        {source.source_type === "bookmark" ? (
                            <div className="space-y-3">
                                {bookmarkHierarchy.length === 0 ? (
                                    <div className="text-center text-sm text-muted-foreground py-8">
                                        No section/paragraph chunks found for this bookmark.
                                    </div>
                                ) : (
                                    bookmarkHierarchy.map((section, sectionIdx) => {
                                        const isExpanded = expandedSections[section.sectionId] !== false;
                                        return (
                                            <div key={section.sectionId} className="border border-border/70 dark:border-white/10 rounded-2xl overflow-hidden bg-muted/15 dark:bg-[#25282d]">
                                                <button
                                                    type="button"
                                                    className="w-full flex items-start justify-between gap-3 px-3 py-2 text-left cx-row-hover"
                                                    onClick={() => toggleSection(section.sectionId)}
                                                >
                                                    <div className="min-w-0">
                                                        <div className="text-xs text-muted-foreground">
                                                            Section {sectionIdx + 1} • {section.channel}
                                                        </div>
                                                        <div className="font-medium text-sm truncate">{section.heading}</div>
                                                        <div className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
                                                            {compactText(section.summary || "No section summary.", 240)}
                                                        </div>
                                                    </div>
                                                    <div className="shrink-0 mt-1">
                                                        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                                    </div>
                                                </button>

                                                {isExpanded && (
                                                    <div className="border-t border-border/60 dark:border-white/10 bg-black/[0.02] dark:bg-black/10">
                                                        {section.sectionSegment && (
                                                            <div className="px-3 py-2 border-b">
                                                                <Button
                                                                    variant="outline"
                                                                    size="sm"
                                                                    className="text-xs h-7 rounded-full border-border dark:border-white/10"
                                                                    onClick={() => setSelectedSegment(section.sectionSegment)}
                                                                >
                                                                    Open Section AI Summary
                                                                </Button>
                                                            </div>
                                                        )}
                                                        {section.paragraphs.length === 0 ? (
                                                            <div className="px-3 py-3 text-xs text-muted-foreground">
                                                                No paragraph chunks in this section.
                                                            </div>
                                                        ) : (
                                                            <div className="divide-y">
                                                                {section.paragraphs.map((paragraph, paraIdx) => (
                                                                    <button
                                                                        key={paragraph.segment.id}
                                                                        type="button"
                                                                        className="w-full text-left px-3 py-2 cx-row-hover"
                                                                        onClick={() => setSelectedSegment(paragraph.segment)}
                                                                    >
                                                                        <div className="flex items-center justify-between gap-2">
                                                                            <div className="text-xs font-medium">
                                                                                Paragraph {paraIdx + 1}
                                                                            </div>
                                                                            <div className="text-[10px] text-muted-foreground">
                                                                                {paragraph.channel}
                                                                            </div>
                                                                        </div>
                                                                        <div className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
                                                                            {compactText(getDisplayedChunkText(paragraph.segment, parseJson(paragraph.segment.structured_json)), 300)}
                                                                        </div>
                                                                        <div className="text-xs text-muted-foreground/90 mt-1 whitespace-pre-wrap">
                                                                            {paragraph.summary ? compactText(paragraph.summary, 220) : "No AI paragraph summary."}
                                                                        </div>
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        ) : (
                            <Table>
                                <TableHeader className="cx-table-header sticky top-0">
                                    <TableRow>
                                        <TableHead className="text-[11px] uppercase tracking-wide text-muted-foreground">#</TableHead>
                                        <TableHead className="text-[11px] uppercase tracking-wide text-muted-foreground">Type</TableHead>
                                        <TableHead className="text-[11px] uppercase tracking-wide text-muted-foreground">Page</TableHead>
                                        <TableHead className="text-[11px] uppercase tracking-wide text-muted-foreground">Chunk Text</TableHead>
                                        <TableHead className="text-[11px] uppercase tracking-wide text-muted-foreground">Structured Data</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {visibleSegments.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={5} className="text-center text-muted-foreground">
                                                No chunks found for this source.
                                            </TableCell>
                                        </TableRow>
                                    ) : (
                                        visibleSegments.map((segment) => {
                                            const structured = parseJson(segment.structured_json);
                                            const heading = structured && typeof structured === "object" ? structured.heading : null;
                                            return (
                                                <TableRow
                                                    key={segment.id}
                                                    className="cursor-pointer cx-row-hover"
                                                    onClick={() => setSelectedSegment(segment)}
                                                >
                                                    <TableCell>{segment.segment_index}</TableCell>
                                                    <TableCell className="text-xs">
                                                        {segment.segment_type === "ocr_block"
                                                            ? "OCR Block"
                                                            : segment.segment_type === "caption"
                                                                ? "Caption"
                                                                : segment.segment_type === "paragraph"
                                                                    ? "Paragraph"
                                                                    : segment.segment_type}
                                                    </TableCell>
                                                    <TableCell>{segment.page_number ?? "-"}</TableCell>
                                                    <TableCell className="max-w-[380px]">
                                                        <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                                                            {heading ? `${heading}\n` : ""}
                                                            {compactText(getDisplayedChunkText(segment, structured))}
                                                        </p>
                                                    </TableCell>
                                                    <TableCell className="max-w-[260px]">
                                                        <pre className="text-[10px] whitespace-pre-wrap text-muted-foreground">
                                                            {structured ? compactText(JSON.stringify(structured, null, 2), 220) : "—"}
                                                        </pre>
                                                    </TableCell>
                                                </TableRow>
                                            );
                                        })
                                    )}
                                </TableBody>
                            </Table>
                        )}
                    </CardContent>
                </Card>

                {source.source_type === "bookmark" && (
                    <Card className="min-h-0 max-h-[620px] flex flex-col cx-surface">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm">Enhance Context with Screenshots</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3 overflow-y-auto pr-1">
                            <p className="text-xs text-muted-foreground">
                                Use capture studio for upload, screen share snips, and auto-scroll capture.
                            </p>
                            <Button
                                size="sm"
                                onClick={() => setIsCaptureStudioOpen(true)}
                                className="w-full rounded-full border-none text-black font-semibold bg-gradient-to-r from-[#EEDFB5] via-[#DB96D1] via-[#E79BB8] to-[#F2C3A7] hover:opacity-95"
                            >
                                Open Capture Studio
                            </Button>

                            <div className="space-y-2">
                                <div className="text-xs font-medium text-muted-foreground">Background Indexing</div>
                                {ingestJobs.length === 0 ? (
                                    <div className="text-xs text-muted-foreground cx-subpanel p-2">
                                        No screenshot indexing jobs yet.
                                    </div>
                                ) : (
                                    <div className="space-y-1 max-h-[180px] overflow-auto">
                                        {ingestJobs.map((job) => (
                                            <div key={job.id} className="cx-subpanel p-2">
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className="text-xs font-medium truncate">{job.label}</span>
                                                    <span className={`text-[10px] uppercase tracking-wide ${job.status === "completed" ? "text-emerald-600" : job.status === "error" ? "text-destructive" : "text-amber-600"}`}>
                                                        {job.status}
                                                    </span>
                                                </div>
                                                <div className="text-xs text-muted-foreground mt-1">{job.message}</div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="space-y-2">
                                <div className="text-xs font-medium text-muted-foreground">
                                    Bookmark Screenshots ({bookmarkScreenshotAssets.length})
                                </div>
                                <div className="grid grid-cols-2 gap-2 max-h-[240px] overflow-auto">
                                    {bookmarkScreenshotAssets.map((asset, index) => (
                                        <button
                                            key={asset.id}
                                            type="button"
                                            className="border border-border/70 dark:border-white/10 rounded-xl overflow-hidden bg-muted/20 dark:bg-[#26292d] text-left cursor-zoom-in hover:border-border dark:hover:border-white/25 transition-colors"
                                            onClick={() => openBookmarkScreenshotViewerAt(index)}
                                            title={`Open screenshot ${index + 1}`}
                                        >
                                            <img
                                                src={assetPreviewUrls[asset.id]}
                                                alt={`Bookmark screenshot ${index + 1}`}
                                                className="w-full h-24 object-cover"
                                            />
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                )}
            </div>

            {source.source_type === "bookmark" && (
                <Dialog open={isCaptureStudioOpen} onOpenChange={setIsCaptureStudioOpen}>
                    <DialogContent className="max-w-[95vw] sm:max-w-4xl max-h-[92vh] overflow-y-auto border border-border dark:border-white/10 bg-card dark:bg-[#2f3136] rounded-3xl">
                        <DialogHeader>
                            <DialogTitle>Screenshot Capture Studio</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-4">
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                multiple
                                className="hidden"
                                onChange={(event) => {
                                    handleDroppedFiles(event.target.files);
                                    event.currentTarget.value = "";
                                }}
                            />

                            <div
                                className={`border rounded-2xl p-4 text-center transition-colors ${isDropActive ? "border-primary bg-primary/5" : "border-dashed border-border dark:border-white/20 bg-muted/15 dark:bg-[#26292d]"}`}
                                onDragOver={(event) => {
                                    event.preventDefault();
                                    setIsDropActive(true);
                                }}
                                onDragLeave={(event) => {
                                    event.preventDefault();
                                    setIsDropActive(false);
                                }}
                                onDrop={(event) => {
                                    event.preventDefault();
                                    setIsDropActive(false);
                                    handleDroppedFiles(event.dataTransfer.files);
                                }}
                            >
                                <p className="text-sm font-medium">Drop screenshots here</p>
                                <p className="text-xs text-muted-foreground mt-1">
                                    Added images are OCR indexed and attached to this bookmark for retrieval.
                                </p>

                                <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-3 mt-3 items-end">
                                    <div className="text-left">
                                        <label className="text-[11px] font-medium text-muted-foreground">Max pics (auto)</label>
                                        <input
                                            type="number"
                                            min={1}
                                            max={120}
                                            value={autoCaptureMaxShots}
                                            onChange={(event) => setAutoCaptureMaxShots(event.target.value)}
                                            className="mt-1 w-full border border-border dark:border-white/10 rounded-full bg-background dark:bg-[#23252a] px-3 py-1.5 text-xs"
                                        />
                                    </div>
                                    <div className="flex gap-2 justify-start sm:justify-end flex-wrap">
                                        <Button size="sm" variant="outline" className="rounded-full border-border dark:border-white/10" onClick={() => fileInputRef.current?.click()}>
                                            Upload Screenshot(s)
                                        </Button>
                                        {!isScreenShareActive ? (
                                            <Button size="sm" className="rounded-full" onClick={handleStartScreenShareSession} disabled={isAutoCapturing}>
                                                Start Screen Share
                                            </Button>
                                        ) : (
                                            <>
                                                <Button
                                                    size="sm"
                                                    onClick={handleCaptureFromActiveSession}
                                                    disabled={isCapturingFrame || isAutoCapturing}
                                                    className="rounded-full"
                                                >
                                                    {isCapturingFrame ? "Capturing..." : "Capture Shot"}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="rounded-full border-border dark:border-white/10"
                                                    onClick={handleAutoCaptureFromSharedPage}
                                                    disabled={isAutoCapturing}
                                                >
                                                    {isAutoCapturing ? "Auto Capturing..." : "Auto Capture Page"}
                                                </Button>
                                                <Button size="sm" variant="outline" className="rounded-full border-border dark:border-white/10" onClick={stopScreenShareSession} disabled={isAutoCapturing}>
                                                    Stop Session
                                                </Button>
                                            </>
                                        )}
                                    </div>
                                </div>

                                <div className="mt-3 space-y-2">
                                    {isScreenShareActive ? (
                                        <div className="text-[11px] text-muted-foreground">
                                            Screen-share session active. Press <span className="font-semibold">C</span> or click
                                            <span className="font-semibold"> Capture Shot</span> to snip moments.
                                        </div>
                                    ) : (
                                        <div className="text-[11px] text-muted-foreground">
                                            Start a session to preview your shared screen and capture moments.
                                        </div>
                                    )}
                                    <div className="rounded-md border overflow-hidden bg-black/30">
                                        <video
                                            ref={screenVideoRef}
                                            autoPlay
                                            muted
                                            playsInline
                                            className="w-full h-56 object-contain bg-black"
                                        />
                                    </div>
                                    <div className="text-[11px] text-muted-foreground">
                                        Captured in this session: {screenCaptureCount}
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <div className="text-xs font-medium text-muted-foreground">Background Indexing</div>
                                {ingestJobs.length === 0 ? (
                                    <div className="text-xs text-muted-foreground cx-subpanel p-2">
                                        No screenshot indexing jobs yet.
                                    </div>
                                ) : (
                                    <div className="space-y-1 max-h-[220px] overflow-auto">
                                        {ingestJobs.map((job) => (
                                            <div key={job.id} className="cx-subpanel p-2">
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className="text-xs font-medium truncate">{job.label}</span>
                                                    <span className={`text-[10px] uppercase tracking-wide ${job.status === "completed" ? "text-emerald-600" : job.status === "error" ? "text-destructive" : "text-amber-600"}`}>
                                                        {job.status}
                                                    </span>
                                                </div>
                                                <div className="text-xs text-muted-foreground mt-1">{job.message}</div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </DialogContent>
                </Dialog>
            )}

            {source.source_type !== "bookmark" && source.source_type !== "snip" && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-1">
                    <Card className="cx-surface">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm">Source Metadata</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2 text-xs">
                            {source.canonical_uri && (
                                <a href={source.canonical_uri} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                                    Open canonical URL
                                    <ExternalLink className="h-3 w-3" />
                                </a>
                            )}
                            <pre className="text-[10px] bg-muted/40 dark:bg-[#25282d] p-2 rounded-xl whitespace-pre-wrap">
                                {JSON.stringify(metadata || {}, null, 2)}
                            </pre>
                        </CardContent>
                    </Card>

                    <Card className="cx-surface">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm">Assets ({assets.length})</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3 max-h-[280px] overflow-auto">
                            {assets.length === 0 ? (
                                <p className="text-xs text-muted-foreground">No assets found.</p>
                            ) : (
                                assets.map((asset) => (
                                    <div key={asset.id} className="border border-border/70 dark:border-white/10 rounded-xl p-2 space-y-1 bg-muted/10 dark:bg-[#25282d]">
                                        <div className="text-[10px] text-muted-foreground capitalize">
                                            {asset.asset_type} • {asset.mime_type || "unknown"}
                                        </div>
                                        {assetPreviewUrls[asset.id] && (
                                            <img
                                                src={assetPreviewUrls[asset.id]}
                                                alt={asset.asset_type}
                                                className="w-full rounded border"
                                            />
                                        )}
                                    </div>
                                ))
                            )}
                        </CardContent>
                    </Card>
                </div>
            )}
        </div>
    );
}
