import { useEffect, useState } from 'react'
import { getDb } from "@/lib/db"
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Play, RefreshCw, Database, FileText, Layers, ChevronRight } from "lucide-react"

const CORE_TABLES = [
    { name: "documents", icon: FileText, label: "Documents" },
    { name: "pdf_tables", icon: Layers, label: "PDF Tables" },
    { name: "chunks", icon: Database, label: "Chunks" },
    { name: "context_spaces", icon: Layers, label: "Context Spaces" },
    { name: "context_sources", icon: FileText, label: "Context Sources" },
    { name: "context_assets", icon: FileText, label: "Context Assets" },
    { name: "context_segments", icon: Database, label: "Context Segments" },
]

function formatPreviewValue(key: string, value: any) {
    // Hide vector embeddings — too large to display
    if (key.includes('embedding')) {
        if (!value) return <span className="text-muted-foreground italic">null</span>
        return <span className="text-muted-foreground italic text-xs">vector[{value.length || '?'}]</span>
    }

    if (value === null || value === undefined) {
        return <span className="text-muted-foreground italic">null</span>
    }

    if (typeof value === 'object') {
        const preview = JSON.stringify(value).slice(0, 80)
        return (
            <span className="text-xs cursor-pointer hover:text-primary transition-colors font-mono">
                {preview.length > 80 ? preview + '…' : preview}
            </span>
        )
    }

    // Truncate long text
    const str = String(value)
    if (str.length > 80) {
        return <span title={str}>{str.slice(0, 80)}…</span>
    }

    return <span>{str}</span>
}

function shouldOpenCellModal(key: string, value: any) {
    if (key.includes('embedding')) return false;
    if (value === null || value === undefined) return false;
    if (typeof value === 'object') return true;
    if (typeof value === 'string') return value.length > 80;
    return false;
}

function formatFullValue(value: any): string {
    if (value === null || value === undefined) return "null";
    if (typeof value === "object") return JSON.stringify(value, null, 2);
    return String(value);
}

