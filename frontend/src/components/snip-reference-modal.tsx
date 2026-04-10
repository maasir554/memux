import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { dbService } from "@/services/db-service";
import { pdfStore } from "@/services/pdf-store";

interface SnipSource {
    source_id: string;
    filename: string;
    text_summary: string;
    citation_payload?: {
        asset_id?: string | null;
    };
}

interface SnipReferenceModalProps {
    source: SnipSource;
    children: React.ReactNode;
}

export function SnipReferenceModal({ source, children }: SnipReferenceModalProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const preferredAssetId = source.citation_payload?.asset_id || null;

    useEffect(() => {
        let disposed = false;
        let currentUrl: string | null = null;

        const load = async () => {
            if (!isOpen) return;

            setIsLoading(true);
            setError(null);
            setImageUrl(null);
            try {
                const tryAsset = async (assetId: string): Promise<File | null> => {
                    const file = await pdfStore.getAsset(assetId);
                    if (!file || !file.type.startsWith("image/")) return null;
                    return file;
                };

                let file: File | null = null;
                if (preferredAssetId) {
                    file = await tryAsset(preferredAssetId);
                }

                if (!file) {
                    const assets = await dbService.getContextAssets(source.source_id);
                    const imageAsset = assets.find((asset) => (asset.mime_type || "").startsWith("image/"));
                    if (imageAsset) {
                        file = await tryAsset(imageAsset.id);
                    }
                }

                if (!file) {
                    throw new Error("No screenshot image found for this reference.");
                }

                currentUrl = URL.createObjectURL(file);
                if (!disposed) {
                    setImageUrl(currentUrl);
                }
            } catch (e: any) {
                if (!disposed) setError(e?.message || "Unable to load screenshot.");
            } finally {
                if (!disposed) setIsLoading(false);
            }
        };

        load();
        return () => {
            disposed = true;
            if (currentUrl) URL.revokeObjectURL(currentUrl);
        };
    }, [isOpen, preferredAssetId, source.source_id]);

    const shortExcerpt = useMemo(() => {
        const text = (source.text_summary || "").trim();
        if (text.length <= 260) return text;
        return `${text.slice(0, 260)}...`;
    }, [source.text_summary]);

    return (
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
                {children}
            </DialogTrigger>
            <DialogContent className="max-w-[90vw] sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{source.filename}</DialogTitle>
                    <DialogDescription>
                        Exact referenced screen snip for this citation.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                    {isLoading && (
                        <div className="text-sm text-muted-foreground">Loading screenshot...</div>
                    )}
                    {error && (
                        <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-2">
                            {error}
                        </div>
                    )}
                    {imageUrl && (
                        <div className="max-h-[65vh] overflow-auto border rounded-md bg-black/5">
                            <img src={imageUrl} alt={source.filename} className="w-full h-auto" />
                        </div>
                    )}
                    <div className="text-xs text-muted-foreground border rounded-md p-2 bg-muted/20">
                        <span className="font-medium">Matched chunk:</span> {shortExcerpt || "No text excerpt available."}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

