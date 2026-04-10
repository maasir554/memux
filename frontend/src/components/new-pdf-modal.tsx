import { useEffect, useRef, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { UploadCloud, Link as LinkIcon, Loader2, FilePlus, Image as ImageIcon, BookmarkPlus, FolderOpen, MonitorUp, ChevronDown } from 'lucide-react'
import { useExtractionStore } from '@/store/extraction-store'
import { dbService, type ContextSpace } from '@/services/db-service'
import { memuxExtensionBridge } from '@/services/memux-extension-bridge'

interface BookmarkCaptureJob {
    id: string;
    label: string;
    status: "processing" | "completed" | "error";
    message: string;
}

export function NewPdfModal({ collapsed = false }: { collapsed?: boolean }) {
    const [isOpen, setIsOpen] = useState(false)
    const [url, setUrl] = useState("")
    const [customName, setCustomName] = useState("")
    const [urlLoading, setUrlLoading] = useState(false)
    const [bookmarkUrl, setBookmarkUrl] = useState("")
    const [bookmarkLoading, setBookmarkLoading] = useState(false)
    const [isBookmarkCaptureStudioOpen, setIsBookmarkCaptureStudioOpen] = useState(false)
    const [bookmarkCaptureFiles, setBookmarkCaptureFiles] = useState<File[]>([])
    const [bookmarkCaptureJobs, setBookmarkCaptureJobs] = useState<BookmarkCaptureJob[]>([])
    const [isBookmarkDropActive, setIsBookmarkDropActive] = useState(false)
    const [isBookmarkScreenShareActive, setIsBookmarkScreenShareActive] = useState(false)
    const [bookmarkScreenCaptureCount, setBookmarkScreenCaptureCount] = useState(0)
    const [isBookmarkCapturingFrame, setIsBookmarkCapturingFrame] = useState(false)
    const [isBookmarkAutoCapturing, setIsBookmarkAutoCapturing] = useState(false)
    const [bookmarkAutoCaptureMaxShots, setBookmarkAutoCaptureMaxShots] = useState("18")
    const [snipLoading, setSnipLoading] = useState(false)
    const [screenCaptureLoading, setScreenCaptureLoading] = useState(false)
    const [spaces, setSpaces] = useState<ContextSpace[]>([])
    const [selectedSpaceId, setSelectedSpaceId] = useState<string>("")

    const addJob = useExtractionStore((state) => state.addJob)
    const addJobFromUrl = useExtractionStore((state) => state.addJobFromUrl)
    const addScreenSnipToContext = useExtractionStore((state) => state.addScreenSnipToContext)
    const addBookmarkToContext = useExtractionStore((state) => state.addBookmarkToContext)
    const bookmarkCaptureFileInputRef = useRef<HTMLInputElement | null>(null)
    const bookmarkScreenVideoRef = useRef<HTMLVideoElement | null>(null)
    const bookmarkScreenStreamRef = useRef<MediaStream | null>(null)

    useEffect(() => {
        if (!isOpen) return
        (async () => {
            await dbService.getDefaultContextSpace();
            const allSpaces = await dbService.getContextSpaces();
            setSpaces(allSpaces);
            if (allSpaces.length > 0 && !selectedSpaceId) {
                setSelectedSpaceId(allSpaces[0].id);
            }
        })();
    }, [isOpen, selectedSpaceId]);

    const stopBookmarkScreenShareSession = () => {
        const stream = bookmarkScreenStreamRef.current;
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }
        bookmarkScreenStreamRef.current = null;
        const video = bookmarkScreenVideoRef.current;
        if (video) {
            video.pause();
            (video as any).srcObject = null;
        }
        setIsBookmarkScreenShareActive(false);
        setIsBookmarkCapturingFrame(false);
        setIsBookmarkAutoCapturing(false);
    };

    useEffect(() => {
        if (isBookmarkCaptureStudioOpen) return;
        stopBookmarkScreenShareSession();
    }, [isBookmarkCaptureStudioOpen]);

    useEffect(() => {
        if (isOpen) return;
        stopBookmarkScreenShareSession();
        setBookmarkCaptureFiles([]);
        setBookmarkCaptureJobs([]);
        setBookmarkAutoCaptureMaxShots("18");
        setBookmarkScreenCaptureCount(0);
    }, [isOpen]);

    useEffect(() => {
        if (!isBookmarkScreenShareActive || !isBookmarkCaptureStudioOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.repeat || isBookmarkAutoCapturing) return;
            const target = event.target as HTMLElement | null;
            const tagName = target?.tagName?.toLowerCase() || "";
            if (tagName === "input" || tagName === "textarea") return;
            if (event.key.toLowerCase() === "c") {
                event.preventDefault();
                handleBookmarkCaptureFromActiveSession();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [isBookmarkScreenShareActive, isBookmarkCaptureStudioOpen, isBookmarkAutoCapturing, bookmarkScreenCaptureCount]);

    const pushBookmarkCaptureJob = (job: BookmarkCaptureJob) => {
        setBookmarkCaptureJobs(prev => [job, ...prev].slice(0, 10));
    };

    const upsertBookmarkCaptureJob = (id: string, updates: Partial<BookmarkCaptureJob>) => {
        setBookmarkCaptureJobs(prev => prev.map(job => job.id === id ? { ...job, ...updates } : job));
    };

    const addBookmarkCaptureBlob = (blob: Blob, name: string) => {
        const file = new File([blob], name, { type: blob.type || "image/png" });
        setBookmarkCaptureFiles(prev => [...prev, file]);
    };

    const captureBookmarkFrame = async (): Promise<Blob> => {
        const video = bookmarkScreenVideoRef.current;
        if (!video || video.readyState < 2) {
            throw new Error("Stream preview not ready for capture yet.");
        }
        const width = video.videoWidth || 1920;
        const height = video.videoHeight || 1080;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Unable to capture screen frame.");
        ctx.drawImage(video, 0, 0, width, height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png", 0.95));
        if (!blob) throw new Error("Failed to encode screenshot.");
        return blob;
    };

    const handleBookmarkCaptureUpload = (fileList: FileList | null) => {
        if (!fileList) return;
        const files = Array.from(fileList).filter(file => file.type.startsWith("image/"));
        if (files.length === 0) return;
        setBookmarkCaptureFiles(prev => [...prev, ...files]);
    };

    const detectBookmarkUrlFromExtension = async (): Promise<string | null> => {
        try {
            await memuxExtensionBridge.ping();
            const state = await memuxExtensionBridge.getScrollState({});
            const detectedUrl = String(state.state.url || "").trim();
            if (!detectedUrl) {
                throw new Error("No URL found from active webpage tab.");
            }

            const parsed = new URL(detectedUrl);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                throw new Error("Detected URL is not a supported web page link.");
            }

            setBookmarkUrl((prev) => prev.trim() ? prev : detectedUrl);
            pushBookmarkCaptureJob({
                id: `bookmark-detect-${Date.now()}`,
                label: "Detect Website URL",
                status: "completed",
                message: `Detected: ${detectedUrl}`
            });
            return detectedUrl;
        } catch (err: any) {
            pushBookmarkCaptureJob({
                id: `bookmark-detect-${Date.now()}`,
                label: "Detect Website URL",
                status: "error",
                message: err?.message || "Could not detect URL from shared/active tab."
            });
            return null;
        }
    };

    const handleBookmarkStartScreenShareSession = async () => {
        if (isBookmarkScreenShareActive || isBookmarkAutoCapturing) return;
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { ideal: 5, max: 10 } },
                audio: false
            });
            bookmarkScreenStreamRef.current = stream;
            const video = bookmarkScreenVideoRef.current;
            if (!video) throw new Error("Preview video is not available.");
            (video as any).srcObject = stream;
            video.muted = true;
            video.playsInline = true;
            await video.play();
            const primaryTrack = stream.getVideoTracks()[0];
            if (primaryTrack) {
                primaryTrack.onended = () => stopBookmarkScreenShareSession();
            }
            setIsBookmarkScreenShareActive(true);
            setBookmarkScreenCaptureCount(0);

            // Best effort: auto-fill bookmark URL from extension-controlled webpage tab.
            await detectBookmarkUrlFromExtension();
        } catch (err: any) {
            pushBookmarkCaptureJob({
                id: `bookmark-capture-failed-${Date.now()}`,
                label: "Screen Share Session",
                status: "error",
                message: err?.message || "Screen share session failed to start."
            });
            stopBookmarkScreenShareSession();
        }
    };

    const handleBookmarkCaptureFromActiveSession = async () => {
        if (!isBookmarkScreenShareActive || isBookmarkCapturingFrame || isBookmarkAutoCapturing) return;
        setIsBookmarkCapturingFrame(true);
        try {
            const blob = await captureBookmarkFrame();
            const nextCount = bookmarkScreenCaptureCount + 1;
            setBookmarkScreenCaptureCount(nextCount);
            addBookmarkCaptureBlob(
                blob,
                `bookmark-screen-shot-${String(nextCount).padStart(2, "0")}-${new Date().toISOString().replaceAll(":", "-")}.png`
            );
        } catch (err: any) {
            pushBookmarkCaptureJob({
                id: `bookmark-capture-failed-${Date.now()}`,
                label: "Screen Share Capture",
                status: "error",
                message: err?.message || "Failed to capture frame."
            });
        } finally {
            setIsBookmarkCapturingFrame(false);
        }
    };

    const handleBookmarkAutoCaptureFromSharedPage = async () => {
        let activeBookmarkUrl = bookmarkUrl.trim();
        if (!activeBookmarkUrl) {
            const detected = await detectBookmarkUrlFromExtension();
            activeBookmarkUrl = String(detected || "").trim();
        }
        if (!activeBookmarkUrl) {
            pushBookmarkCaptureJob({
                id: `bookmark-auto-failed-${Date.now()}`,
                label: "Auto Capture Page",
                status: "error",
                message: "Enter bookmark URL (or detect it) first so MEMUX knows which tab to control."
            });
            return;
        }
        if (!isBookmarkScreenShareActive) {
            pushBookmarkCaptureJob({
                id: `bookmark-auto-failed-${Date.now()}`,
                label: "Auto Capture Page",
                status: "error",
                message: "Start Screen Share first and share the same webpage tab."
            });
            return;
        }
        if (isBookmarkCapturingFrame || isBookmarkAutoCapturing) return;

        const jobId = `bookmark-auto-${Date.now()}`;
        pushBookmarkCaptureJob({
            id: jobId,
            label: "Auto Capture Page",
            status: "processing",
            message: "Connecting to extension..."
        });
        setIsBookmarkAutoCapturing(true);
        setIsBookmarkCapturingFrame(true);
        try {
            await memuxExtensionBridge.ping();
            const initial = await memuxExtensionBridge.getScrollState({
                url: activeBookmarkUrl,
                openIfMissing: false
            });
            const viewportHeight = Math.max(320, Number(initial.state.viewportHeight || 0));
            const stepPx = Math.max(280, Math.floor(viewportHeight * 0.88));
            const estimatedShots = Math.max(1, Math.ceil(Number(initial.state.maxScrollY || 0) / stepPx) + 1);
            const requestedMaxShots = Math.floor(Number(bookmarkAutoCaptureMaxShots || "18"));
            const maxShots = Number.isFinite(requestedMaxShots)
                ? Math.max(1, Math.min(120, requestedMaxShots))
                : 18;
            const totalShots = Math.min(maxShots, estimatedShots);
            const capped = estimatedShots > maxShots;

            for (let i = 0; i < totalShots; i += 1) {
                const y = Math.min(Number(initial.state.maxScrollY || 0), i * stepPx);
                upsertBookmarkCaptureJob(jobId, { message: `Capturing step ${i + 1}/${totalShots}...` });
                await memuxExtensionBridge.scrollTo({ tabId: initial.tabId, y });
                await new Promise(resolve => window.setTimeout(resolve, 420));
                const blob = await captureBookmarkFrame();
                setBookmarkScreenCaptureCount(prev => prev + 1);
                addBookmarkCaptureBlob(
                    blob,
                    `bookmark-auto-shot-${String(i + 1).padStart(2, "0")}-${new Date().toISOString().replaceAll(":", "-")}.png`
                );
            }

            upsertBookmarkCaptureJob(jobId, {
                status: "completed",
                message: capped
                    ? `Captured ${totalShots} screenshots (max reached).`
                    : `Captured ${totalShots} screenshots.`
            });
        } catch (err: any) {
            upsertBookmarkCaptureJob(jobId, {
                status: "error",
                message: err?.message || "Auto capture failed."
            });
        } finally {
            setIsBookmarkCapturingFrame(false);
            setIsBookmarkAutoCapturing(false);
        }
    };

    const onPdfDrop = async (acceptedFiles: File[]) => {
        for (const file of acceptedFiles) {
            try {
                await addJob(file);
                setIsOpen(false);
            } catch (e) {
                console.error("Failed to add document job", e);
            }
        }
    }

    const onSnipDrop = async (acceptedFiles: File[]) => {
        if (acceptedFiles.length === 0) return;
        setSnipLoading(true);
        try {
            const file = acceptedFiles[0];
            await addScreenSnipToContext(file, selectedSpaceId || undefined, file.name);
            setIsOpen(false);
        } catch (e) {
            console.error("Failed to add screen snip", e);
        } finally {
            setSnipLoading(false);
        }
    }

    const captureScreenSnip = async () => {
        if (!navigator.mediaDevices?.getDisplayMedia) {
            alert("Screen capture is not supported in this browser.");
            return;
        }

        let stream: MediaStream | null = null;
        setScreenCaptureLoading(true);
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: 1 },
                audio: false
            });
            const track = stream.getVideoTracks()[0];
            if (!track) {
                throw new Error("No screen video track available.");
            }

            const captureFrameWithVideo = async () => {
                const video = document.createElement("video");
                video.muted = true;
                video.playsInline = true;
                await new Promise<void>((resolve, reject) => {
                    video.onloadedmetadata = () => resolve();
                    video.onerror = () => reject(new Error("Failed to load screen stream."));
                    video.srcObject = stream;
                });
                await video.play();
                await new Promise(resolve => setTimeout(resolve, 250));
                const width = video.videoWidth || 1920;
                const height = video.videoHeight || 1080;
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext("2d");
                if (!ctx) throw new Error("Unable to capture screen frame.");
                ctx.drawImage(video, 0, 0, width, height);
                video.pause();
                video.srcObject = null;
                return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
            };

            const blob = await captureFrameWithVideo();
            if (!blob) {
                throw new Error("Failed to encode screenshot.");
            }

            const file = new File([blob], `screen-snip-${Date.now()}.png`, { type: "image/png" });
            await addScreenSnipToContext(file, selectedSpaceId || undefined, file.name);
            setIsOpen(false);
        } catch (e) {
            console.error("Failed to capture screen snip", e);
        } finally {
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
            }
            setScreenCaptureLoading(false);
        }
    }

    const pdfDropzone = useDropzone({
        onDrop: onPdfDrop,
        accept: { 'application/pdf': ['.pdf'] }
    });

    const snipDropzone = useDropzone({
        onDrop: onSnipDrop,
        accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp'] },
        multiple: false
    });

    const handleUrlUpload = async () => {
        if (!url.trim()) return;
        setUrlLoading(true);
        try {
            await addJobFromUrl(url, customName.trim() || undefined);
            setUrl("");
            setCustomName("");
            setIsOpen(false);
        } catch (e) {
            console.error("Failed to add document from URL", e);
        } finally {
            setUrlLoading(false);
        }
    }

    const handleBookmarkCapture = async () => {
        if (!bookmarkUrl.trim()) return;
        setBookmarkLoading(true);
        try {
            await addBookmarkToContext(bookmarkUrl, selectedSpaceId || undefined, bookmarkCaptureFiles);
            setBookmarkUrl("");
            setBookmarkCaptureFiles([]);
            setBookmarkCaptureJobs([]);
            setIsBookmarkCaptureStudioOpen(false);
            setIsOpen(false);
        } catch (e) {
            console.error("Failed to capture bookmark", e);
        } finally {
            setBookmarkLoading(false);
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
                {collapsed ? (
                    <Button size="icon" variant="ghost" className="w-9 h-9" title="Add Context">
                        <FilePlus className="h-4 w-4" />
                    </Button>
                ) : (
                    <Button className="w-full h-12 rounded-full gap-2 font-bold text-base leading-none bg-[#d5d8df] text-[#182033] hover:bg-[#e2e5ec]">
                        <FilePlus className="h-4 w-4" />
                        Add to Context
                    </Button>
                )}
            </DialogTrigger>
            <DialogContent className="sm:max-w-[620px] border border-border dark:border-white/10 bg-card dark:bg-[#2f3136] rounded-3xl">
                <DialogHeader>
                    <DialogTitle>Add to Context Space</DialogTitle>
                </DialogHeader>

                <div className="space-y-2">
                    <label className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground flex items-center gap-1.5">
                        <FolderOpen className="h-3.5 w-3.5" />
                        Context Space
                    </label>
                    <div className="relative">
                        <select
                            value={selectedSpaceId}
                            onChange={(e) => setSelectedSpaceId(e.target.value)}
                            className="w-full h-10 cx-input appearance-none pl-4 pr-10 text-sm font-medium"
                        >
                            {spaces.map((space) => (
                                <option key={space.id} value={space.id}>{space.name}</option>
                            ))}
                        </select>
                        <ChevronDown className="h-4 w-4 text-muted-foreground pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" />
                    </div>
                </div>

                <Tabs defaultValue="pdf" className="w-full">
                    <TabsList className="grid w-full grid-cols-3 h-10 rounded-full border border-border dark:border-white/10 bg-muted/60 dark:bg-[#2b2d31] p-1 gap-1">
                        <TabsTrigger value="pdf" className="rounded-full text-xs font-medium data-[state=active]:cx-pill-active">PDF</TabsTrigger>
                        <TabsTrigger value="bookmark" className="rounded-full text-xs font-medium data-[state=active]:cx-pill-active">Bookmark</TabsTrigger>
                        <TabsTrigger value="snip" className="rounded-full text-xs font-medium data-[state=active]:cx-pill-active">Screen Snip</TabsTrigger>
                    </TabsList>

                    <TabsContent value="pdf" className="space-y-4 mt-4">
                        <div {...pdfDropzone.getRootProps()} className={`
                            flex flex-col items-center justify-center
                            h-40 border border-dashed rounded-2xl cursor-pointer transition-colors
                            ${pdfDropzone.isDragActive ? 'border-primary/60 bg-primary/10' : 'border-border/60 dark:border-white/20 bg-muted/20 dark:bg-[#26292d] hover:bg-muted/30 dark:hover:bg-[#2b2e33]'}
                        `}>
                            <input {...pdfDropzone.getInputProps()} />
                            <UploadCloud className={`h-10 w-10 mb-2 ${pdfDropzone.isDragActive ? 'text-primary' : 'text-muted-foreground'}`} />
                            <div className="text-center px-4">
                                <p className="text-sm font-medium">{pdfDropzone.isDragActive ? 'Drop PDF here ...' : 'Drag & drop PDF here'}</p>
                                <p className="text-xs text-muted-foreground">or click to browse</p>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-medium">PDF URL</label>
                            <Input
                                placeholder="https://example.com/document.pdf"
                                value={url}
                                onChange={e => setUrl(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleUrlUpload()}
                                className="cx-input"
                            />
                            <label className="text-sm font-medium">Custom Name (Optional)</label>
                            <Input
                                placeholder="My Document"
                                value={customName}
                                onChange={e => setCustomName(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleUrlUpload()}
                                className="cx-input"
                            />
                            <Button onClick={handleUrlUpload} disabled={urlLoading || !url} className="w-full rounded-full font-semibold">
                                {urlLoading ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Fetching PDF...</> : <><LinkIcon className="h-4 w-4 mr-2" /> Fetch PDF</>}
                            </Button>
                        </div>
                    </TabsContent>

                    <TabsContent value="bookmark" className="space-y-4 mt-4">
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Website URL</label>
                            <Input
                                placeholder="https://example.com/article"
                                value={bookmarkUrl}
                                onChange={e => setBookmarkUrl(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleBookmarkCapture()}
                                className="cx-input"
                            />
                            <p className="text-xs text-muted-foreground">
                                Dual capture mode: readable text + screenshot OCR indexing.
                            </p>
                            <div className="cx-subpanel p-3 space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                    <div>
                                        <div className="text-xs font-medium">Optional Screenshots</div>
                                        <div className="text-[11px] text-muted-foreground">
                                            Upload or screen-capture website moments before saving bookmark.
                                        </div>
                                    </div>
                                    <Button
                                        type="button"
                                        size="sm"
                                        className="rounded-full border-none text-black font-semibold bg-gradient-to-r from-[#EEDFB5] via-[#DB96D1] via-[#E79BB8] to-[#F2C3A7] hover:opacity-95"
                                        onClick={() => setIsBookmarkCaptureStudioOpen(true)}
                                    >
                                        Open Capture Studio
                                    </Button>
                                </div>
                                <div className="text-[11px] text-muted-foreground">
                                    Attached screenshots: <span className="font-medium text-foreground">{bookmarkCaptureFiles.length}</span>
                                </div>
                            </div>
                            <Button onClick={handleBookmarkCapture} disabled={bookmarkLoading || !bookmarkUrl} className="w-full rounded-full font-semibold">
                                {bookmarkLoading ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Capturing Bookmark...</> : <><BookmarkPlus className="h-4 w-4 mr-2" /> Capture Bookmark</>}
                            </Button>
                        </div>
                    </TabsContent>

                    <TabsContent value="snip" className="space-y-4 mt-4">
                        <Button
                            variant="outline"
                            className="w-full rounded-full border-border dark:border-white/10"
                            onClick={captureScreenSnip}
                            disabled={screenCaptureLoading || snipLoading}
                        >
                            {screenCaptureLoading ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                    Capturing Screen...
                                </>
                            ) : (
                                <>
                                    <MonitorUp className="h-4 w-4 mr-2" />
                                    Capture Screen
                                </>
                            )}
                        </Button>

                        <div {...snipDropzone.getRootProps()} className={`
                            flex flex-col items-center justify-center
                            h-44 border border-dashed rounded-2xl cursor-pointer transition-colors
                            ${snipDropzone.isDragActive ? 'border-primary/60 bg-primary/10' : 'border-border/60 dark:border-white/20 bg-muted/20 dark:bg-[#26292d] hover:bg-muted/30 dark:hover:bg-[#2b2e33]'}
                        `}>
                            <input {...snipDropzone.getInputProps()} />
                            {snipLoading ? (
                                <>
                                    <Loader2 className="h-10 w-10 mb-2 animate-spin text-primary" />
                                    <p className="text-sm font-medium">Processing screen snip...</p>
                                </>
                            ) : (
                                <>
                                    <ImageIcon className={`h-10 w-10 mb-2 ${snipDropzone.isDragActive ? 'text-primary' : 'text-muted-foreground'}`} />
                                    <div className="text-center px-4">
                                        <p className="text-sm font-medium">{snipDropzone.isDragActive ? 'Drop image here ...' : 'Drop screenshot image here'}</p>
                                        <p className="text-xs text-muted-foreground">PNG, JPG, JPEG, WEBP</p>
                                    </div>
                                </>
                            )}
                        </div>
                    </TabsContent>
                </Tabs>
            </DialogContent>

            <Dialog open={isBookmarkCaptureStudioOpen} onOpenChange={setIsBookmarkCaptureStudioOpen}>
                <DialogContent className="max-w-[95vw] sm:max-w-4xl max-h-[92vh] overflow-y-auto border border-border dark:border-white/10 bg-card dark:bg-[#2f3136] rounded-3xl">
                    <DialogHeader>
                        <DialogTitle>Bookmark Capture Studio</DialogTitle>
                    </DialogHeader>

                    <div className="space-y-4">
                        <input
                            ref={bookmarkCaptureFileInputRef}
                            type="file"
                            accept="image/*"
                            multiple
                            className="hidden"
                            onChange={(event) => {
                                handleBookmarkCaptureUpload(event.target.files);
                                event.currentTarget.value = "";
                            }}
                        />

                        <div
                            className={`border rounded-2xl p-4 text-center transition-colors ${isBookmarkDropActive ? 'border-primary bg-primary/5' : 'border-dashed border-border/60 dark:border-white/20 bg-muted/20 dark:bg-[#26292d]'}`}
                            onDragOver={(event) => {
                                event.preventDefault();
                                setIsBookmarkDropActive(true);
                            }}
                            onDragLeave={(event) => {
                                event.preventDefault();
                                setIsBookmarkDropActive(false);
                            }}
                            onDrop={(event) => {
                                event.preventDefault();
                                setIsBookmarkDropActive(false);
                                handleBookmarkCaptureUpload(event.dataTransfer.files);
                            }}
                        >
                            <p className="text-sm font-medium">Drop screenshots here</p>
                            <p className="text-xs text-muted-foreground mt-1">
                                These screenshots are indexed with the bookmark at save time.
                            </p>

                            <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-3 mt-3 items-end">
                                <div className="text-left">
                                    <label className="text-[11px] font-medium text-muted-foreground">Max pics (auto)</label>
                                    <input
                                        type="number"
                                        min={1}
                                        max={120}
                                        value={bookmarkAutoCaptureMaxShots}
                                        onChange={(event) => setBookmarkAutoCaptureMaxShots(event.target.value)}
                                        className="mt-1 w-full h-9 cx-input px-3 text-xs"
                                    />
                                </div>
                                <div className="flex gap-2 justify-start sm:justify-end flex-wrap">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="rounded-full border-border dark:border-white/10"
                                        onClick={() => bookmarkCaptureFileInputRef.current?.click()}
                                    >
                                        Upload Screenshot(s)
                                    </Button>
                                    {!isBookmarkScreenShareActive ? (
                                        <Button
                                            size="sm"
                                            className="rounded-full"
                                            onClick={handleBookmarkStartScreenShareSession}
                                            disabled={isBookmarkAutoCapturing}
                                        >
                                            Start Screen Share
                                        </Button>
                                    ) : (
                                        <>
                                            <Button
                                                size="sm"
                                                className="rounded-full"
                                                onClick={handleBookmarkCaptureFromActiveSession}
                                                disabled={isBookmarkCapturingFrame || isBookmarkAutoCapturing}
                                            >
                                                {isBookmarkCapturingFrame ? "Capturing..." : "Capture Shot"}
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="rounded-full border-border dark:border-white/10"
                                                onClick={handleBookmarkAutoCaptureFromSharedPage}
                                                disabled={isBookmarkAutoCapturing}
                                            >
                                                {isBookmarkAutoCapturing ? "Auto Capturing..." : "Auto Capture Page"}
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="rounded-full border-border dark:border-white/10"
                                                onClick={stopBookmarkScreenShareSession}
                                                disabled={isBookmarkAutoCapturing}
                                            >
                                                Stop Session
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </div>

                            <div className="mt-3 space-y-2">
                                {isBookmarkScreenShareActive ? (
                                    <div className="text-[11px] text-muted-foreground">
                                        Screen-share active. Press <span className="font-semibold">C</span> or click
                                        <span className="font-semibold"> Capture Shot</span>.
                                    </div>
                                ) : (
                                    <div className="text-[11px] text-muted-foreground">
                                        Start a session to preview your shared screen and capture moments.
                                    </div>
                                )}
                                <div className="rounded-xl border border-border/60 dark:border-white/20 overflow-hidden bg-black/30">
                                    <video
                                        ref={bookmarkScreenVideoRef}
                                        autoPlay
                                        muted
                                        playsInline
                                        className="w-full h-56 object-contain bg-black"
                                    />
                                </div>
                                <div className="text-[11px] text-muted-foreground">
                                    Captured in this session: {bookmarkScreenCaptureCount}
                                </div>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <div className="text-xs font-medium text-muted-foreground">Capture Status</div>
                            {bookmarkCaptureJobs.length === 0 ? (
                                <div className="text-xs text-muted-foreground cx-subpanel p-2">
                                    No capture jobs yet.
                                </div>
                            ) : (
                                <div className="space-y-1 max-h-[220px] overflow-auto">
                                    {bookmarkCaptureJobs.map((job) => (
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
                            <div className="flex items-center justify-between gap-2">
                                <div className="text-xs font-medium text-muted-foreground">
                                    Attached Screenshots ({bookmarkCaptureFiles.length})
                                </div>
                                {bookmarkCaptureFiles.length > 0 && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="rounded-full"
                                        onClick={() => setBookmarkCaptureFiles([])}
                                    >
                                        Clear All
                                    </Button>
                                )}
                            </div>
                            {bookmarkCaptureFiles.length === 0 ? (
                                <div className="text-xs text-muted-foreground cx-subpanel p-2">
                                    No screenshots selected yet.
                                </div>
                            ) : (
                                <div className="space-y-1 max-h-[220px] overflow-auto">
                                    {bookmarkCaptureFiles.map((file, idx) => (
                                        <div key={`${file.name}-${idx}`} className="cx-subpanel p-2 flex items-center justify-between gap-2">
                                            <span className="text-xs truncate">{file.name}</span>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="rounded-full"
                                                onClick={() => setBookmarkCaptureFiles(prev => prev.filter((_, i) => i !== idx))}
                                            >
                                                Remove
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </Dialog>
    )
}
