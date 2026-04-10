import { ExtractionDebugModal } from "@/components/extraction-debug-modal"
import { PdfInspectionModal } from "@/components/pdf-inspection-modal"
import { DeleteConfirmModal } from "@/components/delete-confirm-modal"
import { useExtractionStore } from '@/store/extraction-store';
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { FileText, Play, X, ChevronDown, ChevronUp, Link2, Image as ImageIcon } from 'lucide-react'
import { Button } from "@/components/ui/button"
import * as React from 'react'

const truncateFilename = (filename: string, maxLength: number = 48) => {
    if (!filename) return "";
    if (filename.length <= maxLength) return filename;

    const isUrl = /^https?:\/\//i.test(filename);
    if (isUrl) {
        return `${filename.slice(0, Math.max(1, maxLength - 1))}\u2026`;
    }

    const lastSlash = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
    const lastDot = filename.lastIndexOf(".");
    const hasExtension = lastDot > lastSlash && filename.length - lastDot <= 10;

    if (!hasExtension) {
        return `${filename.slice(0, Math.max(1, maxLength - 1))}\u2026`;
    }

    const ext = filename.slice(lastDot);
    const nameLength = Math.max(1, maxLength - ext.length - 1);
    return `${filename.slice(0, nameLength)}\u2026${ext}`;
};

const getDisplayTitle = (job: { filename: string; jobType?: 'pdf' | 'bookmark' | 'snip' }) => {
    const hardLimit = job.jobType === 'bookmark'
        ? 38
        : job.jobType === 'snip'
            ? 40
            : 48;
    return truncateFilename(job.filename || "", hardLimit);
};

const queueIconButtonClass =
    "h-7 w-7 rounded-full border border-border/60 dark:border-white/12 bg-background/70 dark:bg-[#343841]/80 text-muted-foreground hover:text-foreground hover:bg-background dark:hover:bg-[#3b3f48]";

