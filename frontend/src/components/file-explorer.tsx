import { useState, useEffect, useMemo } from "react"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { FileText, ChevronLeft, ChevronRight, Loader2, Search, Link2, Image as ImageIcon, Layers, Trash2, AlertTriangle } from "lucide-react"
import { useExtractionStore } from '@/store/extraction-store'
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { apiService } from '@/services/api-service'
import { dbService, type ContextExplorerItem, type ContextSourceType } from '@/services/db-service'

interface FileExplorerProps {
    onSelectItem: (item: ContextExplorerItem) => void;
}

const FILTERS: Array<'all' | ContextSourceType> = ['all', 'pdf', 'bookmark', 'snip'];

export function FileExplorer({ onSelectItem }: FileExplorerProps) {
    const focusedSpaceIds = useExtractionStore(state => state.focusedSpaceIds);
    const jobs = useExtractionStore(state => state.jobs);
    const contextJobs = useExtractionStore(state => state.contextJobs);
    const trashJob = useExtractionStore(state => state.trashJob);

    const [allItems, setAllItems] = useState<ContextExplorerItem[]>([]);
    const [typeFilter, setTypeFilter] = useState<'all' | ContextSourceType>('all');
    const [searchQuery, setSearchQuery] = useState("");
    const [isSearching, setIsSearching] = useState(false);
    const [searchResults, setSearchResults] = useState<string[] | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<ContextExplorerItem | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    const [currentPage, setCurrentPage] = useState(1);
    const itemsPerPage = 10;

    const activeSourceTypes = useMemo(
        () => typeFilter === 'all' ? undefined : [typeFilter],
        [typeFilter]
    );

    const loadItems = async () => {
        const items = await dbService.getContextExplorerItems(
            focusedSpaceIds.length > 0 ? focusedSpaceIds : undefined,
            activeSourceTypes
        );
        setAllItems(items);
    };

    useEffect(() => {
        loadItems();
    }, [jobs, contextJobs, focusedSpaceIds.join(','), typeFilter]);

    useEffect(() => {
        setCurrentPage(1);
    }, [searchResults, typeFilter]);

    useEffect(() => {
        const handler = setTimeout(async () => {
            if (!searchQuery.trim()) {
                setSearchResults(null);
                setIsSearching(false);
                return;
            }

            setIsSearching(true);
            try {
                const embeddings = await apiService.generateEmbeddings([searchQuery]);
                if (embeddings && embeddings.length > 0) {
                    const matchedIds = await dbService.semanticContextSourceSearch(
                        embeddings[0],
                        focusedSpaceIds.length > 0 ? focusedSpaceIds : undefined,
                        activeSourceTypes
                    );
                    setSearchResults(matchedIds);
                } else {
                    setSearchResults([]);
                }
            } catch (err) {
                console.error("Semantic search failed:", err);
                const term = searchQuery.toLowerCase();
                const matched = allItems
                    .filter(item =>
                        item.title.toLowerCase().includes(term) ||
                        (item.summary || "").toLowerCase().includes(term) ||
                        (item.canonical_uri || "").toLowerCase().includes(term)
                    )
                    .map(item => item.id);
                setSearchResults(matched);
            } finally {
                setIsSearching(false);
            }
        }, 500);

        return () => clearTimeout(handler);
    }, [searchQuery, allItems, focusedSpaceIds.join(','), typeFilter]);

    let itemList = [...allItems];
    if (searchResults !== null) {
        itemList = itemList
            .filter(item => searchResults.includes(item.id))
            .sort((a, b) => searchResults.indexOf(a.id) - searchResults.indexOf(b.id));
    }

    const totalPagesCount = Math.ceil(itemList.length / itemsPerPage) || 1;
    const startIndex = (currentPage - 1) * itemsPerPage;
    const visibleItems = itemList.slice(startIndex, startIndex + itemsPerPage);

    const handlePrevPage = () => {
        if (currentPage > 1) setCurrentPage(currentPage - 1);
    };

    const handleNextPage = () => {
        if (currentPage < totalPagesCount) setCurrentPage(currentPage + 1);
    };

    const renderTypeIcon = (type: ContextSourceType) => {
        if (type === 'bookmark') return <Link2 className="h-4 w-4 text-muted-foreground shrink-0" />;
        if (type === 'snip') return <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0" />;
        return <FileText className="h-4 w-4 text-muted-foreground shrink-0" />;
    };

    const handleDelete = async () => {
        if (!deleteTarget) return;
        setIsDeleting(true);
        try {
            if (deleteTarget.source_type === 'pdf' && deleteTarget.legacy_document_id) {
                await trashJob(deleteTarget.legacy_document_id);
            } else {
                await dbService.softDeleteContextSource(deleteTarget.id);
            }
            setDeleteTarget(null);
            await loadItems();
        } catch (err) {
            console.error("Failed to delete source:", err);
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <div className="flex flex-col h-full cx-surface overflow-hidden">
            <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
                <DialogContent className="sm:max-w-[420px] border border-border dark:border-white/10 bg-card dark:bg-[#2f3136] rounded-3xl">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <AlertTriangle className="h-5 w-5 text-destructive" />
                            Delete Source?
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-2 py-2">
                        <p className="text-sm text-muted-foreground">
                            <span className="font-medium text-foreground">{deleteTarget?.title || "This source"}</span>{" "}
                            will be removed from your context explorer.
                        </p>
                        {deleteTarget?.source_type === "bookmark" && (
                            <p className="text-xs text-muted-foreground">
                                This removes bookmark versions from retrieval for this URL in this context space.
                            </p>
                        )}
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={isDeleting}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
                            {isDeleting ? "Deleting..." : "Delete"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <div className="flex items-center justify-between p-4 border-b border-border dark:border-white/10 gap-4 flex-wrap bg-black/[0.02] dark:bg-black/10">
                <h2 className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground hidden sm:flex items-center gap-2 whitespace-nowrap">
                    <Layers className="h-4 w-4 text-muted-foreground" />
                    Context Explorer
                </h2>

                <div className="flex-1 max-w-md relative flex items-center min-w-[220px]">
                    <Search className="absolute left-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        type="search"
                        placeholder="Semantic search sources and chunks..."
                        className="w-full cx-input pl-9 pr-8"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                    {isSearching && (
                        <Loader2 className="absolute right-3 h-4 w-4 animate-spin text-muted-foreground" />
                    )}
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                    <div className="flex items-center gap-1 cx-pill-group">
                        {FILTERS.map(filter => (
                            <Button
                                key={filter}
                                variant={typeFilter === filter ? "secondary" : "ghost"}
                                size="sm"
                                className={`h-7 text-xs rounded-full ${typeFilter === filter ? 'cx-pill-active' : ''}`}
                                onClick={() => setTypeFilter(filter)}
                            >
                                {filter === 'all' ? 'All' : filter}
                            </Button>
                        ))}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground whitespace-nowrap">
                        <span>{itemList.length} sources</span>
                        <div className="flex items-center gap-1 cx-pill-group">
                            <Button variant="ghost" size="icon" className="h-6 w-6 rounded-sm" onClick={handlePrevPage} disabled={currentPage === 1}>
                                <ChevronLeft className="h-3 w-3" />
                            </Button>
                            <span className="px-2 font-medium">{currentPage} / {totalPagesCount}</span>
                            <Button variant="ghost" size="icon" className="h-6 w-6 rounded-sm" onClick={handleNextPage} disabled={currentPage === totalPagesCount}>
                                <ChevronRight className="h-3 w-3" />
                            </Button>
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-auto">
                <Table>
                    <TableHeader className="cx-table-header sticky top-0">
                        <TableRow>
                            <TableHead className="w-full pl-6 text-[11px] uppercase tracking-wide text-muted-foreground">Source</TableHead>
                            <TableHead className="w-[90px] text-[11px] uppercase tracking-wide text-muted-foreground">Type</TableHead>
                            <TableHead className="w-[120px] text-[11px] uppercase tracking-wide text-muted-foreground">Status</TableHead>
                            <TableHead className="w-[80px] text-right text-[11px] uppercase tracking-wide text-muted-foreground">Chunks</TableHead>
                            <TableHead className="w-[80px] text-right pr-6 text-[11px] uppercase tracking-wide text-muted-foreground">Pages</TableHead>
                            <TableHead className="w-[70px] text-right pr-4 text-[11px] uppercase tracking-wide text-muted-foreground">Action</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {visibleItems.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                                    No sources available.
                                </TableCell>
                            </TableRow>
                        ) : (
                            visibleItems.map((item) => (
                                <TableRow
                                    key={item.id}
                                    className="cursor-pointer cx-row-hover"
                                    onClick={() => onSelectItem(item)}
                                >
                                    <TableCell className="font-medium pl-6 max-w-0">
                                        <div className="flex items-center gap-2 truncate">
                                            {renderTypeIcon(item.source_type)}
                                            <div className="flex flex-col min-w-0">
                                                <span className="truncate" title={item.title}>{item.title}</span>
                                                <span className="text-[10px] text-muted-foreground truncate">
                                                    {item.space_name || item.space_id}
                                                </span>
                                            </div>
                                        </div>
                                    </TableCell>
                                    <TableCell className="capitalize text-xs">{item.source_type}</TableCell>
                                    <TableCell>
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <div className={`w-2.5 h-2.5 rounded-full ${item.status === 'completed' ? 'bg-green-500' : item.status === 'error' ? 'bg-red-500' : 'bg-yellow-500'}`} />
                                            </TooltipTrigger>
                                            <TooltipContent className="max-w-[95vw] wrap-break-word">
                                                <p className="capitalize">Status: {item.status}</p>
                                            </TooltipContent>
                                        </Tooltip>
                                    </TableCell>
                                    <TableCell className="text-right text-muted-foreground">{item.segment_count}</TableCell>
                                    <TableCell className="text-right text-muted-foreground pr-6">
                                        {item.source_type === 'pdf' ? (item.total_pages || item.max_page_number || 1) : (item.max_page_number || '-')}
                                    </TableCell>
                                    <TableCell className="text-right pr-4">
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-full"
                                            title="Delete source"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setDeleteTarget(item);
                                            }}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </div>
        </div>
    )
}
