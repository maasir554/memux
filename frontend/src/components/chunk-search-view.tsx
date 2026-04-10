import { useState, useCallback, useRef, useEffect } from 'react'
import { Search, X, ChevronRight, FileText, Image, Tag, Hash, AlertCircle, Loader2, BookOpen, Zap, Filter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiService } from '@/services/api-service'
import { dbService } from '@/services/db-service'
import type { RetrievedContextItem } from '@/services/db-service'
import { pdfStore } from '@/services/pdf-store'

/* ─── Types ──────────────────────────────────────────────────────── */
interface ChunkResult extends RetrievedContextItem {
  imageDataUrl?: string | null
}

/* ─── Helpers ────────────────────────────────────────────────────── */
const channelLabel = (ch: string | null) =>
  ch === 'ocr' ? 'Vision' : ch === 'html' ? 'HTML' : ch || 'Unknown'

const channelColor = (ch: string | null) =>
  ch === 'ocr'
    ? 'bg-violet-500/15 text-violet-400 border-violet-500/20'
    : ch === 'html'
    ? 'bg-blue-500/15 text-blue-400 border-blue-500/20'
    : 'bg-slate-500/15 text-slate-400 border-slate-500/20'

const scoreBar = (score: number) => {
  const pct = Math.max(0, Math.min(100, Math.round(score * 100)))
  const color =
    pct >= 80 ? '#10b981' : pct >= 60 ? '#f59e0b' : pct >= 40 ? '#f97316' : '#ef4444'
  return { pct, color }
}

