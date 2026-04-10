import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { dbService, type ContextSpace, type ContextSource } from "@/services/db-service";
import { useExtractionStore } from "@/store/extraction-store";
import { Archive, FolderPlus, Layers, Pencil, Save, X } from "lucide-react";

interface SpaceStats {
    total: number;
    pdf: number;
    bookmark: number;
    snip: number;
}

export function ContextSpacesView() {
    const [spaces, setSpaces] = useState<ContextSpace[]>([]);
    const [sources, setSources] = useState<ContextSource[]>([]);
    const [newName, setNewName] = useState("");
    const [newDescription, setNewDescription] = useState("");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState("");
    const [editDescription, setEditDescription] = useState("");
    const setFocusedSpaceIds = useExtractionStore(state => state.setFocusedSpaceIds);

    const reload = async () => {
        await dbService.getDefaultContextSpace();
        const [loadedSpaces, loadedSources] = await Promise.all([
            dbService.getContextSpaces(),
            dbService.getContextSources()
        ]);
        setSpaces(loadedSpaces);
        setSources(loadedSources);
    };

    useEffect(() => {
        reload();
    }, []);

    const statsBySpace = useMemo(() => {
        const stats = new Map<string, SpaceStats>();
        for (const space of spaces) {
            stats.set(space.id, { total: 0, pdf: 0, bookmark: 0, snip: 0 });
        }
        for (const source of sources) {
            const current = stats.get(source.space_id);
            if (!current) continue;
            current.total += 1;
            if (source.source_type === "pdf") current.pdf += 1;
            if (source.source_type === "bookmark") current.bookmark += 1;
            if (source.source_type === "snip") current.snip += 1;
        }
        return stats;
    }, [spaces, sources]);

    const handleCreate = async () => {
        if (!newName.trim()) return;
        await dbService.createContextSpace(newName.trim(), newDescription.trim() || undefined);
        setNewName("");
        setNewDescription("");
        await reload();
    };

    const startEdit = (space: ContextSpace) => {
        setEditingId(space.id);
        setEditName(space.name);
        setEditDescription(space.description || "");
    };

    const saveEdit = async () => {
        if (!editingId || !editName.trim()) return;
        await dbService.updateContextSpace(editingId, editName.trim(), editDescription.trim() || undefined);
        setEditingId(null);
        await reload();
    };

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                        <FolderPlus className="h-4 w-4" />
                        Create Context Space
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                    <Input
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder="Space name"
                    />
                    <Input
                        value={newDescription}
                        onChange={(e) => setNewDescription(e.target.value)}
                        placeholder="Description (optional)"
                    />
                    <Button onClick={handleCreate} disabled={!newName.trim()}>
                        Create Space
                    </Button>
                </CardContent>
            </Card>

            <div className="grid gap-3">
                {spaces.map((space) => {
                    const stats = statsBySpace.get(space.id) || { total: 0, pdf: 0, bookmark: 0, snip: 0 };
                    const isEditing = editingId === space.id;
                    return (
                        <Card key={space.id}>
                            <CardContent className="pt-4 space-y-3">
                                {isEditing ? (
                                    <div className="space-y-2">
                                        <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                                        <Input value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
                                    </div>
                                ) : (
                                    <div>
                                        <h3 className="font-semibold flex items-center gap-2">
                                            <Layers className="h-4 w-4 text-muted-foreground" />
                                            {space.name}
                                        </h3>
                                        <p className="text-xs text-muted-foreground mt-1">{space.description || "No description"}</p>
                                    </div>
                                )}

                                <div className="flex flex-wrap gap-2 text-xs">
                                    <span className="px-2 py-1 rounded bg-muted">Total: {stats.total}</span>
                                    <span className="px-2 py-1 rounded bg-muted">PDF: {stats.pdf}</span>
                                    <span className="px-2 py-1 rounded bg-muted">Bookmark: {stats.bookmark}</span>
                                    <span className="px-2 py-1 rounded bg-muted">Snip: {stats.snip}</span>
                                </div>

                                <div className="flex gap-2">
                                    <Button variant="outline" size="sm" onClick={() => setFocusedSpaceIds([space.id])}>
                                        Use Space
                                    </Button>
                                    {isEditing ? (
                                        <>
                                            <Button size="sm" onClick={saveEdit}>
                                                <Save className="h-3.5 w-3.5 mr-1" />
                                                Save
                                            </Button>
                                            <Button variant="outline" size="sm" onClick={() => setEditingId(null)}>
                                                <X className="h-3.5 w-3.5 mr-1" />
                                                Cancel
                                            </Button>
                                        </>
                                    ) : (
                                        <Button variant="outline" size="sm" onClick={() => startEdit(space)}>
                                            <Pencil className="h-3.5 w-3.5 mr-1" />
                                            Rename
                                        </Button>
                                    )}
                                    {!space.is_default && (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={async () => {
                                                await dbService.archiveContextSpace(space.id);
                                                await reload();
                                            }}
                                        >
                                            <Archive className="h-3.5 w-3.5 mr-1" />
                                            Archive
                                        </Button>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    );
                })}
            </div>
        </div>
    );
}
