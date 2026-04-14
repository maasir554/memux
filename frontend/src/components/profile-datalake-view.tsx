import { useState, useCallback, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FileText, Loader2, Plus, Terminal, RefreshCw, UploadCloud, Search } from 'lucide-react';
import { dbService, type ContextSpace, type ContextSource, type ContextSegment } from '@/services/db-service';
import { personaIngestionService } from '@/services/persona-ingestion-service';
import { pdfStore } from '@/services/pdf-store';
import { extractPdfText } from '@/services/pdf-renderer';
import { useDropzone } from 'react-dropzone';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';

export function ProfileDatalakeView() {
    const [profileSpace, setProfileSpace] = useState<ContextSpace | null>(null);
    const [sources, setSources] = useState<ContextSource[]>([]);
    
    // UI state
    const [isAddTextOpen, setIsAddTextOpen] = useState(false);
    const [textTitle, setTextTitle] = useState("");
    const [textContent, setTextContent] = useState("");
    const [isProcessing, setIsProcessing] = useState(false);
    const [activeTab, setActiveTab] = useState("file");

    // Detail View State
    const [selectedDoc, setSelectedDoc] = useState<ContextSource | null>(null);
    const [docFields, setDocFields] = useState<ContextSegment[]>([]);

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        try {
            const space = await dbService.getPersonalProfileSpace();
            setProfileSpace(space);
            const docs = await dbService.getContextSources([space.id]);
            setSources(docs.filter(d => d.source_type === 'persona'));
        } catch(e) {
            console.error("Failed loading persona space:", e);
        }
    };

    const handleAddText = async () => {
        if (!profileSpace || !textTitle.trim() || !textContent.trim()) return;
        setIsProcessing(true);
        try {
            const createdDoc = await dbService.createContextSource({
                spaceId: profileSpace.id,
                sourceType: 'persona',
                title: textTitle.trim(),
                originalUri: 'text-entry',
                status: 'processing'
            });
            
            await loadData();
            
            // Background process AI explicit extraction using the DB generated ID
            await personaIngestionService.ingestPersonaText(createdDoc.id, textContent.trim());
            
            await loadData();
            setIsAddTextOpen(false);
            setTextTitle("");
            setTextContent("");
        } catch(e) {
            console.error(e);
        } finally {
            setIsProcessing(false);
        }
    };

    const onDrop = useCallback(async (acceptedFiles: File[]) => {
        if (!profileSpace) return;
        setIsProcessing(true);
        try {
            for (const file of acceptedFiles) {
                if (file.name.toLowerCase().endsWith('.pdf') || file.type === "application/pdf") {
                    const createdDoc = await dbService.createContextSource({
                        spaceId: profileSpace.id,
                        sourceType: 'persona',
                        title: file.name,
                        originalUri: 'pdf-upload',
                        status: 'processing'
                    });
                    
                    await pdfStore.savePdf(createdDoc.id, file);
                    
                    // Fire and forget the heavy AI process to allow UI to breathe
                    extractPdfText(file)
                        .then(extractedText => personaIngestionService.ingestPersonaText(createdDoc.id, extractedText, createdDoc.id))
                        .then(() => loadData())
                        .catch(err => {
                            console.error("Async persona extraction failed", err);
                            dbService.updateContextSource(createdDoc.id, { status: 'failed' }).then(() => loadData());
                        });
                }
            }
            
            await loadData();
            setIsAddTextOpen(false);
        } catch(e) {
            console.error("Failed to process dropped PDF:", e);
        } finally {
            setIsProcessing(false);
        }
    }, [profileSpace]);

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
        onDrop,
        accept: { 'application/pdf': ['.pdf'] }
    });

    const handleSelectDoc = async (doc: ContextSource) => {
        setSelectedDoc(doc);
        const { getDb } = await import('@/lib/db');
        const db = getDb();
        const res = await db.query(
            `SELECT * FROM context_segments WHERE source_id = $1 AND segment_type = 'persona_field' ORDER BY created_at ASC`,
            [doc.id]
        );
        const segments = res.rows.map((row: any) => ({
            ...row,
            structured_json: typeof row.structured_json === 'string' ? JSON.parse(row.structured_json) : row.structured_json
        })) as ContextSegment[];
        setDocFields(segments);
    };

    return (
        <div className="flex flex-col h-full space-y-6">
            <div className="flex justify-between items-start">
                <div>
                    <h2 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-pink-500 to-yellow-500 bg-clip-text text-transparent">Autofill Personas</h2>
                    <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
                        A specialized AI data-lake. Any documents or text uploaded here are cleanly parsed into Key-Value mappings by our extraction agent. 
                        Your browser extension seamlessly searches these nodes to automatically fill forms.
                    </p>
                </div>
                {profileSpace && (
                    <Dialog open={isAddTextOpen} onOpenChange={setIsAddTextOpen}>
                        <DialogTrigger asChild>
                            <Button className="bg-gradient-to-r from-pink-500 via-orange-400 to-yellow-500 hover:from-pink-600 hover:to-yellow-600 border-none text-white font-semibold shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all">
                                <Plus className="w-5 h-5 mr-2 stroke-[2.5]"/> Add Persona Data
                            </Button>
                        </DialogTrigger>
                        <DialogContent className="max-w-xl" onInteractOutside={(e) => e.preventDefault()}>
                            <DialogHeader>
                                <DialogTitle className="text-xl font-bold">Add Persona Document</DialogTitle>
                                <DialogDescription>
                                    Add your personal details here to be intelligently indexed by our AI extractor.
                                </DialogDescription>
                            </DialogHeader>
                            <div className="pt-2">
                                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                                    <TabsList className="grid w-full grid-cols-2 mb-4">
                                        <TabsTrigger value="file">Upload PDF Resume</TabsTrigger>
                                        <TabsTrigger value="text">Paste Raw Text</TabsTrigger>
                                    </TabsList>
                                    
                                    <TabsContent value="file" className="mt-0">
                                        <div 
                                            {...getRootProps()}
                                            className={`border-2 border-dashed rounded-xl p-10 text-center transition-all cursor-pointer 
                                                ${isDragActive ? 'border-pink-500 bg-pink-500/10 scale-[1.02]' : 'border-muted-foreground/30 hover:border-pink-500/50 hover:bg-muted/10'}
                                                ${isProcessing ? 'opacity-50 pointer-events-none' : ''}
                                            `}
                                        >
                                            <input {...getInputProps()} />
                                            {isProcessing ? (
                                                <div className="flex flex-col items-center justify-center">
                                                    <Loader2 className="w-12 h-12 text-pink-500 mx-auto mb-4 animate-spin" />
                                                    <h3 className="text-lg font-bold text-pink-500">Processing Document...</h3>
                                                    <p className="text-sm text-pink-500/80 mt-1">Extracting structured keys...</p>
                                                </div>
                                            ) : (
                                                <div className="flex flex-col items-center justify-center">
                                                    <UploadCloud className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                                                    <h3 className="text-lg font-bold">Drag & Drop PDF</h3>
                                                    <p className="text-sm text-muted-foreground mt-1 mb-4">or click to browse your files</p>
                                                    <Button variant="outline" className="pointer-events-none">Browse Files</Button>
                                                </div>
                                            )}
                                        </div>
                                    </TabsContent>

                                    <TabsContent value="text" className="mt-0 space-y-4">
                                        <div>
                                            <label className="text-sm font-semibold">Document Title</label>
                                            <Input value={textTitle} onChange={e => setTextTitle(e.target.value)} placeholder="e.g. Work History & Skills" className="mt-1"/>
                                        </div>
                                        <div>
                                            <label className="text-sm font-semibold">Text Content</label>
                                            <textarea 
                                                value={textContent} 
                                                onChange={e => setTextContent(e.target.value)} 
                                                rows={7} 
                                                placeholder="Paste your unstructured personal details here (e.g., Jane Doe. I live at 123 Main St...)" 
                                                className="mt-1 flex w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-pink-500"
                                            />
                                        </div>
                                        <Button 
                                            onClick={handleAddText} 
                                            disabled={isProcessing || !textTitle.trim() || !textContent.trim()} 
                                            className="w-full bg-gradient-to-r from-pink-500 to-orange-400 hover:from-pink-600 hover:to-orange-500 text-white font-semibold shadow-md"
                                        >
                                            {isProcessing ? <Loader2 className="w-4 h-4 animate-spin mr-2"/> : <Search className="w-4 h-4 mr-2" />}
                                            Extract & Save
                                        </Button>
                                    </TabsContent>
                                </Tabs>
                            </div>
                        </DialogContent>
                    </Dialog>
                )}
            </div>

            <div className={`flex-1 grid gap-5 ${selectedDoc ? 'md:grid-cols-2 lg:grid-cols-3' : 'grid-cols-1'}`}>
                {/* LIST VIEW */}
                <div className={`space-y-4 ${selectedDoc ? 'md:col-span-1 lg:col-span-1' : 'col-span-1 md:w-2/3 mx-auto'}`}>
                    <div className="flex items-center justify-between border-b pb-2">
                        <h3 className="text-lg font-semibold flex items-center gap-2">
                            <FileText className="w-5 h-5 text-pink-500" />
                            Ingested Documents <span className="text-muted-foreground text-sm font-normal">({sources.length})</span>
                        </h3>
                        <Button variant="ghost" size="icon" onClick={loadData} className="h-8 w-8 hover:text-pink-500"><RefreshCw className="w-4 h-4" /></Button>
                    </div>
                    {sources.length === 0 ? (
                        <div className="text-center p-12 border-2 border-dashed rounded-2xl bg-muted/10 flex flex-col items-center justify-center">
                            <FileText className="w-10 h-10 text-muted-foreground/30 mb-4" />
                            <p className="text-muted-foreground font-semibold">No persona documents found.</p>
                            <p className="text-sm text-muted-foreground max-w-sm mt-1">Click "Add Persona Data" to upload your first resume or text block.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 gap-3">
                            {sources.map(doc => (
                                <Card 
                                    key={doc.id} 
                                    className={`cursor-pointer transition-all border-l-4 ${selectedDoc?.id === doc.id ? 'border-l-pink-500 bg-pink-500/5 shadow-md scale-[1.01]' : 'border-l-transparent hover:border-l-pink-400/50 hover:bg-muted/30 shadow-sm'}`}
                                    onClick={() => handleSelectDoc(doc)}
                                >
                                    <CardContent className="p-4 flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className={`p-2 rounded-xl flex items-center justify-center ${doc.status === 'indexed' ? 'bg-gradient-to-br from-pink-500/10 to-orange-500/10 text-pink-600' : 'bg-orange-500/10 text-orange-500'}`}>
                                                {doc.status === 'indexed' ? <FileText className="w-5 h-5" /> : <Loader2 className="w-5 h-5 animate-spin" />}
                                            </div>
                                            <div>
                                                <p className="font-semibold text-[15px]">{doc.title}</p>
                                                <div className="flex items-center gap-2 mt-0.5">
                                                    <span className="relative flex h-2 w-2">
                                                      <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${doc.status === 'indexed' ? 'bg-pink-400' : 'bg-orange-400'}`}></span>
                                                      <span className={`relative inline-flex rounded-full h-2 w-2 ${doc.status === 'indexed' ? 'bg-pink-500' : 'bg-orange-500'}`}></span>
                                                    </span>
                                                    <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">{doc.status}</p>
                                                </div>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    )}
                </div>

                {/* DETAIL SPLIT VIEW */}
                {selectedDoc && (
                    <Card className="border-pink-500/20 bg-muted/5 flex flex-col h-[calc(100vh-160px)] md:col-span-1 lg:col-span-2 shadow-xl shadow-pink-500/5 items-stretch relative overflow-hidden">
                        {/* Decorative background gradient flare */}
                        <div className="absolute top-0 right-0 -mr-20 -mt-20 w-64 h-64 bg-pink-500/10 blur-[80px] rounded-full pointer-events-none" />
                        <div className="absolute bottom-0 left-0 -ml-20 -mb-20 w-64 h-64 bg-yellow-500/10 blur-[80px] rounded-full pointer-events-none" />

                        <CardHeader className="border-b bg-background/50 backdrop-blur-md relative z-10 py-5">
                            <CardTitle className="text-xl font-bold flex items-center gap-2 text-foreground">
                                {selectedDoc.title}
                            </CardTitle>
                            <CardDescription className="text-sm font-medium text-pink-600/80 dark:text-pink-400 flex items-center gap-1.5 mt-1">
                                <Terminal className="w-3.5 h-3.5" /> AI Extracted Structured Data
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="p-0 flex-1 overflow-hidden relative z-10 bg-background/80">
                            <ScrollArea className="h-full p-5">
                                {docFields.length === 0 && selectedDoc.status === 'indexed' && (
                                    <div className="text-center p-12 text-muted-foreground font-medium">No structured keys could be extracted successfully.</div>
                                )}
                                {docFields.length === 0 && selectedDoc.status !== 'indexed' && (
                                    <div className="flex flex-col items-center justify-center p-20 text-muted-foreground">
                                        <Loader2 className="w-8 h-8 animate-spin text-pink-500 mb-4" /> 
                                        <p className="font-semibold text-foreground">Extraction Engine Active...</p>
                                        <p className="text-sm mt-1">Locating entities and relationships</p>
                                    </div>
                                )}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {docFields.map(field => {
                                        const payload = field.structured_json || {};
                                        return (
                                            <div key={field.id} className="group border border-border/60 hover:border-pink-500/30 bg-background/50 backdrop-blur-sm rounded-xl p-4 shadow-sm hover:shadow-md transition-all">
                                                <div className="flex justify-between items-start mb-2.5 border-b border-border/40 pb-2">
                                                    <div className="font-bold text-pink-600 dark:text-pink-400 font-mono text-sm tracking-tight flex items-center gap-1.5">
                                                        <span className="text-muted-foreground/50">#</span> {payload.key}
                                                    </div>
                                                </div>
                                                <div className="text-[14px] leading-relaxed break-words text-foreground font-medium bg-muted/40 px-3 py-2.5 rounded-lg border border-border/30">
                                                    {payload.value}
                                                </div>
                                                <div className="mt-3.5 flex gap-1.5 flex-wrap">
                                                    {Array.isArray(payload.keywords) && payload.keywords.map((kw: string, i: number) => (
                                                        <span key={i} className="text-[10px] uppercase font-bold tracking-wider bg-pink-500/10 text-pink-700 dark:text-pink-300 px-2 py-0.5 rounded-full border border-pink-500/20 shadow-sm transition-colors group-hover:bg-pink-500/20 cursor-default">
                                                            {kw}
                                                        </span>
                                                    ))}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </ScrollArea>
                        </CardContent>
                    </Card>
                )}
            </div>
        </div>
    );
}

