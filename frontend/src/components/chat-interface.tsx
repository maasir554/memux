import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from "@/components/ui/button"
import { AutoResizeTextarea } from "@/components/ui/auto-resize-textarea"
import { Loader2, FileText, Plus, XCircle, MessageSquare, BookOpen, ChevronRight, ChevronDown, ArrowUp, Link as LinkIcon, Bug, ExternalLink, Copy, Check, RotateCcw, Info } from "lucide-react"
import { apiService } from "@/services/api-service"
import { dbService, type ContextSourceType, type ContextSpace } from "@/services/db-service"
import { contextRetrievalService } from "@/services/context-retrieval-service"
import { pdfStore } from "@/services/pdf-store"
import { DocumentViewerModal } from "./document-viewer-modal"
import { SnipReferenceModal } from "./snip-reference-modal"
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useLocation, useSearch } from "wouter"
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useExtractionStore } from '@/store/extraction-store'
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog"

interface SourceChunk {
    id: string;
    source_id: string;
    source_type: ContextSourceType;
    document_id?: string | null;
    filename: string;
    page_number: number;
    table_name: string;
    text_summary: string;
    raw_text?: string;
    full_content?: string;
    data: any;
    similarity_score: number;
    citation_payload?: {
        canonical_uri?: string | null;
        asset_id?: string | null;
    };
}

interface PipelineStep {
    queryTerms?: string[];
    retrievedCount?: number;
    evaluations?: { id: string, filename: string, summary: string, toKeep: boolean, source?: SourceChunk }[];
}

interface Message {
    role: 'user' | 'assistant';
    content: string;
    sources?: SourceChunk[];
    used_chunk_ids?: string[];
    debug_info?: any;
    error?: string;
    pipeline_step?: PipelineStep;
}


function SourceLink({ source }: { source: SourceChunk }) {
    if (source.source_type === 'pdf' && source.document_id) {
        return (
            <DocumentViewerModal
                docId={source.document_id}
                initialPage={source.page_number}
                iconOnly={false}
            />
        );
    }
    if (source.source_type === 'bookmark' && source.citation_payload?.canonical_uri) {
        return (
            <a
                href={source.citation_payload.canonical_uri}
                target="_blank"
                rel="noreferrer"
                className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded border hover:bg-muted"
            >
                <LinkIcon className="w-3 h-3" />
                Open
            </a>
        );
    }
    if (source.source_type === 'snip') {
        return (
            <SnipReferenceModal source={source}>
                <button type="button" className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded border hover:bg-muted">
                    <FileText className="w-3 h-3" />
                    Open
                </button>
            </SnipReferenceModal>
        );
    }
    return null;
}

