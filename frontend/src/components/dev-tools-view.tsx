import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dbService, type DevPageExtraction } from "@/services/db-service";
import { apiService } from "@/services/api-service";
import { useExtractionStore } from "@/store/extraction-store";
import { ChevronDown, ChevronUp, ExternalLink, RefreshCw, Search, Trash2, Plus } from "lucide-react";

function formatDate(value?: string | null): string {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
}

function buildSourceHighlight(text: string, start: number, end: number, context: number = 240) {
    const safeText = String(text || "");
    const safeStart = Math.max(0, Math.min(safeText.length, Number(start || 0)));
    const safeEnd = Math.max(safeStart, Math.min(safeText.length, Number(end || safeStart)));
    const from = Math.max(0, safeStart - context);
    const to = Math.min(safeText.length, safeEnd + context);
    return {
        before: safeText.slice(from, safeStart),
        highlight: safeText.slice(safeStart, safeEnd),
        after: safeText.slice(safeEnd, to),
        clipped_from: from,
        clipped_to: to
    };
}

export default function DevToolsView() {
    const [items, setItems] = useState<DevPageExtraction[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isRefining, setIsRefining] = useState(false);
    const [refineStatus, setRefineStatus] = useState<string>("");
    const [selectedFragmentId, setSelectedFragmentId] = useState<string | null>(null);
    const [isInspectOpen, setIsInspectOpen] = useState(false);
    const [isIngesting, setIsIngesting] = useState(false);
    const addDevExtractionToContext = useExtractionStore((state) => state.addDevExtractionToContext);

    const loadItems = async () => {
        setLoading(true);
        try {
            const rows = await dbService.getDevPageExtractions(200);
            setItems(rows);
            if (!rows.length) {
                setSelectedId(null);
                return;
            }
            if (!selectedId || !rows.some((row) => row.id === selectedId)) {
                setSelectedId(rows[0].id);
            }
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadItems();
    }, []);

    const selected = useMemo(
        () => items.find((item) => item.id === selectedId) || null,
        [items, selectedId]
    );

    const payload = selected?.payload_json || {};
    const hyperlinks = Array.isArray(payload.hyperlinks) ? payload.hyperlinks : [];
    const images = Array.isArray(payload.images) ? payload.images : [];
    const hierarchyText =
        (typeof selected?.hierarchy_text === "string" && selected.hierarchy_text) ||
        (typeof payload.hierarchy_text === "string" ? payload.hierarchy_text : "");
    const plainText =
        (typeof selected?.plain_text === "string" && selected.plain_text) ||
        (typeof payload.plain_text === "string" ? payload.plain_text : "");
    const refinementPayload =
        (payload && typeof payload.dev_bookmark_refinement === "object" && payload.dev_bookmark_refinement)
            ? payload.dev_bookmark_refinement
            : (
                payload && payload.extractor === "dev_bookmark_fragment_refiner_v1"
                    ? payload
                    : null
            );
    const refinedFragments = Array.isArray(refinementPayload?.fragments) ? refinementPayload.fragments : [];
    const refinementDebug = refinementPayload?.debug_info || null;
    const refinementSourceText =
        (typeof payload.source_raw_text === "string" && payload.source_raw_text) ||
        (typeof payload.raw_text === "string" && payload.raw_text) ||
        plainText ||
        "";
    const selectedFragment = refinedFragments.find((frag: any) => String(frag?.fragment_id || "") === selectedFragmentId) || null;

    useEffect(() => {
        if (!refinedFragments.length) {
            setSelectedFragmentId(null);
            return;
        }
        const exists = refinedFragments.some((frag: any) => String(frag?.fragment_id || "") === selectedFragmentId);
        if (!exists) {
            setSelectedFragmentId(String(refinedFragments[0]?.fragment_id || ""));
        }
    }, [selectedId, refinedFragments.length]);

    const selectedFragmentMapping = selectedFragment?.source_mapping || {};
    const selectedStart = Number(selectedFragmentMapping?.absolute_start_char);
    const selectedEnd = Number(selectedFragmentMapping?.absolute_end_char);
    const selectedPreview = Number.isFinite(selectedStart) && Number.isFinite(selectedEnd) && refinementSourceText
        ? buildSourceHighlight(refinementSourceText, selectedStart, selectedEnd, 260)
        : null;

    const handleDeleteSelected = async () => {
        if (!selected) return;
        setIsDeleting(true);
        try {
            await dbService.deleteDevPageExtraction(selected.id);
            await loadItems();
        } finally {
            setIsDeleting(false);
        }
    };

    const copyPayload = async () => {
        if (!selected) return;
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    };

    const handleAddToWorkspace = async () => {
        if (!selected) return;
        setIsIngesting(true);
        setRefineStatus("Ingesting to Workspace...");
        try {
            await addDevExtractionToContext(selected.id);
            setRefineStatus("Successfully added to Workspace! Check top left.");
        } catch (error: any) {
            setRefineStatus(`Failed to add: ${error?.message || String(error)}`);
        } finally {
            setIsIngesting(false);
        }
    };

    const runDevRefinement = async () => {
        if (!selected) return;
        const sourceRawText = (plainText || "").trim();
        const sourceHierarchyText = (hierarchyText || "").trim();
        if (!sourceRawText) {
            setRefineStatus("No plain text found for this extraction.");
            return;
        }

        setIsRefining(true);
        setRefineStatus("Running agentic fragment refinement...");
        try {
            const result = await apiService.processDevBookmarkFragments({
                source_title: selected.title || selected.url || "source",
                raw_text: sourceRawText,
                hierarchy_text: sourceHierarchyText,
                max_window_chars: 12000,
                overlap_chars: 1200
            });

            const refinedHierarchyText = Array.isArray(result.fragments)
                ? result.fragments
                    .map((f: any) => {
                        const heading = String(f?.hierarchy?.heading || "General");
                        const topic = String(f?.hierarchy?.topic || "Topic");
                        const prefix = Array.isArray(f?.context_prefix) && f.context_prefix.length > 0
                            ? ` (${f.context_prefix.join(", ")})`
                            : "";
                        return `- [${heading} > ${topic}] ${String(f?.summary || "")}${prefix}`;
                    })
                    .join("\n")
                : "";
            const refinedPlainText = Array.isArray(result.fragments)
                ? result.fragments.map((f: any) => String(f?.text || "")).join("\n\n")
                : "";

            const payloadToSave = {
                extractor: "dev_bookmark_fragment_refiner_v1",
                parent_extraction_id: selected.id,
                source_url: selected.url,
                source_title: selected.title || selected.url,
                source_raw_text: sourceRawText,
                source_hierarchy_text: sourceHierarchyText,
                node_count: Array.isArray(result.fragments) ? result.fragments.length : 0,
                link_count: Array.isArray(payload.hyperlinks) ? payload.hyperlinks.length : 0,
                hierarchy_text: refinedHierarchyText,
                plain_text: refinedPlainText,
                dev_bookmark_refinement: result
            };

            const savedId = await dbService.saveDevPageExtraction({
                url: selected.url,
                title: `${selected.title || selected.url} [Refined Fragments]`,
                source: "dev_bookmark_refine",
                payload: payloadToSave
            });
            await loadItems();
            setSelectedId(savedId);
            setRefineStatus(`Refinement completed. Saved ${result.fragments.length} fragments.`);
        } catch (error: any) {
            setRefineStatus(`Refinement failed: ${error?.message || String(error)}`);
        } finally {
            setIsRefining(false);
        }
    };

    return (
        <div className="h-full min-w-0 overflow-x-hidden grid grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)] gap-4">
            <Card className="cx-surface min-h-0 min-w-0 overflow-hidden">
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center justify-between">
                        <span>Dev Extractions</span>
                        <Button size="sm" variant="outline" className="h-8 rounded-full" onClick={loadItems}>
                            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                            Refresh
                        </Button>
                    </CardTitle>
                </CardHeader>
                <CardContent className="max-h-[76vh] overflow-y-auto overflow-x-hidden space-y-2 min-w-0">
                    {loading ? (
                        <div className="text-xs text-muted-foreground">Loading extraction logs...</div>
                    ) : items.length === 0 ? (
                        <div className="text-xs text-muted-foreground">
                            No extraction logs yet. Use extension overlay and click "Extract Page (Dev)".
                        </div>
                    ) : (
                        items.map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                className={`w-full min-w-0 text-left p-2 rounded-xl border transition-colors ${
                                    selectedId === item.id
                                        ? "border-primary/40 bg-primary/10"
                                        : "border-border/70 dark:border-white/10 bg-muted/10 dark:bg-[#25282d] hover:bg-muted/20 dark:hover:bg-[#2b2f35]"
                                }`}
                                onClick={() => setSelectedId(item.id)}
                            >
                                <div className="text-sm font-medium truncate">{item.title || item.url}</div>
                                <div className="text-[11px] text-muted-foreground truncate">{item.url}</div>
                                <div className="mt-1 text-[10px] text-muted-foreground">
                                    {formatDate(item.created_at)} • nodes {item.node_count || 0} • links {item.link_count || 0}
                                </div>
                            </button>
                        ))
                    )}
                </CardContent>
            </Card>

            <Card className="cx-surface min-h-0 min-w-0 overflow-hidden">
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm min-w-0 flex items-start sm:items-center justify-between gap-2 flex-col sm:flex-row">
                        <span className="truncate min-w-0 w-full sm:w-auto">{selected?.title || "Select an extraction"}</span>
                        {selected && (
                            <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-8 rounded-full"
                                    onClick={runDevRefinement}
                                    disabled={isRefining}
                                >
                                    {isRefining ? "Refining..." : "Agent Refine (Dev)"}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-8 rounded-full"
                                    onClick={handleAddToWorkspace}
                                    disabled={isIngesting || isRefining}
                                >
                                    <Plus className="h-3.5 w-3.5 mr-1" />
                                    {isIngesting ? "Adding..." : "Add to Workspace"}
                                </Button>
                                <Button size="sm" variant="outline" className="h-8 rounded-full" onClick={copyPayload}>
                                    Copy JSON
                                </Button>
                                <Button
                                    size="sm"
                                    variant="destructive"
                                    className="h-8 rounded-full"
                                    onClick={handleDeleteSelected}
                                    disabled={isDeleting}
                                >
                                    <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                                    {isDeleting ? "Deleting..." : "Delete"}
                                </Button>
                            </div>
                        )}
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 max-h-[76vh] overflow-y-auto overflow-x-hidden min-w-0">
                    {!selected ? (
                        <div className="text-sm text-muted-foreground">Select an extraction entry from the left panel.</div>
                    ) : (
                        <>
                            <div className="text-xs text-muted-foreground w-full max-w-[780px]">
                                <a
                                    href={selected.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex max-w-full items-start gap-1 hover:underline whitespace-normal break-all"
                                >
                                    <span className="break-all">{selected.url}</span>
                                    <ExternalLink className="h-3 w-3 mt-[2px] shrink-0" />
                                </a>
                            </div>
                            <div className="text-xs text-muted-foreground break-all">
                                Captured: {formatDate(selected.created_at)} • Source: {selected.source || "extension"} • Nodes: {selected.node_count || 0} • Links: {selected.link_count || 0} • Images: {images.length}
                            </div>
                            {refineStatus && (
                                <div className="text-xs text-muted-foreground">{refineStatus}</div>
                            )}

                            <div className="cx-subpanel p-3 min-w-0 overflow-hidden">
                                <div className="text-xs font-semibold mb-2">Hierarchy Text</div>
                                <pre className="text-[11px] whitespace-pre-wrap break-all font-mono max-h-[220px] overflow-y-auto overflow-x-hidden min-w-0">
                                    {hierarchyText || "No hierarchy text found."}
                                </pre>
                            </div>

                            <div className="cx-subpanel p-3 min-w-0 overflow-hidden">
                                <div className="text-xs font-semibold mb-2">Hyperlinks ({hyperlinks.length})</div>
                                {hyperlinks.length === 0 ? (
                                    <div className="text-xs text-muted-foreground">No hyperlinks found.</div>
                                ) : (
                                    <div className="max-h-[220px] overflow-y-auto overflow-x-hidden space-y-2 min-w-0">
                                        {hyperlinks.map((link: any, index: number) => (
                                            <div key={`${link.href || "link"}-${index}`} className="p-2 rounded-lg border border-border/60 dark:border-white/10 bg-muted/10 min-w-0 overflow-hidden">
                                                <div className="text-xs font-medium">{String(link.title || "Untitled link")}</div>
                                                <a
                                                    href={String(link.href || "#")}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="text-[11px] text-blue-500 break-all hover:underline"
                                                >
                                                    {String(link.href || "")}
                                                </a>
                                                <div className="text-[10px] text-muted-foreground mt-1">
                                                    rel: {String(link.rel || "") || "-"} • type: {String(link.type || "") || "-"}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="cx-subpanel p-3 min-w-0 overflow-hidden">
                                <div className="text-xs font-semibold mb-2">Images ({images.length})</div>
                                {images.length === 0 ? (
                                    <div className="text-xs text-muted-foreground">No images found.</div>
                                ) : (
                                    <div className="max-h-[240px] overflow-y-auto overflow-x-hidden space-y-2 min-w-0">
                                        {images.map((image: any, index: number) => (
                                            <div key={`${image.src || "image"}-${index}`} className="p-2 rounded-lg border border-border/60 dark:border-white/10 bg-muted/10 min-w-0 overflow-hidden">
                                                <div className="text-xs font-medium">{String(image.alt || image.title || `Image ${index + 1}`)}</div>
                                                <a
                                                    href={String(image.src || "#")}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="text-[11px] text-blue-500 break-all hover:underline"
                                                >
                                                    {String(image.src || "")}
                                                </a>
                                                <div className="text-[10px] text-muted-foreground mt-1 break-all">
                                                    {`size: ${Number(image.width || 0)}x${Number(image.height || 0)} • natural: ${Number(image.natural_width || 0)}x${Number(image.natural_height || 0)} • loading: ${String(image.loading || "-")} • decoding: ${String(image.decoding || "-")} • crossorigin: ${String(image.crossorigin || "-")} • referrerpolicy: ${String(image.referrerpolicy || "-")}`}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="cx-subpanel p-3 min-w-0 overflow-hidden">
                                <div className="text-xs font-semibold mb-2">Plain Text</div>
                                <pre className="text-[11px] whitespace-pre-wrap break-all font-mono max-h-[180px] overflow-y-auto overflow-x-hidden min-w-0">
                                    {plainText || "No plain text found."}
                                </pre>
                            </div>

                            <div className="cx-subpanel p-3 min-w-0 overflow-hidden">
                                <div className="text-xs font-semibold mb-2 flex items-center justify-between gap-2">
                                    <span>Refined Fragments ({refinedFragments.length})</span>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 rounded-full px-2 text-[11px]"
                                        onClick={() => setIsInspectOpen(true)}
                                        disabled={refinedFragments.length === 0}
                                    >
                                        <Search className="h-3.5 w-3.5 mr-1" />
                                        Inspect
                                    </Button>
                                </div>
                                {refinedFragments.length === 0 ? (
                                    <div className="text-xs text-muted-foreground">
                                        No refined fragments yet. Use "Agent Refine (Dev)" to generate hierarchical fragments.
                                    </div>
                                ) : (
                                    <div className="space-y-2 max-h-[320px] overflow-y-auto overflow-x-hidden min-w-0">
                                        {refinedFragments.map((frag: any, idx: number) => {
                                            const heading = String(frag?.hierarchy?.heading || "General");
                                            const captureHeading = String(frag?.hierarchy?.capture_heading || "");
                                            const subHeading = String(frag?.hierarchy?.sub_heading || "");
                                            const topic = String(frag?.hierarchy?.topic || "Topic");
                                            const level = Number(frag?.hierarchy?.level || 1);
                                            const contextPrefix = Array.isArray(frag?.context_prefix) ? frag.context_prefix : [];
                                            const fragmentId = String(frag?.fragment_id || `frag_${idx + 1}`);
                                            return (
                                                <div
                                                    key={`${fragmentId}-${idx}`}
                                                    className={`p-2 rounded-lg border min-w-0 overflow-hidden cursor-pointer transition-colors ${
                                                        selectedFragmentId === fragmentId
                                                            ? "border-primary/40 bg-primary/10"
                                                            : "border-border/60 dark:border-white/10 bg-muted/10 hover:bg-muted/20"
                                                    }`}
                                                    onClick={() => setSelectedFragmentId(fragmentId)}
                                                >
                                                    <div className="text-xs font-semibold break-all">
                                                        {fragmentId} • L{level} • {heading} → {topic}
                                                    </div>
                                                    {captureHeading && (
                                                        <div className="text-[11px] text-muted-foreground mt-1 break-all">
                                                            capture: {captureHeading}{subHeading ? ` • sub: ${subHeading}` : ""}
                                                        </div>
                                                    )}
                                                    <div className="text-[11px] text-muted-foreground mt-1 break-all">
                                                        {contextPrefix.length > 0 ? `prefix: ${contextPrefix.join(", ")}` : "prefix: -"}
                                                    </div>
                                                    {frag?.trace_path && (
                                                        <div className="text-[11px] text-muted-foreground mt-1 break-all">
                                                            trace: {String(frag.trace_path)}
                                                        </div>
                                                    )}
                                                    <pre className="text-[11px] whitespace-pre-wrap break-all font-mono mt-1 max-h-[120px] overflow-y-auto overflow-x-hidden">
                                                        {String(frag?.text || "")}
                                                    </pre>
                                                    <div className="text-[11px] mt-1 break-all">
                                                        <span className="text-muted-foreground">summary: </span>
                                                        {String(frag?.summary || "")}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                                {refinementDebug && (
                                    <div className="text-[11px] text-muted-foreground mt-2 break-all">
                                        windows: {Number(refinementDebug.window_count || 0)} • merges: {Array.isArray(refinementDebug.merge_steps) ? refinementDebug.merge_steps.length : 0}
                                    </div>
                                )}
                            </div>

                            <div className="cx-subpanel p-3 min-w-0 overflow-hidden">
                                <div className="text-xs font-semibold mb-2">Fragment Source Mapping</div>
                                {!selectedFragment ? (
                                    <div className="text-xs text-muted-foreground">Select a refined fragment to inspect source mapping.</div>
                                ) : (
                                    (() => {
                                        const map = selectedFragmentMapping;
                                        if (!selectedPreview) {
                                            return <div className="text-xs text-muted-foreground">No source range available for this fragment.</div>;
                                        }
                                        return (
                                            <div className="space-y-2 min-w-0">
                                                <div className="text-[11px] text-muted-foreground break-all">
                                                    range: {selectedStart}-{selectedEnd} • confidence: {String(map?.confidence || "-")} • window: {Number(map?.window_start_char || 0)}-{Number(map?.window_end_char || 0)}
                                                </div>
                                                <pre className="text-[11px] whitespace-pre-wrap break-all font-mono max-h-[220px] overflow-y-auto overflow-x-hidden">
                                                    <span>{selectedPreview.before}</span>
                                                    <mark className="bg-yellow-300/70 text-black px-0.5 rounded-sm">{selectedPreview.highlight || "[empty-range]"}</mark>
                                                    <span>{selectedPreview.after}</span>
                                                </pre>
                                                {map?.evidence_quote && (
                                                    <div className="text-[11px] text-muted-foreground break-all">
                                                        evidence: {String(map.evidence_quote)}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })()
                                )}
                            </div>

                            <div className="cx-subpanel p-3 min-w-0 overflow-hidden">
                                <div className="text-xs font-semibold mb-2">Raw JSON</div>
                                <pre className="text-[10px] whitespace-pre-wrap break-all font-mono max-h-[320px] overflow-y-auto overflow-x-hidden min-w-0">
                                    {JSON.stringify(payload, null, 2)}
                                </pre>
                            </div>

                            <Dialog open={isInspectOpen} onOpenChange={setIsInspectOpen}>
                                <DialogContent className="w-[99vw] max-w-[99vw] sm:max-w-[99vw] h-[94vh] p-0 border border-border dark:border-white/10 bg-card dark:bg-[#2f3136] rounded-2xl overflow-hidden">
                                    <DialogHeader className="px-4 py-3 border-b border-border/60 dark:border-white/10 flex flex-row items-center justify-between">
                                        <DialogTitle className="text-sm">
                                            Fragment Mapping Inspector
                                        </DialogTitle>
                                    </DialogHeader>

                                    <InspectMappingBody
                                        refinedFragments={refinedFragments}
                                        selectedFragmentId={selectedFragmentId}
                                        setSelectedFragmentId={setSelectedFragmentId}
                                        refinementSourceText={refinementSourceText}
                                    />
                                </DialogContent>
                            </Dialog>
                        </>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}

function InspectMappingBody({
    refinedFragments,
    selectedFragmentId,
    setSelectedFragmentId,
    refinementSourceText
}: {
    refinedFragments: any[];
    selectedFragmentId: string | null;
    setSelectedFragmentId: (id: string) => void;
    refinementSourceText: string;
}) {
    const selectedFragment = refinedFragments.find((frag: any) => String(frag?.fragment_id || "") === selectedFragmentId) || null;
    const sourcePaneRef = useRef<HTMLDivElement | null>(null);
    const highlightRef = useRef<HTMLSpanElement | null>(null);
    const [expandedById, setExpandedById] = useState<Record<string, boolean>>({});

    const map = selectedFragment?.source_mapping || {};
    const start = Number(map?.absolute_start_char);
    const end = Number(map?.absolute_end_char);
    const preview = Number.isFinite(start) && Number.isFinite(end) && refinementSourceText
        ? buildSourceHighlight(refinementSourceText, start, end, 600)
        : null;

    useEffect(() => {
        const pane = sourcePaneRef.current;
        const hl = highlightRef.current;
        if (!pane || !hl || !preview?.highlight) return;
        hl.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    }, [selectedFragmentId, preview?.highlight]);

    const toggleExpanded = (fragmentId: string) => {
        setExpandedById((prev) => ({ ...prev, [fragmentId]: !prev[fragmentId] }));
    };

    return (
        <div className="grid grid-cols-1 lg:grid-cols-[420px_minmax(0,1fr)] h-[calc(92vh-52px)] min-h-0">
            <div className="border-r border-border/60 dark:border-white/10 p-3 min-h-0 overflow-y-auto overflow-x-hidden space-y-2">
                {refinedFragments.length === 0 ? (
                    <div className="text-xs text-muted-foreground">No refined fragments available.</div>
                ) : (
                    refinedFragments.map((frag: any, idx: number) => {
                        const fragmentId = String(frag?.fragment_id || `frag_${idx + 1}`);
                        const captureHeading = String(frag?.hierarchy?.capture_heading || "");
                        const heading = String(frag?.hierarchy?.heading || "General");
                        const subHeading = String(frag?.hierarchy?.sub_heading || "");
                        const topic = String(frag?.hierarchy?.topic || "Topic");
                        const level = Number(frag?.hierarchy?.level || 1);
                        const trace = String(frag?.trace_path || "");
                        const summary = String(frag?.summary || "");
                        const prefix = Array.isArray(frag?.context_prefix) ? frag.context_prefix : [];
                        const fullText = String(frag?.text || "");
                        const isActive = fragmentId === selectedFragmentId;
                        const isExpanded = !!expandedById[fragmentId];
                        return (
                            <div
                                key={`${fragmentId}-${idx}`}
                                className={`w-full text-left p-2 rounded-lg border transition-colors ${
                                    isActive
                                        ? "border-primary/40 bg-primary/10"
                                        : "border-border/60 dark:border-white/10 bg-muted/10 hover:bg-muted/20"
                                }`}
                            >
                                <div className="flex items-start gap-2">
                                    <button
                                        type="button"
                                        className="flex-1 text-left"
                                        onClick={() => setSelectedFragmentId(fragmentId)}
                                    >
                                        <div className="text-xs font-semibold break-all">
                                            {fragmentId} • L{level} • {heading} → {topic}
                                        </div>
                                        {captureHeading && (
                                            <div className="text-[11px] text-muted-foreground mt-1 break-all">
                                                capture: {captureHeading}
                                            </div>
                                        )}
                                        {subHeading && (
                                            <div className="text-[11px] text-muted-foreground mt-1 break-all">
                                                sub: {subHeading}
                                            </div>
                                        )}
                                        {trace && (
                                            <div className="text-[11px] text-muted-foreground mt-1 break-all">
                                                {trace}
                                            </div>
                                        )}
                                        <div className="text-[11px] text-muted-foreground mt-1 break-all">
                                            range: {Number(frag?.source_mapping?.absolute_start_char ?? -1)}-{Number(frag?.source_mapping?.absolute_end_char ?? -1)}
                                        </div>
                                        {summary && (
                                            <div className="text-[11px] mt-1 break-all">
                                                <span className="text-muted-foreground">summary: </span>
                                                {summary}
                                            </div>
                                        )}
                                        {prefix.length > 0 && (
                                            <div className="text-[11px] text-muted-foreground mt-1 break-all">
                                                prefix: {prefix.join(" • ")}
                                            </div>
                                        )}
                                    </button>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="h-7 rounded-full px-2 text-[10px] shrink-0"
                                        onClick={() => toggleExpanded(fragmentId)}
                                    >
                                        {isExpanded ? (
                                            <>
                                                Hide
                                                <ChevronUp className="h-3.5 w-3.5 ml-1" />
                                            </>
                                        ) : (
                                            <>
                                                Full
                                                <ChevronDown className="h-3.5 w-3.5 ml-1" />
                                            </>
                                        )}
                                    </Button>
                                </div>
                                {isExpanded && (
                                    <div className="mt-2 pt-2 border-t border-border/60 dark:border-white/10">
                                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                                            Full Extracted Fragment
                                        </div>
                                        <pre className="text-[11px] whitespace-pre-wrap break-all font-mono max-h-[220px] overflow-auto">
                                            {fullText || "[empty]"}
                                        </pre>
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>

            <div className="p-3 min-h-0 overflow-hidden flex flex-col gap-2">
                {!selectedFragment ? (
                    <div className="text-xs text-muted-foreground">Select a fragment from the left panel.</div>
                ) : (
                    <>
                        <div className="text-xs text-muted-foreground break-all">
                            fragment: {String(selectedFragment?.fragment_id || "-")} • confidence: {String(map?.confidence || "-")} • range: {Number(start || 0)}-{Number(end || 0)}
                        </div>
                        <div
                            ref={(node) => {
                                sourcePaneRef.current = node;
                            }}
                            className="flex-1 min-h-0 overflow-auto rounded-lg border border-border/60 dark:border-white/10 bg-muted/10 p-3"
                        >
                            {!preview ? (
                                <div className="text-xs text-muted-foreground">No source mapping found for this fragment.</div>
                            ) : (
                                <pre className="text-[11px] whitespace-pre font-mono w-max min-w-full">
                                    <span>{preview.before}</span>
                                    <mark
                                        ref={(node) => {
                                            highlightRef.current = node;
                                        }}
                                        className="bg-yellow-300/70 text-black px-0.5 rounded-sm"
                                    >
                                        {preview.highlight || "[empty-range]"}
                                    </mark>
                                    <span>{preview.after}</span>
                                </pre>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