export function ProcessingQueue({ highlightedJobId }: { highlightedJobId?: string | null }) {
    const jobs = useExtractionStore((state) => state.jobs);
    const contextJobs = useExtractionStore((state) => state.contextJobs);
    const pauseJob = useExtractionStore((state) => state.pauseJob);
    const startJob = useExtractionStore((state) => state.startJob);
    const dismissJob = useExtractionStore((state) => state.dismissJob);
    const dismissContextJob = useExtractionStore((state) => state.dismissContextJob);

    // Track which cards are manually collapsed
    const [collapsedIds, setCollapsedIds] = React.useState<Record<string, boolean>>({});

    const toggleCollapse = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setCollapsedIds(prev => ({ ...prev, [id]: !prev[id] }));
    };

    const activeJobs = [
        ...Object.values(jobs).map(j => ({ ...j, jobType: j.jobType || 'pdf' as const })),
        ...Object.values(contextJobs)
    ]
        .filter(j => !j.dismissed_from_queue)
        .sort((a, b) => {
            if (a.status === 'processing') return -1;
            if (b.status === 'processing') return 1;
            const aTs = a.createdAt ? Date.parse(a.createdAt) : 0;
            const bTs = b.createdAt ? Date.parse(b.createdAt) : 0;
            if (aTs !== bTs) return bTs - aTs;
            return 0;
        });

    if (activeJobs.length === 0) {
        return (
            <div className="p-4 text-center text-muted-foreground text-sm">
                No active uploads.
            </div>
        )
    }

    return (
        <ScrollArea className="h-full w-full">
            <div className="space-y-3 p-3 w-full max-w-full overflow-x-hidden">
                {activeJobs.map((job) => {
                    const isCollapsed = collapsedIds[job.documentId];
                    const progress = Math.round((job.processedPages / (job.totalPages || 1)) * 100);

                    return (
                        <div
                            key={job.documentId}
                            onClick={(e) => isCollapsed ? toggleCollapse(job.documentId, e) : undefined}
                            className={`group border border-border dark:border-white/10 rounded-2xl p-3 flex flex-col gap-3 bg-card dark:bg-[#2d3035] transition-all duration-300 w-full overflow-hidden shrink-0 ${isCollapsed ? 'cursor-pointer hover:border-primary/50' : ''} ${highlightedJobId === job.documentId ? 'ring-2 ring-primary/40 shadow-md' : ''}`}
                        >
                            {/* Top Row: Icon, Name, (Hover Controls), Status Icon */}
                            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 w-full min-w-0">
                                <div className="flex items-center gap-3 overflow-hidden flex-1 min-w-0">
                                    {job.jobType === 'bookmark' ? (
                                        <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                                    ) : job.jobType === 'snip' ? (
                                        <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                                    ) : (
                                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                                    )}
                                    <div className="flex flex-col flex-1 min-w-0 overflow-hidden w-full">
                                        <span className="text-sm font-medium block w-full overflow-hidden text-ellipsis whitespace-nowrap" title={job.filename}>
                                            {getDisplayTitle(job)}
                                        </span>
                                        {!isCollapsed && (
                                            <span className="text-[10px] text-muted-foreground">
                                                {job.jobType === 'bookmark' ? 'Website Bookmark' : job.jobType === 'snip' ? 'Screen Snip' : 'PDF'}
                                            </span>
                                        )}
                                        {isCollapsed && (
                                            <div className="flex items-center gap-2 mt-1">
                                                <Progress value={progress} className="h-1 flex-1 bg-secondary w-full" />
                                                <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0 leading-none">
                                                    {job.processedPages}/{job.totalPages || 1}
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Right side controls */}
                                <div className="flex items-center gap-1 shrink-0 relative">
                                    {/* Action buttons (only visible on group hover) */}
                                    <div className="absolute right-full top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none group-hover:pointer-events-auto rounded-xl border border-border/60 dark:border-white/12 bg-background/60 dark:bg-[#212733]/70 backdrop-blur-sm px-1.5 py-1 mr-1 shadow-sm">
                                        {job.debugInfo && (
                                            <ExtractionDebugModal
                                                debugInfo={job.debugInfo}
                                                triggerClassName={queueIconButtonClass}
                                            />
                                        )}
                                        {job.file && job.jobType === 'pdf' && (
                                            <PdfInspectionModal
                                                docId={job.documentId}
                                                iconOnly
                                                triggerClassName={queueIconButtonClass}
                                            />
                                        )}
                                        {job.jobType === 'pdf' && (
                                            <DeleteConfirmModal
                                                documentId={job.documentId}
                                                filename={job.filename}
                                                iconOnly
                                                triggerClassName={queueIconButtonClass}
                                            />
                                        )}
                                        {(job.status === 'completed' || job.status === 'error') && (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className={queueIconButtonClass}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (job.jobType === 'pdf') dismissJob(job.documentId);
                                                    else dismissContextJob(job.documentId);
                                                }}
                                                title="Dismiss from queue"
                                            >
                                                <X className="h-4 w-4" />
                                            </Button>
                                        )}
                                    </div>

                                    {/* Constant Status Icon */}
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <div className="ml-2 z-10 flex items-center justify-center h-full">
                                                <div className={`w-2.5 h-2.5 rounded-full ${job.status === 'completed' ? 'bg-green-500' : job.status === 'error' ? 'bg-red-500' : 'bg-yellow-500'}`} />
                                            </div>
                                        </TooltipTrigger>
                                        <TooltipContent side="bottom" className="max-w-[95vw] wrap-break-word">
                                            <p>{getStatusText(job)}</p>
                                        </TooltipContent>
                                    </Tooltip>

                                    {/* Collapse Toggle */}
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className={`${queueIconButtonClass} ml-1 shrink-0 z-10`}
                                        onClick={(e) => toggleCollapse(job.documentId, e)}
                                    >
                                        {isCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                                    </Button>
                                </div>
                            </div>

                            {/* Collapsible Content */}
                            {!isCollapsed && (
                                <div className="space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
                                    <div className="space-y-1">
                                        <div className="flex justify-between text-xs text-muted-foreground">
                                            <span>{getStatusText(job)}</span>
                                            <span>{progress}%</span>
                                        </div>
                                        <Progress value={progress} className="h-2" />
                                    </div>

                                    {job.extractedChunks && job.extractedChunks.length > 0 && (
                                        <div className="space-y-1">
                                            <div className="text-xs font-medium text-muted-foreground">
                                                Extracted Chunks ({job.extractedChunks.length})
                                            </div>
                                            <div className="max-h-24 overflow-y-auto border rounded-md bg-muted/20 p-2 space-y-1">
                                                {job.extractedChunks.slice(0, 3).map((chunk, idx) => (
                                                    <p key={idx} className="text-[10px] leading-snug text-muted-foreground">
                                                        {idx + 1}. {chunk.slice(0, 180)}
                                                        {chunk.length > 180 ? "..." : ""}
                                                    </p>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Bottom Controls (Extract/Pause) */}
                                    <div className="flex justify-end gap-1.5 mt-2">
                                        {(job.status === 'queued' || job.status === 'paused' || job.status === 'error') && job.file && job.jobType === 'pdf' && (
                                            <Button size="sm" onClick={() => startJob(job.documentId)} className="gap-1.5 text-xs h-7">
                                                <Play className="h-3 w-3" /> {job.status === 'paused' ? "Resume" : "Extract"}
                                            </Button>
                                        )}
                                        {job.status === 'processing' && job.jobType === 'pdf' && (
                                            <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => pauseJob(job.documentId)}>Pause</Button>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </ScrollArea>
    );
}

function getStatusText(job: any) {
    if (job.progressLabel) return job.progressLabel;
    if (job.status === 'completed') return 'Done';
    if (job.status === 'error') return 'Failed';
    if (job.status === 'queued') return 'Queued...';
    if (job.status === 'paused') return 'Paused';
    if (job.jobType === 'bookmark') return `Processing website step ${job.processedPages} / ${job.totalPages}...`;
    if (job.jobType === 'snip') return `Processing snip step ${job.processedPages} / ${job.totalPages}...`;
    return `Scanning page ${job.processedPages} / ${job.totalPages}...`;
}