export function SourcesModal({ sources }: { sources: SourceChunk[] }) {
    const [expandedSourceIds, setExpandedSourceIds] = useState<Record<string, boolean>>({});
    if (!sources || sources.length === 0) return null;

    const toggleSource = (id: string) => {
        setExpandedSourceIds((prev) => ({ ...prev, [id]: !prev[id] }));
    };

    return (
        <Dialog>
            <DialogTrigger asChild>
                <button
                    className="mt-2 flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-muted-foreground border rounded-md hover:bg-muted/50 transition-colors bg-background shadow-sm w-fit"
                >
                    <BookOpen className="w-3.5 h-3.5" />
                    <span>View {sources.length} Context Source{sources.length !== 1 && 's'}</span>
                </button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col p-4 outline-none">
                <DialogHeader className="mb-2 shrink-0">
                    <DialogTitle className="text-sm font-semibold flex items-center gap-2">
                        <BookOpen className="w-4 h-4 text-primary" /> 
                        Retrieved Context ({sources.length})
                    </DialogTitle>
                </DialogHeader>
                <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar">
                    {sources.map((source, idx) => (
                        <div key={idx} className="flex flex-col gap-1 p-3 rounded-lg border bg-card text-xs shadow-sm">
                            <div className="flex items-start justify-between gap-2">
                                <div className="font-medium flex items-center gap-2 flex-wrap text-foreground">
                                    <FileText className="w-3.5 h-3.5 text-primary shrink-0" />
                                    <span>{source.filename}</span>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted uppercase tracking-wider text-muted-foreground">{source.source_type}</span>
                                </div>
                                <SourceLink source={source} />
                            </div>
                            <div className="text-muted-foreground mt-2 flex gap-2">
                                <span className="bg-muted/50 px-2 py-0.5 rounded text-[11px] border">LOC: {source.table_name}</span>
                            </div>
                            <div className="mt-2 text-muted-foreground leading-relaxed bg-muted/20 p-2.5 rounded text-[11px] border">
                                {source.text_summary}
                            </div>
                            <button
                                type="button"
                                onClick={() => toggleSource(source.id)}
                                className="mt-2 inline-flex items-center gap-1 self-start text-[10px] uppercase tracking-wide text-primary hover:text-primary/80 transition-colors font-medium border border-primary/20 bg-primary/5 px-2 py-1 rounded"
                            >
                                {expandedSourceIds[source.id] ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                Expand Full Data
                            </button>
                            {expandedSourceIds[source.id] && (
                                <div className="space-y-3 mt-3 animate-in fade-in slide-in-from-top-1">
                                    {source.raw_text && (
                                        <div>
                                            <div className="text-[10px] flex items-center gap-1 uppercase tracking-wider text-muted-foreground mb-1.5 font-medium"><FileText className="w-3 h-3" /> Raw Chunk Flow</div>
                                            <pre className="font-mono bg-muted/50 p-3 rounded-md overflow-x-auto text-[10px] whitespace-pre-wrap break-words leading-relaxed border">{source.raw_text}</pre>
                                        </div>
                                    )}
                                    {source.full_content && (
                                        <div>
                                            <div className="text-[10px] flex items-center gap-1 uppercase tracking-wider text-muted-foreground mb-1.5 font-medium"><BookOpen className="w-3 h-3" /> Expanded Context</div>
                                            <pre className="font-mono bg-muted/50 p-3 rounded-md overflow-x-auto text-[10px] whitespace-pre-wrap break-words leading-relaxed border">{source.full_content}</pre>
                                        </div>
                                    )}
                                    {source.data && Object.keys(source.data).length > 0 && (
                                        <div>
                                            <div className="text-[10px] flex items-center gap-1 uppercase tracking-wider text-muted-foreground mb-1.5 font-medium"><MessageSquare className="w-3 h-3" /> Structured Payload JSON</div>
                                            <pre className="font-mono bg-muted/50 text-emerald-600 dark:text-emerald-400 p-3 rounded-md overflow-x-auto text-[10px] whitespace-pre-wrap break-words border">{JSON.stringify(source.data, null, 2)}</pre>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    );
}

function MiniMetric({ label, value }: { label: string; value: string | number }) {
    return (
        <div className="rounded-xl border bg-card px-3 py-2 min-w-[110px]">
            <div className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
            <div className="text-sm font-semibold mt-1">{value}</div>
        </div>
    );
}

function StageCard({
    title,
    subtitle,
    children,
    defaultOpen = true,
}: {
    title: string;
    subtitle?: string;
    children: React.ReactNode;
    defaultOpen?: boolean;
}) {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    return (
        <div className="rounded-2xl border bg-card/80 overflow-hidden">
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex items-center justify-between gap-3 px-3 py-3 text-left hover:bg-muted/20 transition-colors"
            >
                <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{title}</div>
                    {subtitle && <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>}
                </div>
                {isOpen ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
            </button>
            {isOpen && <div className="px-3 pb-3">{children}</div>}
        </div>
    );
}

function StepDecisionPill({ keep, label }: { keep: boolean; label?: string }) {
    return (
        <span className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] uppercase tracking-wide border ${keep ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-300' : 'bg-muted text-muted-foreground border-border'}`}>
            {label || (keep ? 'Kept' : 'Dropped')}
        </span>
    );
}

function DebugStepRow({
    title,
    subtitle,
    keep,
    body,
    extra,
}: {
    title: string;
    subtitle?: string;
    keep: boolean;
    body: React.ReactNode;
    extra?: React.ReactNode;
}) {
    const [isOpen, setIsOpen] = useState(false);
    return (
        <div className="rounded-xl border bg-background/60 overflow-hidden">
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex items-start justify-between gap-3 px-3 py-3 text-left hover:bg-muted/20 transition-colors"
            >
                <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <div className="text-sm font-medium truncate">{title}</div>
                        <StepDecisionPill keep={keep} />
                    </div>
                    {subtitle && <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>}
                </div>
                {isOpen ? <ChevronDown className="w-4 h-4 shrink-0 mt-0.5" /> : <ChevronRight className="w-4 h-4 shrink-0 mt-0.5" />}
            </button>
            {isOpen && (
                <div className="px-3 pb-3 space-y-2">
                    {body}
                    {extra}
                </div>
            )}
        </div>
    );
}

export function RagDebugModal({ debugInfo, retrievedSources, usedSources }: { debugInfo?: any; retrievedSources?: SourceChunk[]; usedSources?: SourceChunk[] }) {
    if (!debugInfo && (!retrievedSources || retrievedSources.length === 0)) return null;

    const backendDebug = debugInfo?.backend || debugInfo;
    const retrievalDebug = debugInfo?.retrieval || null;
    const packedContext = Array.isArray(backendDebug?.packed_context_chunks) ? backendDebug.packed_context_chunks : [];
    const promptMessages = Array.isArray(backendDebug?.retry_applied ? backendDebug?.retry_messages : backendDebug?.messages)
        ? (backendDebug?.retry_applied ? backendDebug?.retry_messages : backendDebug?.messages)
        : [];
    const packedIds = new Set((backendDebug?.packed_context_chunk_ids || []) as string[]);
    const ragMode = String(backendDebug?.rag_mode || "simple_direct_context");

    return (
        <Dialog>
            <DialogTrigger asChild>
                <button
                    className="mt-2 flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-muted-foreground border rounded-md hover:bg-muted/50 transition-colors bg-background shadow-sm w-fit"
                >
                    <Bug className="w-3.5 h-3.5" />
                    <span>RAG Debug Pipeline</span>
                </button>
            </DialogTrigger>
            <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col p-4 outline-none">
                <DialogHeader className="mb-2 shrink-0">
                    <DialogTitle className="text-sm font-semibold flex items-center gap-2">
                        <Loader2 className="w-4 h-4 text-primary" />
                        RAG Pipeline Telemetry
                    </DialogTitle>
                </DialogHeader>
                <div className="flex-1 overflow-y-auto space-y-4 pr-2 text-[11px] custom-scrollbar">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        <MiniMetric label="Retrieved" value={retrievedSources?.length || 0} />
                        <MiniMetric label="Packed" value={packedContext.length} />
                        <MiniMetric label="Mode" value={ragMode === "simple_direct_context" ? "Simple" : "Agentic"} />
                        <MiniMetric label="Used" value={usedSources?.length || 0} />
                    </div>

                    <StageCard
                        title="Query"
                        subtitle={backendDebug?.query || "No query captured"}
                    >
                        <div className="space-y-2">
                            {Array.isArray(retrievalDebug?.generated_search_terms) && retrievalDebug.generated_search_terms.length > 0 && (
                                <div className="space-y-1">
                                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Generated Search Terms</div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {retrievalDebug.generated_search_terms.map((term: string) => (
                                            <span key={term} className="px-2 py-1 rounded-full border bg-background/70 text-xs">
                                                {term}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {Array.isArray(retrievalDebug?.term_runs) && retrievalDebug.term_runs.length > 0 && (
                                <div className="space-y-1">
                                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Per-Term Retrieval</div>
                                    <div className="space-y-1">
                                        {retrievalDebug.term_runs.map((run: any, index: number) => (
                                            <div key={`${run.term}-${index}`} className="rounded-lg border bg-background/60 p-2 space-y-1">
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="font-medium">{run.term}</div>
                                                    <div className="text-[10px] text-muted-foreground">{run.retrieved_count || 0} hit(s)</div>
                                                </div>
                                                {Array.isArray(run.top_labels) && run.top_labels.length > 0 && (
                                                    <div className="text-xs text-muted-foreground">
                                                        {run.top_labels.join(" | ")}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {retrievalDebug && (
                                <pre className="font-mono bg-muted/40 p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(retrievalDebug, null, 2)}</pre>
                            )}
                            {backendDebug?.estimated_tokens && (
                                <pre className="font-mono bg-muted/40 p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(backendDebug.retry_applied ? backendDebug.retry_estimated_tokens : backendDebug.estimated_tokens, null, 2)}</pre>
                            )}
                        </div>
                    </StageCard>

                    {retrievedSources && retrievedSources.length > 0 && (
                        <StageCard
                            title="Retrieved"
                            subtitle="Semantic retrieval candidates before context packing"
                        >
                            <div className="space-y-2">
                                {retrievedSources.map((source) => {
                                    const stateLabel = packedIds.has(source.id) ? "Packed" : "Retrieved";
                                    return (
                                        <DebugStepRow
                                            key={source.id}
                                            title={source.filename}
                                            subtitle={`${source.table_name} • ${stateLabel}`}
                                            keep={packedIds.has(source.id) || Boolean(usedSources?.some((used) => used.id === source.id))}
                                            body={
                                                <div className="space-y-2">
                                                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Complete Chunk</div>
                                                    <pre className="font-mono bg-muted/40 p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">{source.full_content || source.raw_text || source.text_summary}</pre>
                                                </div>
                                            }
                                        />
                                    );
                                })}
                            </div>
                        </StageCard>
                    )}

                    {usedSources && usedSources.length > 0 && (
                        <StageCard
                            title="Used In Final Answer"
                            subtitle="Cited chunks returned by the response agent"
                            defaultOpen={false}
                        >
                            <div className="flex flex-wrap gap-1.5">
                                {usedSources.map((source) => (
                                    <span key={source.id} className="px-2 py-1 rounded-full border bg-muted/40">
                                        {source.filename}
                                    </span>
                                ))}
                            </div>
                        </StageCard>
                    )}

                    {packedContext.length > 0 && (
                        <StageCard
                            title="Packed Context"
                            subtitle="Compact evidence after token budgeting"
                            defaultOpen={false}
                        >
                            <pre className="font-mono bg-muted/40 p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(packedContext, null, 2)}</pre>
                        </StageCard>
                    )}

                    {promptMessages.length > 0 && (
                        <StageCard
                            title="Exact Prompt Messages"
                            subtitle="Final response-agent input"
                            defaultOpen={false}
                        >
                            <pre className="font-mono bg-muted/40 p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(promptMessages, null, 2)}</pre>
                        </StageCard>
                    )}

                    {backendDebug?.raw_response && (
                        <StageCard
                            title="Model Raw Response"
                            defaultOpen={false}
                        >
                            <pre className="font-mono bg-muted/40 p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">{String(backendDebug.raw_response)}</pre>
                        </StageCard>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

function CitationCapsule({ source }: { source: SourceChunk }) {
    const content = (
        <div className="flex items-center bg-muted/20 border rounded-full pl-2.5 pr-2 py-1 gap-1.5 shrink-0 animate-in fade-in slide-in-from-left-1 cursor-pointer hover:bg-muted/40 transition-colors">
            <FileText className="w-3 h-3 text-muted-foreground shrink-0" />
            <span className="text-[11px] font-medium text-muted-foreground truncate max-w-[150px]">
                {source.filename}
            </span>
            <span className="text-[10px] text-muted-foreground/70 shrink-0 font-medium whitespace-nowrap">
                • {source.source_type}
            </span>
        </div>
    );

    if (source.source_type === 'pdf' && source.document_id) {
        return (
            <DocumentViewerModal
                docId={source.document_id}
                initialPage={source.page_number}
                iconOnly={true}
            >
                {content}
            </DocumentViewerModal>
        );
    }

    if (source.source_type === 'bookmark' && source.citation_payload?.canonical_uri) {
        return (
            <a href={source.citation_payload.canonical_uri} target="_blank" rel="noreferrer">
                {content}
            </a>
        );
    }

    if (source.source_type === 'snip') {
        return (
            <SnipReferenceModal source={source}>
                {content}
            </SnipReferenceModal>
        );
    }

    return content;
}

function CitationGroup({ sources }: { sources: SourceChunk[] }) {
    const [isExpanded, setIsExpanded] = useState(false);
    if (!sources || sources.length === 0) return null;

    if (!isExpanded) {
        return (
            <button
                onClick={() => setIsExpanded(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border bg-muted/40 hover:bg-muted text-xs text-muted-foreground transition-colors max-w-fit mt-1"
                title={`${sources.length} Reference${sources.length > 1 ? 's' : ''}`}
            >
                <FileText className="w-3.5 h-3.5" />
                <span className="font-medium">See {sources.length} Reference{sources.length > 1 ? 's' : ''}</span>
            </button>
        );
    }

    return (
        <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setIsExpanded(false)} className="text-muted-foreground hover:text-foreground transition-colors">
                <XCircle className="w-4 h-4" />
            </button>
            {sources.map(chunk => <CitationCapsule key={chunk.id} source={chunk} />)}
        </div>
    );
}

/** Renders assistant content with [doc_N] replaced by inline citation chips */
function AssistantContent({ content, sources }: { content: string; sources?: SourceChunk[] }) {
    if (!sources || sources.length === 0) {
        return (
            <div className="text-[15px] prose dark:prose-invert max-w-none prose-p:leading-relaxed prose-pre:p-0 prose-pre:bg-transparent prose-a:text-primary prose-code:before:hidden prose-code:after:hidden">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                        code: ({ node, inline, className, children, ...props }: any) => {
                            const match = /language-(\w+)/.exec(className || '');
                            const [isCopied, setIsCopied] = useState(false);
                            const textSource = String(children).replace(/\n$/, '');

                            const handleCopy = () => {
                                navigator.clipboard.writeText(textSource);
                                setIsCopied(true);
                                setTimeout(() => setIsCopied(false), 2000);
                            };

                            if (!inline && match) {
                                return (
                                    <div className="relative group max-w-full my-4 rounded-md overflow-hidden border border-border/50 bg-[#1e1e1e]">
                                        <div className="flex items-center justify-between px-4 py-1.5 bg-muted/30 border-b border-border/50 text-xs text-muted-foreground font-mono">
                                            <span>{match[1]}</span>
                                            <button
                                                onClick={handleCopy}
                                                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-muted rounded transition-all hover:text-foreground"
                                                title="Copy code"
                                            >
                                                {isCopied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                                            </button>
                                        </div>
                                        <div className="p-0 overflow-x-auto text-[13px] leading-relaxed relative">
                                            <SyntaxHighlighter
                                                style={vscDarkPlus}
                                                language={match[1]}
                                                PreTag="div"
                                                customStyle={{ margin: 0, padding: '1rem', background: 'transparent' }}
                                                {...props}
                                            >
                                                {textSource}
                                            </SyntaxHighlighter>
                                        </div>
                                    </div>
                                );
                            }
                            return (
                                <code className="bg-muted px-1.5 py-0.5 rounded-sm text-[13px] font-mono whitespace-pre-wrap break-words" {...props}>
                                    {children}
                                </code>
                            );
                        }
                    }}
                >
                    {content}
                </ReactMarkdown>
            </div>
        );
    }

    // Replace [doc_N] or 【doc_N】 with standard markdown link [N](#cite-N)
    let processedContent = content.replace(/(?:\[|【)doc_(\d+)(?:\]|】)/g, '[$1](#cite-$1)');
    
    // Replace [link_ID] and [image_ID] aliases (handling Asian brackets as well)
    processedContent = processedContent
        .replace(/(?:\[|【)link_([^\]】]+)(?:\]|】)/g, '[🔗](#link-$1)')
        .replace(/(?:\[|【)image_([^\]】]+)(?:\]|】)/g, '[🖼️](#image-$1)');

    const renderInlineChip = (source: SourceChunk, docIndex: number, key: string) => {

        const tooltip = (
            <span className="absolute bottom-[calc(100%+4px)] left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-50 flex items-center bg-foreground text-background text-[10px] font-medium px-2.5 py-1.5 rounded-md shadow-lg whitespace-nowrap">
                <span className="truncate max-w-[200px]">{source.filename}</span>
                <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 border-4 border-transparent border-t-foreground"></span>
            </span>
        );

        const chip = (
            <span className="relative group inline-flex items-center align-middle gap-0.5 px-1.5 py-0 mx-0.5 rounded-sm bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-[10px] font-semibold cursor-pointer hover:bg-blue-200 dark:hover:bg-blue-800/60 border border-blue-200 dark:border-blue-700/50 transition-colors whitespace-nowrap leading-none no-underline">
                <FileText className="w-2.5 h-2.5 shrink-0" />
                <span>{docIndex + 1}</span>
                {tooltip}
            </span>
        );

        if (source.source_type === 'pdf' && source.document_id) {
            return (
                <DocumentViewerModal key={key} docId={source.document_id} initialPage={source.page_number} iconOnly>
                    {chip}
                </DocumentViewerModal>
            );
        }
        if (source.source_type === 'bookmark' && source.citation_payload?.canonical_uri) {
            return (
                <a key={key} href={source.citation_payload.canonical_uri} target="_blank" rel="noreferrer" className="no-underline">
                    {chip}
                </a>
            );
        }
        if (source.source_type === 'snip') {
            return (
                <SnipReferenceModal key={key} source={source}>
                    {chip}
                </SnipReferenceModal>
            );
        }
        return <span key={key}>{chip}</span>;
    };

    return (
        <div className="text-[15px] prose dark:prose-invert max-w-none prose-p:leading-relaxed prose-pre:p-0 prose-pre:bg-transparent prose-a:text-primary prose-code:before:hidden prose-code:after:hidden">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    code: ({ node, inline, className, children, ...props }: any) => {
                        const match = /language-(\w+)/.exec(className || '');
                        const [isCopied, setIsCopied] = useState(false);
                        const textSource = String(children).replace(/\n$/, '');

                        const handleCopy = () => {
                            navigator.clipboard.writeText(textSource);
                            setIsCopied(true);
                            setTimeout(() => setIsCopied(false), 2000);
                        };

                        if (!inline && match) {
                            return (
                                <div className="relative group max-w-full my-4 rounded-md overflow-hidden border border-border/50 bg-[#1e1e1e]">
                                    <div className="flex items-center justify-between px-4 py-1.5 bg-muted/30 border-b border-border/50 text-xs text-muted-foreground font-mono">
                                        <span>{match[1]}</span>
                                        <button
                                            onClick={handleCopy}
                                            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-muted rounded transition-all hover:text-foreground"
                                            title="Copy code"
                                        >
                                            {isCopied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                                        </button>
                                    </div>
                                    <div className="p-0 overflow-x-auto text-[13px] leading-relaxed relative text-left">
                                        <SyntaxHighlighter
                                            style={vscDarkPlus}
                                            language={match[1]}
                                            PreTag="div"
                                            customStyle={{ margin: 0, padding: '1rem', background: 'transparent' }}
                                            {...props}
                                        >
                                            {textSource}
                                        </SyntaxHighlighter>
                                    </div>
                                </div>
                            );
                        }
                        return (
                            <code className="bg-muted px-1.5 py-0.5 rounded-sm text-[13px] font-mono whitespace-pre-wrap break-words" {...props}>
                                {children}
                            </code>
                        );
                    },
                    a: ({ node, href, children, ...props }: any) => {
                        if (href && href.startsWith('#cite-')) {
                            const idx = parseInt(href.split('-')[1], 10);
                            const source = sources[idx];
                            if (source) {
                                return renderInlineChip(source, idx, href);
                            }
                            return <sup className="text-[10px] text-muted-foreground">[{idx}]</sup>;
                        }
                        if (href && href.startsWith('#link-')) {
                            const id = href.substring(6);
                            const source = sources.find(s => s.id === id || s.data?.chunk_id === id);
                            if (source) {
                                return (
                                    <a href={source.citation_payload?.canonical_uri || "#"} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-2.5 py-1 mx-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-[11px] font-semibold hover:bg-blue-200 dark:hover:bg-blue-800/60 border border-blue-200 dark:border-blue-700/50 transition-colors no-underline shrink-0">
                                        <ExternalLink className="w-3 h-3" />
                                        <span className="truncate max-w-[200px]">{source.data?.link_title || source.citation_payload?.canonical_uri || "Link"}</span>
                                    </a>
                                );
                            }
                            return <span className="text-muted-foreground text-xs mx-1">[{children}]</span>;
                        }
                        if (href && href.startsWith('#image-')) {
                            const id = href.substring(7);
                            const source = sources.find(s => s.id === id || s.data?.chunk_id === id);
                            if (source) {
                                return (
                                    <a href={source.citation_payload?.canonical_uri || "#"} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-2.5 py-1 mx-0.5 rounded-full bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 text-[11px] font-semibold hover:bg-purple-200 dark:hover:bg-purple-800/60 border border-purple-200 dark:border-purple-700/50 transition-colors no-underline shrink-0">
                                        <ExternalLink className="w-3 h-3" />
                                        <span className="truncate max-w-[200px]">{source.data?.image_title || "Image"}</span>
                                    </a>
                                );
                            }
                            return <span className="text-muted-foreground text-xs mx-1">[{children}]</span>;
                        }
                        // @ts-ignore - ReactMarkdown's types are a bit loose with props spreading
                        return <a href={href} {...props} className="text-primary hover:underline">{children}</a>;
                    }
                }}
            >
                {processedContent}
            </ReactMarkdown>
        </div>
    );
}


function ImagePreviewGrid({ sources }: { sources: SourceChunk[] }) {
    const [items, setItems] = useState<Array<{ source: SourceChunk; imageUrl: string; assetId: string }>>([]);
    const [isLoading, setIsLoading] = useState(false);

    const imageSources = useMemo(() => {
        const seen = new Set<string>();
        const output: SourceChunk[] = [];
        for (const source of sources) {
            const assetId = source.citation_payload?.asset_id;
            if (source.source_type !== "snip" && !assetId) continue;
            const dedupeKey = `${source.source_id}:${assetId || source.id}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            output.push(source);
        }
        return output.slice(0, 6);
    }, [sources]);

    useEffect(() => {
        let disposed = false;
        const urls: string[] = [];

        const load = async () => {
            if (imageSources.length === 0) {
                setItems([]);
                return;
            }

            setIsLoading(true);
            const nextItems: Array<{ source: SourceChunk; imageUrl: string; assetId: string }> = [];
            for (const source of imageSources) {
                let assetId = source.citation_payload?.asset_id || null;

                if (!assetId) {
                    const assets = await dbService.getContextAssets(source.source_id);
                    const imageAsset = assets.find((asset) => (asset.mime_type || "").startsWith("image/"));
                    assetId = imageAsset?.id || null;
                }

                if (!assetId) continue;
                const file = await pdfStore.getAsset(assetId);
                if (!file || !file.type.startsWith("image/")) continue;

                const imageUrl = URL.createObjectURL(file);
                urls.push(imageUrl);
                nextItems.push({ source, imageUrl, assetId });
            }

            if (!disposed) {
                setItems(nextItems);
                setIsLoading(false);
            }
        };

        load();
        return () => {
            disposed = true;
            for (const url of urls) {
                URL.revokeObjectURL(url);
            }
        };
    }, [imageSources]);

    if (imageSources.length === 0) return null;

    return (
        <div className="mt-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                Referenced Visuals
            </div>
            {isLoading ? (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {Array.from({ length: Math.min(6, imageSources.length) }).map((_, idx) => (
                        <div key={idx} className="h-28 md:h-32 rounded-md border bg-muted/40 animate-pulse" />
                    ))}
                </div>
            ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {items.map((item, idx) => (
                        <SnipReferenceModal
                            key={`${item.source.id}-${item.assetId}-${idx}`}
                            source={{
                                ...item.source,
                                citation_payload: {
                                    ...item.source.citation_payload,
                                    asset_id: item.assetId
                                }
                            }}
                        >
                            <button
                                type="button"
                                className="group relative overflow-hidden rounded-md border bg-muted/20 h-28 md:h-32 w-full hover:border-primary/50 transition-colors"
                            >
                                <img
                                    src={item.imageUrl}
                                    alt={item.source.filename}
                                    className="w-full h-full object-cover"
                                />
                                <div className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[10px] px-2 py-1 truncate">
                                    {item.source.filename}
                                </div>
                            </button>
                        </SnipReferenceModal>
                    ))}
                </div>
            )}
        </div>
    );
}

export default function ChatInterface() {
    const [messages, setMessages] = useState<Message[]>([
        { role: 'assistant', content: "Ask me anything across your PDFs, bookmarks, and screen snips." }
    ]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [spaces, setSpaces] = useState<ContextSpace[]>([]);
    const [includeLinks, setIncludeLinks] = useState(false);
    const [experimentalRag, setExperimentalRag] = useState(false);
    const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);

    const scrollRef = useRef<HTMLDivElement>(null);
    const focusedSpaceIds = useExtractionStore(state => state.focusedSpaceIds);
    const setFocusedSpaceIds = useExtractionStore(state => state.setFocusedSpaceIds);
    const focusedSourceTypes = useExtractionStore(state => state.focusedSourceTypes);
    const setFocusedSourceTypes = useExtractionStore(state => state.setFocusedSourceTypes);

    const [location, setLocation] = useLocation();
    const searchString = useSearch();

    useEffect(() => {
        (async () => {
            const loaded = await dbService.getContextSpaces();
            setSpaces(loaded);
            if (focusedSpaceIds.length === 0 && loaded.length > 0) {
                setFocusedSpaceIds([loaded[0].id]);
            }
        })();
    }, [focusedSpaceIds.length, setFocusedSpaceIds]);

    useEffect(() => {
        const params = new URLSearchParams(searchString);
        const spacesParam = params.get('focus_spaces');
        if (spacesParam !== null) {
            const ids = spacesParam.split(',').filter(Boolean);
            if (ids.join(',') !== focusedSpaceIds.join(',')) {
                setFocusedSpaceIds(ids);
            }
        }
    }, [searchString, focusedSpaceIds, setFocusedSpaceIds]);

    useEffect(() => {
        const params = new URLSearchParams(searchString);
        const currentSpaces = params.get('focus_spaces');
        const desiredSpaces = focusedSpaceIds.length > 0 ? focusedSpaceIds.join(',') : null;

        if (desiredSpaces !== currentSpaces) {
            if (desiredSpaces) params.set('focus_spaces', desiredSpaces);
            else params.delete('focus_spaces');
            const newSearch = params.toString();
            setLocation(location.split('?')[0] + (newSearch ? '?' + newSearch : ''), { replace: true });
        }
    }, [focusedSpaceIds, location, searchString, setLocation]);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    const selectedSpaceNames = useMemo(
        () => spaces.filter(s => focusedSpaceIds.includes(s.id)).map(s => s.name),
        [spaces, focusedSpaceIds]
    );

    const toggleSourceType = (type: ContextSourceType) => {
        if (focusedSourceTypes.includes(type)) {
            const next = focusedSourceTypes.filter(t => t !== type);
            if (next.length > 0) setFocusedSourceTypes(next);
            return;
        }
        setFocusedSourceTypes([...focusedSourceTypes, type]);
    };

    const handleSend = async () => {
        if (!input.trim() || isLoading) return;
        const userMsg = input;
        setInput("");
        setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
        setIsLoading(true);

        try {
            const conversation = messages
                .filter(m => !m.error)
                .slice(-6)
                .map(m => ({ role: m.role, content: m.content }));

            // ── 1. Retrieve: 3 terms × up to 20 chunks at ≥60% similarity ──
            const retrievalResult = await contextRetrievalService.retrieve(userMsg, {
                spaceIds: focusedSpaceIds,
                sourceTypes: focusedSourceTypes,
                conversation: conversation,
                includeLinks
            });
            const chunks = contextRetrievalService.formatForModels(retrievalResult.items) as SourceChunk[];
            if (!chunks || chunks.length === 0) {
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: "I couldn't find any relevant data in the selected context spaces.",
                }]);
                return;
            }

            // ── 2. Shortlist: batch 3 chunks at a time (parallel batches) ──
            const BATCH_SIZE = 3;
            const batches: SourceChunk[][] = [];
            for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
                batches.push(chunks.slice(i, i + BATCH_SIZE));
            }

            const batchResults = await Promise.all(
                batches.map(batch => {
                    const candidates = batch.map((c: any) => ({
                        id: c.id,
                        text_summary: c.full_content || c.text_summary || c.raw_text || "",
                    }));
                    return apiService.ragShortlistChunks(userMsg, candidates).then(res => ({
                        evaluations: res.evaluations || [],
                        debug_info: res.debug_info,
                    }));
                })
            );

            const allEvaluations = batchResults.flatMap(r => r.evaluations);
            const keptIds = new Set(allEvaluations.filter((e: any) => e.to_keep).map((e: any) => e.id));
            const filteredChunks = chunks.filter((c: any) => keptIds.has(c.id));

            // ── 3. Generate answer with enriched text from kept chunks ──
            const { response, used_chunk_ids, debug_info } = await apiService.generateRagChat(
                userMsg,
                filteredChunks.length > 0 ? filteredChunks : chunks.slice(0, 5),
                conversation
            );

            const pipeline_step: PipelineStep = {
                queryTerms: retrievalResult.debug?.generated_search_terms || [],
                retrievedCount: chunks.length,
                evaluations: chunks.map((c: any) => ({
                    id: c.id,
                    filename: c.filename,
                    summary: c.text_summary || "",
                    toKeep: keptIds.has(c.id),
                    source: c,
                })),
            };

            setMessages(prev => [...prev, {
                role: 'assistant',
                content: response,
                sources: filteredChunks.length > 0 ? filteredChunks : chunks.slice(0, 5),
                used_chunk_ids,
                debug_info: {
                    retrieval: retrievalResult.debug,
                    shortlist: batchResults[0]?.debug_info,
                    backend: debug_info,
                },
                pipeline_step,
            }]);
        } catch (e: any) {
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: "Sorry, I encountered an error processing your request.",
                error: e.message,
            }]);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex flex-col h-full bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 relative overflow-hidden">
            <div className="absolute inset-0 bg-linear-to-b from-blue-50/50 dark:from-blue-950/20 via-slate-50 dark:via-slate-950 to-indigo-50/50 dark:to-indigo-950/10 pointer-events-none" />

            <div className="px-5 py-3 border-b border-blue-100 dark:border-blue-500/20 bg-white/80 dark:bg-slate-950/80 backdrop-blur-md flex items-center justify-between z-10 sticky top-0">
                <div className="flex items-center gap-2.5">
                    <div className="bg-blue-100 dark:bg-blue-500/20 p-1.5 rounded-lg border border-blue-200 dark:border-blue-500/30">
                        <MessageSquare className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    </div>
                    <div>
                        <h2 className="text-sm font-semibold text-blue-900 dark:text-blue-100 tracking-wide">Context Chat</h2>
                        <p className="text-[10px] text-blue-600/80 dark:text-blue-400/80">Multi-source retrieval</p>
                    </div>
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4" ref={scrollRef}>
                <div className="space-y-6 max-w-3xl mx-auto pb-32">
                    {messages.map((m, i) => {
                        const usedSources = (m.sources && m.used_chunk_ids && m.used_chunk_ids.length > 0)
                            ? m.used_chunk_ids.map(id => m.sources?.find(s => s.id === id)).filter((s): s is SourceChunk => !!s)
                            : [];

                        const copyMessage = () => {
                            navigator.clipboard.writeText(m.content);
                            setCopiedMessageIndex(i);
                            setTimeout(() => setCopiedMessageIndex(prev => prev === i ? null : prev), 2000);
                        };

                        const redoQuery = () => {
                            if (isLoading) return;
                            const queryToRedo = m.role === 'user' ? m.content : messages[i - 1]?.content;
                            if (queryToRedo) {
                                setInput(queryToRedo);
                                setTimeout(() => {
                                    handleSend();
                                }, 100);
                            }
                        };

                        return (
                            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} group/message relative`}>
                                <div className={`flex flex-col gap-2 max-w-[85%] ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                                    

                                    <div className={`relative w-full ${m.role === 'user' ? 'bg-muted dark:bg-muted/40 text-foreground px-5 py-3 rounded-3xl rounded-tr-md text-[15px] leading-relaxed max-w-[85%]' : 'py-2'}`}>
                                        
                                        {m.role === 'assistant' ? (
                                            <AssistantContent
                                                content={m.content}
                                                sources={m.sources}
                                            />
                                        ) : (
                                            <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                                        )}

                                        {m.error && (
                                            <div className="text-xs text-destructive bg-destructive/10 p-3 rounded-md border border-destructive/20 mt-1">
                                                <strong>Error:</strong> {m.error}
                                            </div>
                                        )}

                                        {usedSources.length > 0 && (
                                            <div className="flex flex-col gap-1.5 mt-2">
                                                <CitationGroup sources={usedSources} />
                                            </div>
                                        )}

                                        {usedSources.length > 0 && (
                                            <div className="mt-2">
                                                <ImagePreviewGrid sources={usedSources} />
                                            </div>
                                        )}
                                    </div>
                                    {/* Hover Actions Bar */}
                                    <div className={`flex flex-row opacity-0 group-hover/message:opacity-100 transition-opacity gap-1 mt-1 ${m.role === 'user' ? 'self-end' : 'self-start'} z-10`}>
                                        <button onClick={copyMessage} title="Copy Markdown" className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-full transition-colors flex items-center justify-center">
                                            {copiedMessageIndex === i ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                                        </button>
                                        
                                        {m.role === 'assistant' && (
                                            <Dialog>
                                                <DialogTrigger asChild>
                                                    <button title="RAG Debug Info" className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-full transition-colors flex items-center justify-center">
                                                        <Info className="w-3.5 h-3.5" />
                                                    </button>
                                                </DialogTrigger>
                                                <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col p-0 overflow-hidden outline-none bg-background shadow-2xl border-border/40">
                                                    <DialogHeader className="px-6 pt-6 pb-4 border-b shrink-0 flex flex-row items-center gap-3">
                                                        <div className="bg-primary/10 p-2 rounded-lg"><Bug className="w-5 h-5 text-primary" /></div>
                                                        <div>
                                                            <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">RAG Pipeline Explorer</DialogTitle>
                                                        </div>
                                                    </DialogHeader>
                                                    <div className="flex-1 overflow-y-auto p-6 bg-muted/10 custom-scrollbar">
                                                        {m.pipeline_step && (
                                                            <div className="mb-6 space-y-4">
                                                                <h3 className="text-sm font-semibold flex items-center gap-2"><Loader2 className="w-4 h-4 text-primary" /> Pipeline Trace</h3>
                                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                                    <div className="bg-card border rounded-xl p-4 shadow-sm">
                                                                        <div className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wider">Search Terms Used</div>
                                                                        <div className="flex flex-wrap gap-2">
                                                                            {m.pipeline_step.queryTerms?.map(term => <span key={term} className="px-2.5 py-1 text-xs rounded-full border bg-muted/50 font-medium">{term}</span>)}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        )}
                                                        <div className="text-sm font-semibold flex items-center gap-2 mb-4"><BookOpen className="w-4 h-4 text-primary" /> Context Sources ({m.sources?.length || 0})</div>
                                                        <div className="grid gap-3">
                                                            {m.sources?.map((source, idx) => (
                                                                <div key={idx} className="flex flex-col gap-2 p-4 rounded-xl border bg-card text-xs shadow-sm">
                                                                    <div className="flex items-start justify-between gap-3">
                                                                        <div className="font-medium flex items-center gap-2 flex-wrap text-foreground">
                                                                            <FileText className="w-4 h-4 text-primary shrink-0" />
                                                                            <span className="text-sm font-semibold">{source.filename}</span>
                                                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary uppercase tracking-wider font-semibold">{source.source_type}</span>
                                                                            {m.used_chunk_ids?.includes(source.id) && (
                                                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1 border border-emerald-500/20"><Check className="w-3 h-3"/> Used</span>
                                                                            )}
                                                                        </div>
                                                                        <SourceLink source={source} />
                                                                    </div>
                                                                    <div className="text-muted-foreground/80 mt-1 pl-6 leading-relaxed bg-muted/20 p-3 rounded-lg border border-border/50">
                                                                        {source.text_summary || source.full_content || source.raw_text}
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                </DialogContent>
                                            </Dialog>
                                        )}
                                        
                                        {(!isLoading) && (
                                            <button onClick={redoQuery} title="Redo Query" className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-full transition-colors flex items-center justify-center">
                                                <RotateCcw className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>

                                </div>
                            </div>
                        );
                    })}
                    {isLoading && (
                        <div className="flex justify-start animate-in fade-in slide-in-from-bottom-2 duration-300">
                            <div className="py-2 flex items-center gap-3">
                                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                                <span className="text-sm text-muted-foreground mt-0.5">Searching context and composing answer...</span>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <div className={`p-4 border-t bg-background/80 backdrop-blur-sm sticky bottom-0 ${focusedSpaceIds.length > 0 ? 'border-blue-200 dark:border-blue-900 bg-blue-50/30 dark:bg-blue-950/20' : ''}`}>
                <div className="max-w-3xl mx-auto flex flex-col gap-3 relative">
                    {selectedSpaceNames.length > 0 && (
                        <div className="flex flex-wrap gap-2 px-1 text-xs">
                            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center pr-2">
                                <MessageSquare className="w-3.5 h-3.5 mr-1" /> Spaces:
                            </span>
                            {selectedSpaceNames.map(name => (
                                <span key={name} className="px-2 py-1 rounded-full border bg-blue-100/50 dark:bg-blue-900/30">{name}</span>
                            ))}
                            {focusedSourceTypes.map(type => (
                                <span key={type} className="px-2 py-1 rounded-full border bg-muted">{type}</span>
                            ))}
                        </div>
                    )}

                    <div className="flex gap-2">
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="outline" size="icon" className="shrink-0 rounded-full h-11 w-11 shadow-sm relative transition-colors">
                                    <Plus className="h-5 w-5" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="w-[280px]">
                                <DropdownMenuLabel>Focus Spaces</DropdownMenuLabel>
                                {spaces.map(space => (
                                    <DropdownMenuCheckboxItem
                                        key={space.id}
                                        checked={focusedSpaceIds.includes(space.id)}
                                        onCheckedChange={(checked) => {
                                            if (checked) setFocusedSpaceIds([...focusedSpaceIds, space.id]);
                                            else setFocusedSpaceIds(focusedSpaceIds.filter(id => id !== space.id));
                                        }}
                                    >
                                        {space.name}
                                    </DropdownMenuCheckboxItem>
                                ))}
                                <DropdownMenuSeparator />
                                <DropdownMenuLabel>Source Types</DropdownMenuLabel>
                                {(["pdf", "bookmark", "snip"] as ContextSourceType[]).map(type => (
                                    <DropdownMenuCheckboxItem
                                        key={type}
                                        checked={focusedSourceTypes.includes(type)}
                                        onCheckedChange={() => toggleSourceType(type)}
                                    >
                                        {type}
                                    </DropdownMenuCheckboxItem>
                                ))}
                                <DropdownMenuSeparator />
                                <DropdownMenuCheckboxItem
                                    checked={experimentalRag}
                                    onCheckedChange={setExperimentalRag}
                                >
                                    Experimental RAG Mode
                                </DropdownMenuCheckboxItem>
                                <DropdownMenuCheckboxItem
                                    checked={includeLinks}
                                    onCheckedChange={setIncludeLinks}
                                >
                                    Include Links
                                </DropdownMenuCheckboxItem>
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <div className="flex items-end gap-2 transition-all flex-1">
                            <div className="relative flex-1">
                                <AutoResizeTextarea
                                    placeholder="Ask about your context spaces..."
                                    value={input}
                                    onChange={e => setInput(e.target.value)}
                                    onEnter={() => {
                                        if (!isLoading && input.trim()) handleSend();
                                    }}
                                    disabled={isLoading}
                                    className="border shadow-sm focus-visible:ring-1 bg-background px-4 py-3 min-h-[44px] rounded-3xl border-primary/20 focus-visible:ring-primary w-full transition-all"
                                />
                            </div>
                            <Button
                                onClick={handleSend}
                                disabled={isLoading || !input.trim()}
                                size="icon"
                                className="rounded-full shadow-sm shrink-0 h-[44px] w-[44px]"
                            >
                                <ArrowUp className="w-5 h-5" />
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