/* ─── Detail Modal ───────────────────────────────────────────────── */
function ChunkDetailModal({
  chunk,
  onClose,
}: {
  chunk: ChunkResult
  onClose: () => void
}) {
  const structured = chunk.structured_payload as Record<string, any> | null
  const heading = structured?.heading || ''
  const summary = structured?.summary || chunk.text_summary || ''
  const rawText = structured?.raw_text || chunk.raw_text || ''
  const channel = structured?.channel || null
  const heading2 = structured?.inherited_heading || heading
  const contextPrefix: string[] = structured?.context_prefix || []
  const score = scoreBar(chunk.similarity_score || 0)

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-[#1e2027] border border-white/10 shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[#1e2027]/95 backdrop-blur border-b border-white/8 px-6 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <BookOpen className="h-4 w-4 text-violet-400 shrink-0" />
            <span className="text-sm font-semibold text-white truncate">{heading || 'Chunk Detail'}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/8 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Meta row */}
          <div className="flex flex-wrap gap-2">
            {channel && (
              <span className={`text-xs px-2.5 py-1 rounded-full border font-medium ${channelColor(channel)}`}>
                {channelLabel(channel)}
              </span>
            )}
            <span className="text-xs px-2.5 py-1 rounded-full border bg-slate-500/10 border-slate-500/20 text-slate-400 font-medium">
              {chunk.segment_type}
            </span>
            {chunk.title && (
              <span className="text-xs px-2.5 py-1 rounded-full border bg-indigo-500/10 border-indigo-500/20 text-indigo-400 font-medium truncate max-w-[200px]" title={chunk.title}>
                {chunk.title}
              </span>
            )}
            {/* Similarity score */}
            <span className="ml-auto text-xs px-2.5 py-1 rounded-full bg-black/30 text-white/60 font-mono tabular-nums">
              {score.pct}% match
            </span>
          </div>

          {/* Context prefix breadcrumb */}
          {contextPrefix.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <Tag className="h-3.5 w-3.5 text-white/30" />
              {contextPrefix.map((p, i) => (
                <span key={i} className="text-xs text-white/50">
                  {p}{i < contextPrefix.length - 1 ? <span className="mx-1 text-white/20">/</span> : ''}
                </span>
              ))}
            </div>
          )}

          {/* Inherited heading note */}
          {heading2 && heading2 !== heading && (
            <div className="text-xs text-amber-400/80 bg-amber-500/8 border border-amber-500/15 rounded-lg px-3 py-2">
              ↪ Continuation from: <strong>{heading2}</strong>
            </div>
          )}

          {/* Summary */}
          {summary && (
            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wider text-white/30 font-semibold">Summary</p>
              <p className="text-sm text-white/80 leading-relaxed">{summary}</p>
            </div>
          )}

          {/* Raw text */}
          {rawText && (
            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wider text-white/30 font-semibold">Extracted Text</p>
              <pre className="text-sm text-white/70 bg-black/30 border border-white/8 rounded-xl p-4 whitespace-pre-wrap font-mono leading-relaxed overflow-x-auto">
                {rawText}
              </pre>
            </div>
          )}

          {/* Screenshot image */}
          {chunk.imageDataUrl && (
            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wider text-white/30 font-semibold flex items-center gap-1.5">
                <Image className="h-3.5 w-3.5" />
                Source Screenshot
              </p>
              <div className="rounded-xl overflow-hidden border border-white/8 bg-black/30">
                <img
                  src={chunk.imageDataUrl}
                  alt="Source screenshot"
                  className="w-full object-contain max-h-[400px]"
                />
              </div>
            </div>
          )}

          {/* Locator */}
          {chunk.citation_payload && (
            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wider text-white/30 font-semibold">Locator</p>
              <div className="text-xs text-white/40 bg-black/20 rounded-xl p-3 font-mono space-y-1">
                {chunk.citation_payload.canonical_uri && (
                  <div><span className="text-white/25">url </span>{chunk.citation_payload.canonical_uri}</div>
                )}
                {chunk.citation_payload.paragraph_id && (
                  <div><span className="text-white/25">id  </span>{chunk.citation_payload.paragraph_id}</div>
                )}
                {chunk.citation_payload.asset_id && (
                  <div><span className="text-white/25">asset </span>{chunk.citation_payload.asset_id}</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ─── Result Card ────────────────────────────────────────────────── */
function ChunkCard({
  chunk,
  query,
  onClick,
}: {
  chunk: ChunkResult
  query: string
  onClick: () => void
}) {
  const structured = chunk.structured_payload as Record<string, any> | null
  const heading = structured?.heading || chunk.location_label || 'Untitled'
  const summary = structured?.summary || chunk.text_summary || ''
  const channel = structured?.channel || null
  const score = scoreBar(chunk.similarity_score || 0)

  const highlightText = (text: string, q: string) => {
    if (!q.trim() || !text) return text
    const words = q.trim().split(/\s+/).filter(w => w.length > 2)
    if (words.length === 0) return text
    const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
    return parts.map((part, i) =>
      i % 2 === 1
        ? <mark key={i} className="bg-violet-500/30 text-violet-200 rounded px-0.5">{part}</mark>
        : part
    )
  }

  return (
    <button
      onClick={onClick}
      className="w-full text-left group relative rounded-xl border border-white/8 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/15 transition-all duration-200 overflow-hidden"
    >
      {/* Score sidebar */}
      <div
        className="absolute left-0 top-0 bottom-0 w-0.5 rounded-l-xl"
        style={{ backgroundColor: score.color, opacity: 0.7 }}
      />

      <div className="pl-4 pr-4 py-4 flex flex-col gap-2">
        {/* Top row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              {channel && (
                <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${channelColor(channel)}`}>
                  {channelLabel(channel)}
                </span>
              )}
              {chunk.title && (
                <span className="text-[10px] text-white/30 truncate max-w-[160px]">{chunk.title}</span>
              )}
            </div>
            <p className="text-sm font-semibold text-white/90 leading-snug line-clamp-1">{heading}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-mono text-white/35 tabular-nums">{score.pct}%</span>
            {chunk.imageDataUrl && <Image className="h-3.5 w-3.5 text-violet-400/60" />}
            <ChevronRight className="h-3.5 w-3.5 text-white/20 group-hover:text-white/50 transition-colors" />
          </div>
        </div>

        {/* Summary preview */}
        {summary && (
          <p className="text-xs text-white/55 leading-relaxed line-clamp-2">
            {highlightText(summary, query)}
          </p>
        )}
      </div>
    </button>
  )
}

/* ─── Main View ──────────────────────────────────────────────────── */
export default function ChunkSearchView() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ChunkResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedChunk, setSelectedChunk] = useState<ChunkResult | null>(null)
  const [filterChannel, setFilterChannel] = useState<string>('all')
  const [loadingImageId, setLoadingImageId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const loadImageForChunk = useCallback(async (chunk: RetrievedContextItem): Promise<string | null> => {
    const assetId = chunk.citation_payload?.asset_id
    if (!assetId) return null
    try {
      const blob = await pdfStore.getAsset(assetId)
      if (!blob) return null
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })
    } catch {
      return null
    }
  }, [])

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) return
    setIsSearching(true)
    setError(null)
    setHasSearched(true)

    try {
      // Get embedding for query
      const embeddings = await apiService.generateEmbeddings([q])
      const queryEmbedding = embeddings?.[0]
      if (!queryEmbedding) throw new Error('Embedding generation failed')

      // Get all space IDs
      const spaces = await dbService.getContextSpaces()
      const spaceIds = spaces.map(s => s.id)

      // Vector search
      const vectorResults = await dbService.getTopContextSegmentsByEmbeddingAcrossSpaces({
        queryEmbedding,
        spaceIds,
        limit: 30,
      })

      // Lexical fallback — merge
      const lexicalResults = await dbService.getTopContextSegmentsByLexicalAcrossSpaces({
        queryText: q,
        spaceIds,
        limit: 20,
      })

      // Dedupe by id, merge with vector results
      const seen = new Set<string>()
      const merged: RetrievedContextItem[] = []
      for (const r of vectorResults) {
        if (!seen.has(r.id)) { seen.add(r.id); merged.push(r) }
      }
      for (const r of lexicalResults) {
        if (!seen.has(r.id)) { seen.add(r.id); merged.push({ ...r, similarity_score: r.similarity_score * 0.85 }) }
      }
      merged.sort((a, b) => (b.similarity_score || 0) - (a.similarity_score || 0))

      // Enrich with images — eager load for top 8
      const enriched: ChunkResult[] = merged.map(r => ({ ...r, imageDataUrl: undefined }))
      setResults(enriched)

      // Load images for top results lazily
      ;(async () => {
        for (let i = 0; i < Math.min(8, enriched.length); i++) {
          const img = await loadImageForChunk(enriched[i])
          setResults(prev => prev.map((c, idx) => idx === i ? { ...c, imageDataUrl: img } : c))
        }
      })()
    } catch (e: any) {
      setError(e.message || 'Search failed')
    } finally {
      setIsSearching(false)
    }
  }, [loadImageForChunk])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') doSearch(query)
  }

  const openChunk = useCallback(async (chunk: ChunkResult) => {
    setSelectedChunk(chunk)
    // Load image if not yet loaded
    if (chunk.imageDataUrl === undefined) {
      setLoadingImageId(chunk.id)
      const img = await loadImageForChunk(chunk)
      setSelectedChunk(prev => prev?.id === chunk.id ? { ...prev, imageDataUrl: img } : prev)
      setLoadingImageId(null)
    }
  }, [loadImageForChunk])

  const filteredResults = filterChannel === 'all'
    ? results
    : results.filter(r => {
        const ch = (r.structured_payload as any)?.channel || null
        return filterChannel === 'vision' ? ch === 'ocr' : ch === 'html'
      })

  const channels = Array.from(new Set(results.map(r => (r.structured_payload as any)?.channel || 'unknown')))

  return (
    <div className="h-full flex flex-col bg-[#16181c] text-white">
      {/* Header */}
      <div className="shrink-0 px-6 pt-6 pb-4 border-b border-white/8">
        <div className="flex items-center gap-3 mb-1">
          <div className="h-7 w-7 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shrink-0">
            <Search className="h-3.5 w-3.5 text-white" />
          </div>
          <h1 className="text-lg font-bold tracking-tight">Chunk Search</h1>
        </div>
        <p className="text-sm text-white/40 ml-10">
          Semantic + lexical search across all stored context segments
        </p>
      </div>

      {/* Search Bar */}
      <div className="shrink-0 px-6 py-4 border-b border-white/8">
        <div className="relative flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-white/30" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search chunks by meaning or exact text…"
              className="w-full h-11 pl-10 pr-10 rounded-xl bg-white/[0.05] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/40 transition-all"
            />
            {query && (
              <button
                onClick={() => { setQuery(''); setResults([]); setHasSearched(false) }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <Button
            onClick={() => doSearch(query)}
            disabled={!query.trim() || isSearching}
            className="h-11 px-5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white border-0 font-medium"
          >
            {isSearching
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <><Zap className="h-4 w-4 mr-1.5" />Search</>
            }
          </Button>
        </div>

        {/* Filter pills */}
        {hasSearched && channels.length > 1 && (
          <div className="mt-3 flex items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-white/30" />
            {['all', ...channels].map(ch => (
              <button
                key={ch}
                onClick={() => setFilterChannel(ch)}
                className={`text-xs px-3 py-1 rounded-full border font-medium transition-colors ${
                  filterChannel === ch
                    ? 'bg-violet-600 border-violet-500 text-white'
                    : 'bg-white/[0.03] border-white/10 text-white/50 hover:text-white/70 hover:border-white/20'
                }`}
              >
                {ch === 'all' ? `All (${results.length})` : ch === 'ocr' ? `Vision (${results.filter(r => (r.structured_payload as any)?.channel === 'ocr').length})` : `HTML (${results.filter(r => (r.structured_payload as any)?.channel === 'html').length})`}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {error && (
          <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {!hasSearched && !error && (
          <div className="flex flex-col items-center justify-center h-64 gap-4 text-white/20">
            <div className="h-16 w-16 rounded-2xl bg-white/[0.03] border border-white/8 flex items-center justify-center">
              <Search className="h-7 w-7" />
            </div>
            <div className="text-center space-y-1">
              <p className="text-sm font-medium text-white/30">Search your knowledge base</p>
              <p className="text-xs text-white/20">Type a query and press Enter or click Search</p>
            </div>
          </div>
        )}

        {hasSearched && !isSearching && filteredResults.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center h-48 gap-3 text-white/20">
            <FileText className="h-10 w-10" />
            <div className="text-center">
              <p className="text-sm font-medium text-white/30">No chunks found</p>
              <p className="text-xs text-white/20">Try different search terms</p>
            </div>
          </div>
        )}

        {filteredResults.length > 0 && (
          <>
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs text-white/30">
                <span className="font-semibold text-white/50">{filteredResults.length}</span> chunks found
              </p>
              <div className="flex items-center gap-1 text-[10px] text-white/25">
                <Hash className="h-3 w-3" />
                sorted by relevance
              </div>
            </div>
            <div className="space-y-2">
              {filteredResults.map(chunk => (
                <ChunkCard
                  key={chunk.id}
                  chunk={chunk}
                  query={query}
                  onClick={() => openChunk(chunk)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Detail Modal */}
      {selectedChunk && (
        <ChunkDetailModal
          chunk={loadingImageId === selectedChunk.id
            ? selectedChunk
            : selectedChunk}
          onClose={() => setSelectedChunk(null)}
        />
      )}
    </div>
  )
}