export default function DataExplorer() {
    const [activeTable, setActiveTable] = useState<string>("documents")
    const [tableData, setTableData] = useState<any[]>([])
    const [sqlQuery, setSqlQuery] = useState("")
    const [queryResult, setQueryResult] = useState<any[]>([])
    const [error, setError] = useState<string | null>(null)
    const [rowCount, setRowCount] = useState<Record<string, number>>({})
    const [selectedCell, setSelectedCell] = useState<{
        table: string;
        column: string;
        value: any;
    } | null>(null)

    useEffect(() => {
        fetchTableData(activeTable)
        fetchRowCounts()
    }, [])

    const fetchRowCounts = async () => {
        try {
            const db = getDb()
            const counts: Record<string, number> = {}
            for (const t of CORE_TABLES) {
                try {
                    const res = await db.query(`SELECT COUNT(*) as count FROM ${t.name}`)
                    counts[t.name] = Number((res.rows[0] as any).count)
                } catch {
                    counts[t.name] = 0
                }
            }
            setRowCount(counts)
        } catch (e) {
            console.error("Failed to fetch row counts", e)
        }
    }

    const fetchTableData = async (tableName: string) => {
        setActiveTable(tableName)
        setError(null)
        try {
            const db = getDb()
            const res = await db.query(`SELECT * FROM ${tableName} ORDER BY created_at DESC LIMIT 100`)
            setTableData(res.rows)
        } catch (e: any) {
            setError(e.message)
            setTableData([])
        }
    }

    const runQuery = async () => {
        if (!sqlQuery) return
        try {
            const db = getDb()
            const res = await db.query(sqlQuery)
            setQueryResult(res.rows)
            setError(null)
        } catch (e: any) {
            setError(e.message)
            setQueryResult([])
        }
    }

    const refresh = () => {
        fetchTableData(activeTable)
        fetchRowCounts()
    }

    return (
        <div className="h-full flex flex-col space-y-4">
            <Dialog open={!!selectedCell} onOpenChange={(open) => !open && setSelectedCell(null)}>
                <DialogContent className="max-w-[92vw] sm:max-w-4xl border border-border dark:border-white/10 bg-card dark:bg-[#2f3136] rounded-3xl">
                    <DialogHeader>
                        <DialogTitle>
                            {selectedCell ? `${selectedCell.table}.${selectedCell.column}` : "Cell Details"}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="max-h-[70vh] overflow-auto cx-subpanel p-3">
                        <pre className="text-xs whitespace-pre-wrap break-words font-mono">
                            {selectedCell ? formatFullValue(selectedCell.value) : ""}
                        </pre>
                    </div>
                </DialogContent>
            </Dialog>

            <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold tracking-tight">Data Explorer</h2>
                <Button variant="outline" size="sm" className="rounded-full border-border dark:border-white/10" onClick={refresh}>
                    <RefreshCw className="mr-2 h-3.5 w-3.5" />
                    Refresh
                </Button>
            </div>

            <div className="flex flex-1 gap-4 h-full overflow-hidden">
                {/* Sidebar: Core Tables */}
                <Card className="w-56 flex flex-col shrink-0 cx-surface">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Core Tables</CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1 overflow-y-auto p-2">
                        <div className="space-y-1">
                            {CORE_TABLES.map((t) => {
                                const Icon = t.icon
                                const isActive = activeTable === t.name
                                return (
                                    <button
                                        key={t.name}
                                        className={`w-full flex items-center gap-2 px-3 py-2 rounded-full text-sm transition-colors ${isActive
                                            ? 'cx-pill-active font-medium'
                                            : 'text-muted-foreground hover:text-foreground hover:bg-white/8 dark:hover:bg-white/8'
                                            }`}
                                        onClick={() => fetchTableData(t.name)}
                                    >
                                        <Icon className="h-3.5 w-3.5 shrink-0" />
                                        <span className="flex-1 text-left truncate">{t.label}</span>
                                        <span className="text-xs opacity-60">{rowCount[t.name] ?? '–'}</span>
                                        {isActive && <ChevronRight className="h-3 w-3 shrink-0" />}
                                    </button>
                                )
                            })}
                        </div>
                    </CardContent>
                </Card>

                {/* Main: Data Grid & SQL */}
                <div className="flex-1 flex flex-col overflow-hidden">
                    <Tabs defaultValue="browse" className="flex-1 flex flex-col">
                        <div className="flex items-center justify-between shrink-0">
                            <TabsList className="h-10 rounded-full border border-border dark:border-white/10 bg-muted/60 dark:bg-[#2b2d31] p-1 gap-1">
                                <TabsTrigger value="browse" className="rounded-full data-[state=active]:cx-pill-active">Browse Data</TabsTrigger>
                                <TabsTrigger value="sql" className="rounded-full data-[state=active]:cx-pill-active">SQL Editor</TabsTrigger>
                            </TabsList>
                            {activeTable && (
                                <span className="text-xs text-muted-foreground font-mono">
                                    {activeTable} · {tableData.length} row{tableData.length !== 1 ? 's' : ''}
                                </span>
                            )}
                        </div>

                        <TabsContent value="browse" className="flex-1 border border-border dark:border-white/10 rounded-3xl p-0 overflow-auto mt-2 bg-card dark:bg-[#2f3136]">
                            {tableData.length > 0 ? (
                                <div className="overflow-auto h-full">
                                    <Table className="min-w-max">
                                        <TableHeader className="cx-table-header sticky top-0">
                                            <TableRow>
                                                {Object.keys(tableData[0]).map((key) => (
                                                    <TableHead key={key} className="text-[11px] uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                                                        {key}
                                                    </TableHead>
                                                ))}
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {tableData.map((row, i) => (
                                                <TableRow key={i} className="cx-row-hover">
                                                    {Object.entries(row).map(([key, val], j) => (
                                                        <TableCell
                                                            key={j}
                                                            className={`text-xs py-2 ${shouldOpenCellModal(key, val) ? 'cursor-pointer' : ''}`}
                                                            onClick={() => {
                                                                if (!shouldOpenCellModal(key, val)) return;
                                                                setSelectedCell({
                                                                    table: activeTable,
                                                                    column: key,
                                                                    value: val
                                                                });
                                                            }}
                                                        >
                                                            {formatPreviewValue(key, val)}
                                                        </TableCell>
                                                    ))}
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </div>
                            ) : (
                                <div className="p-8 text-center text-muted-foreground">
                                    {error ? error : 'No data yet. Upload and process a PDF to populate tables.'}
                                </div>
                            )}
                        </TabsContent>

                        <TabsContent value="sql" className="flex-1 flex flex-col mt-2">
                            <div className="flex gap-2 mb-3">
                                <Input
                                    placeholder="SELECT * FROM chunks WHERE document_id = '...' LIMIT 20"
                                    value={sqlQuery}
                                    onChange={(e) => setSqlQuery(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && runQuery()}
                                    className="font-mono text-xs cx-input"
                                />
                                <Button onClick={runQuery} size="sm" className="rounded-full">
                                    <Play className="mr-1.5 h-3.5 w-3.5" /> Run
                                </Button>
                            </div>

                            {error && (
                                <div className="p-3 mb-3 bg-destructive/15 text-destructive rounded-2xl font-mono text-xs border border-destructive/30">
                                    {error}
                                </div>
                            )}

                            <div className="flex-1 border border-border dark:border-white/10 rounded-3xl overflow-auto bg-card dark:bg-[#2f3136]">
                                {queryResult.length > 0 ? (
                                    <Table className="min-w-max">
                                        <TableHeader className="cx-table-header sticky top-0">
                                            <TableRow>
                                                {Object.keys(queryResult[0]).map((key) => (
                                                    <TableHead key={key} className="text-[11px] uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                                                        {key}
                                                    </TableHead>
                                                ))}
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {queryResult.map((row, i) => (
                                                <TableRow key={i} className="cx-row-hover">
                                                    {Object.entries(row).map(([key, val], j) => (
                                                        <TableCell
                                                            key={j}
                                                            className={`text-xs py-2 ${shouldOpenCellModal(key, val) ? 'cursor-pointer' : ''}`}
                                                            onClick={() => {
                                                                if (!shouldOpenCellModal(key, val)) return;
                                                                setSelectedCell({
                                                                    table: "query_result",
                                                                    column: key,
                                                                    value: val
                                                                });
                                                            }}
                                                        >
                                                            {formatPreviewValue(key, val)}
                                                        </TableCell>
                                                    ))}
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                ) : (
                                    <div className="p-8 text-center text-muted-foreground text-sm">
                                        Run a query to see results
                                    </div>
                                )}
                            </div>
                        </TabsContent>
                    </Tabs>
                </div>
            </div>
        </div>
    )
}
