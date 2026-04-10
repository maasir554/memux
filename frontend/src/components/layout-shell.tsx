import { useState, useEffect, useRef } from 'react'
import { useRoute, useLocation } from 'wouter'
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import {
    Menu, Database, MessageSquare,
    Activity, ChevronsLeft, ChevronsRight, Layers, ChevronDown, FlaskConical, SearchCode
} from "lucide-react"
import { NewPdfModal } from "@/components/new-pdf-modal"
import { ProcessingQueue } from "@/components/processing-queue"
import { ThemeToggle } from "@/components/theme-toggle"
import { useExtractionStore } from '@/store/extraction-store'
import { dbService, type ContextSpace } from '@/services/db-service'

interface SidebarProps {
    className?: string
    collapsed?: boolean
    onToggleCollapse?: () => void
}

export function Sidebar({ className, collapsed = false, onToggleCollapse }: SidebarProps) {
    const [location, setLocation] = useLocation();
    const focusedSpaceIds = useExtractionStore(state => state.focusedSpaceIds);
    const setFocusedSpaceIds = useExtractionStore(state => state.setFocusedSpaceIds);
    const [spaces, setSpaces] = useState<ContextSpace[]>([]);

    useEffect(() => {
        (async () => {
            await dbService.getDefaultContextSpace();
            const loaded = await dbService.getContextSpaces();
            setSpaces(loaded);
            if (loaded.length > 0 && focusedSpaceIds.length === 0) {
                setFocusedSpaceIds([loaded[0].id]);
            }
        })();
    }, [focusedSpaceIds.length, setFocusedSpaceIds]);

    const navButtonClass = (isActive: boolean) =>
        `w-full h-9 rounded-full transition-colors ${collapsed ? 'justify-center px-0' : 'justify-start'} ` +
        (isActive
            ? 'bg-white text-black dark:bg-white dark:text-black hover:bg-white/90 dark:hover:bg-white/90'
            : 'text-foreground/85 hover:text-foreground bg-transparent hover:bg-white/8 dark:hover:bg-white/8');

    return (
        <div className={`pb-12 border-r h-screen flex flex-col transition-all duration-200 ease-in-out ${collapsed ? 'w-14' : 'w-60'} ${className ?? ''} bg-background dark:bg-[#222326] border-border dark:border-white/10`}>
            <div className="flex-1 flex flex-col overflow-hidden">
                {/* Brand */}
                <div className={`px-3 py-4 flex items-center ${collapsed ? 'justify-center' : 'gap-2 px-4'} bg-black/10 dark:bg-black/20`}>
                    <div className="h-6 w-6 rounded-none shrink-0 bg-[#E79BB8]" />
                    {!collapsed && (
                        <span className="text-2xl leading-none font-space-mono font-bold tracking-tight truncate bg-gradient-to-r from-[#EEDFB5] via-[#DB96D1] via-[#E79BB8] to-[#F2C3A7] text-transparent bg-clip-text">
                            MEMUX
                        </span>
                    )}
                </div>

                <Separator />

                {!collapsed && (
                    <div className="px-3 py-3.5 border-b border-border dark:border-white/10 space-y-2.5">
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
                            <Layers className="h-3 w-3" />
                            Context Space
                        </div>
                        <div className="relative">
                            <select
                                value={focusedSpaceIds[0] || ""}
                                onChange={(e) => setFocusedSpaceIds(e.target.value ? [e.target.value] : [])}
                                className="w-full h-10 border rounded-full bg-background dark:bg-[#2d2f33] border-border dark:border-white/10 pl-4 pr-10 text-sm font-medium leading-none appearance-none"
                            >
                                {spaces.map(space => (
                                    <option key={space.id} value={space.id}>
                                        {space.name}
                                    </option>
                                ))}
                            </select>
                            <ChevronDown className="h-4 w-4 text-muted-foreground pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" />
                        </div>
                        <Button
                            variant="ghost"
                            className="w-full h-9 px-3 rounded-full text-sm justify-start text-foreground/90 hover:bg-white/8 dark:hover:bg-white/8"
                            onClick={() => setLocation('/spaces')}
                        >
                            Manage Spaces
                        </Button>
                    </div>
                )}

                {/* Nav */}
                <div className={`py-3 space-y-1 ${collapsed ? 'px-1.5' : 'px-3'}`}>
                    <Button variant="ghost" className={navButtonClass(location.startsWith('/chat'))} title="Chat Assistant" onClick={() => setLocation('/chat')}>
                        <MessageSquare className="h-4 w-4 shrink-0" />
                        {!collapsed && <span className="ml-2 truncate">Chat & RAG</span>}
                    </Button>
                    <Button variant="ghost" className={navButtonClass(location.startsWith('/data'))} title="Data Explorer" onClick={() => setLocation('/data')}>
                        <Database className="h-4 w-4 shrink-0" />
                        {!collapsed && <span className="ml-2 truncate">Data Explorer</span>}
                    </Button>
                    <Button variant="ghost" className={navButtonClass(location.startsWith('/dev'))} title="Dev Tools" onClick={() => setLocation('/dev')}>
                        <FlaskConical className="h-4 w-4 shrink-0" />
                        {!collapsed && <span className="ml-2 truncate">Dev</span>}
                    </Button>
                    <Button variant="ghost" className={navButtonClass(location.startsWith('/chunks'))} title="Chunk Search" onClick={() => setLocation('/chunks')}>
                        <SearchCode className="h-4 w-4 shrink-0" />
                        {!collapsed && <span className="ml-2 truncate">Chunk Search</span>}
                    </Button>
                    <Sheet>
                        <SheetTrigger asChild>
                            <Button variant="ghost" className={`w-full md:hidden ${collapsed ? 'justify-center px-0' : 'justify-start'}`} title="Activity Queue">
                                <Activity className="h-4 w-4 shrink-0" />
                                {!collapsed && <span className="ml-2 truncate">Activity Queue</span>}
                            </Button>
                        </SheetTrigger>
                        <SheetContent side="right" className="p-0 w-80">
                            <div className="w-full h-full flex flex-col min-w-0">
                                <div className="p-4 border-b bg-background/50 backdrop-blur flex items-center gap-2 font-semibold">
                                    <Activity className="h-4 w-4" />
                                    Activity
                                </div>
                                <div className="flex-1 w-full overflow-hidden min-h-0">
                                    <ProcessingQueue />
                                </div>
                            </div>
                        </SheetContent>
                    </Sheet>
                </div>

                <Separator />

                {/* Add Context */}
                <div className={`py-3 flex-1 flex flex-col overflow-hidden ${collapsed ? 'px-1.5' : 'px-3'}`}>
                    {!collapsed && (
                        <div className="mb-3 px-1">
                            <NewPdfModal />
                        </div>
                    )}

                    {collapsed && (
                        <div className="flex flex-col items-center gap-1">
                            <NewPdfModal collapsed />
                        </div>
                    )}
                </div>
            </div>

            {/* Footer: Settings + Collapse */}
            <div className={`border-t border-border dark:border-white/10 py-2 space-y-1 ${collapsed ? 'px-1.5' : 'px-3'}`}>
                <ThemeToggle collapsed={collapsed} />
                {onToggleCollapse && (
                    <Button variant="ghost" className={`w-full text-muted-foreground ${collapsed ? 'justify-center px-0' : 'justify-start'}`} onClick={onToggleCollapse} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
                        {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
                        {!collapsed && <span className="ml-2">Collapse</span>}
                    </Button>
                )}
            </div>
        </div>
    )
}

export default function LayoutShell({ children }: { children: React.ReactNode }) {
    const [isSidebarOpen, setIsSidebarOpen] = useState(false)
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
    const [activityOpen, setActivityOpen] = useState(true)
    const [highlightedJobId, setHighlightedJobId] = useState<string | null>(null)
    const [isDocRoute] = useRoute('/document/:id/*?');
    const [isSourceRoute] = useRoute('/source/:id/*?');
    const [location] = useLocation();
    const isDetailRoute = isDocRoute || isSourceRoute;

    // Track job count to detect newly added jobs
    const jobs = useExtractionStore(state => state.jobs);
    const contextJobs = useExtractionStore(state => state.contextJobs);
    const prevJobCountRef = useRef(Object.keys(jobs).length + Object.keys(contextJobs).length);

    useEffect(() => {
        const jobIds = [...Object.keys(jobs), ...Object.keys(contextJobs)];
        const currentCount = jobIds.length;
        if (currentCount > prevJobCountRef.current) {
            // A new job was added — expand the activity queue and highlight
            setActivityOpen(true);
            const newestId = jobIds[jobIds.length - 1];
            setHighlightedJobId(newestId);
            // Clear highlight after animation
            const timer = setTimeout(() => setHighlightedJobId(null), 2000);
            return () => clearTimeout(timer);
        }
        prevJobCountRef.current = currentCount;
    }, [jobs, contextJobs]);

    return (
        <div className="flex min-h-screen bg-background text-foreground font-sans antialiased">
            {/* Desktop Left Sidebar */}
            <aside className="hidden md:flex shrink-0">
                <Sidebar
                    collapsed={sidebarCollapsed}
                    onToggleCollapse={() => setSidebarCollapsed(c => !c)}
                />
            </aside>

            {/* Mobile Left Sidebar */}
            <Sheet open={isSidebarOpen} onOpenChange={setIsSidebarOpen}>
                <SheetTrigger asChild className={`absolute left-4 top-4 z-40 ${isDetailRoute ? 'hidden' : 'md:hidden'}`}>
                    <Button variant="outline" size="icon">
                        <Menu className="h-4 w-4" />
                    </Button>
                </SheetTrigger>
                <SheetContent side="left" className="p-0 w-60">
                    <Sidebar />
                </SheetContent>
            </Sheet>

            {/* Main Content */}
            <main className="flex-1 flex flex-col h-screen overflow-hidden relative">
                {/* Mobile Right Sidebar Toggle */}
                {location === '/' && (
                    <Sheet>
                        <SheetTrigger asChild className="hidden md:flex lg:hidden absolute right-4 top-4 z-40">
                            <Button variant="outline" size="icon">
                                <Activity className="h-4 w-4" />
                            </Button>
                        </SheetTrigger>
                        <SheetContent side="right" className="p-0 w-80">
                            <div className="w-full h-full flex flex-col min-w-0">
                                <div className="p-4 border-b bg-background/50 backdrop-blur flex items-center gap-2 font-semibold">
                                    <Activity className="h-4 w-4" />
                                    Activity
                                </div>
                                <div className="flex-1 w-full overflow-hidden min-h-0">
                                    <ProcessingQueue highlightedJobId={highlightedJobId} />
                                </div>
                            </div>
                        </SheetContent>
                    </Sheet>
                )}

                {/* Right sidebar toggle when collapsed (Desktop) */}
                {!activityOpen && location === '/' && (
                    <button
                        onClick={() => setActivityOpen(true)}
                        className="absolute right-3 top-3 z-30 bg-muted/80 hover:bg-muted border rounded-md p-1.5 transition-colors hidden lg:flex items-center"
                        title="Open Activity Queue"
                    >
                        <Activity className="h-4 w-4 text-muted-foreground" />
                    </button>
                )}
                <div className="flex-1 overflow-y-auto p-6 md:p-4 md:pt-4 w-full">
                    {children}
                </div>
            </main>

            {/* Right Sidebar Desktop (Processing Queue) */}
            {location === '/' && (
                <aside className={`hidden lg:flex border-l bg-muted/5 flex-col shrink-0 transition-all duration-200 ease-in-out overflow-hidden ${activityOpen ? 'w-80' : 'w-0 border-l-0'}`}>
                    <div className="w-80 h-full flex flex-col min-w-0">
                        <div className="p-3 border-b bg-background/50 backdrop-blur flex items-center justify-between shrink-0">
                            <div className="flex items-center gap-2 font-semibold text-sm">
                                <Activity className="h-4 w-4" />
                                Activity
                            </div>
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setActivityOpen(false)} title="Close Activity Queue">
                                <ChevronsRight className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                        <div className="flex-1 w-full overflow-hidden min-h-0">
                            <ProcessingQueue highlightedJobId={highlightedJobId} />
                        </div>
                    </div>
                </aside>
            )}
        </div>
    )
}
