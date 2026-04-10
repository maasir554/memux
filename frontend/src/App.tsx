import { useEffect, useState } from 'react'
import { useLocation, useRoute } from 'wouter'
import LayoutShell from "@/components/layout-shell"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import DataExplorer from "@/components/data-explorer"
import ChatInterface from "@/components/chat-interface"
import TrashView from "@/components/trash-view"
import DevToolsView from "@/components/dev-tools-view"
import { FileExplorer } from "@/components/file-explorer"
import { FileDetailsView } from "@/components/file-details-view"
import { ContextSourceDetailsView } from "@/components/context-source-details-view"
import { ContextSpacesView } from "@/components/context-spaces-view"
import { dbService } from "@/services/db-service"
import type { ContextExplorerItem } from "@/services/db-service"
import { Loader2, Trash2, Layers, FlaskConical, SearchCode } from "lucide-react"
import ChunkSearchView from "@/components/chunk-search-view"

import { useExtractionStore } from '@/store/extraction-store'

function App() {
  const trashedJobs = useExtractionStore(state => state.trashedJobs);
  const isLoading = useExtractionStore(state => state.isLoading);
  const loadJobs = useExtractionStore(state => state.loadJobs);
  const trashCount = Object.keys(trashedJobs).length;

  const [location, setLocation] = useLocation();
  const [isDocRoute, docParams] = useRoute('/document/:id/*?');
  const [isSourceRoute, sourceParams] = useRoute('/source/:id/*?');
  const selectedFileId = isDocRoute ? docParams.id : null;
  const selectedSourceId = isSourceRoute ? sourceParams.id : null;

  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    loadJobs();
    // One-time cleanup: remove segments/assets orphaned by the soft-delete bug (no hard-delete was fired).
    dbService.purgeOrphanedSegments().catch(console.error);
  }, [loadJobs]);

  useEffect(() => {
    const APP_COMMAND_CHANNEL = "MEMUX_APP_COMMAND";
    const APP_COMMAND_RESULT_CHANNEL = "MEMUX_APP_COMMAND_RESULT";

    const dataUrlToFile = async (dataUrl: string, filename: string, mimeType?: string): Promise<File> => {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      return new File([blob], filename, { type: mimeType || blob.type || "image/png" });
    };

    const handleAppCommand = async (event: MessageEvent) => {
      if (event.source !== window) return;
      const payload = event.data;
      if (!payload || payload.channel !== APP_COMMAND_CHANNEL || !payload.requestId) return;

      const requestId = String(payload.requestId);
      const command = String(payload.command || "");
      const commandPayload = (payload.payload && typeof payload.payload === "object") ? payload.payload : {};

      const respond = (ok: boolean, result?: any, error?: string) => {
        window.postMessage({
          channel: APP_COMMAND_RESULT_CHANNEL,
          requestId,
          ok,
          result: result || {},
          error: error || null
        }, "*");
      };

      try {
        if (command === "EXT_GET_CONTEXT_SPACES") {
          const spaces = await dbService.getContextSpaces();
          const defaultSpace = await dbService.getDefaultContextSpace();
          respond(true, {
            spaces: spaces.map((space) => ({
              id: space.id,
              name: space.name,
              is_default: space.id === defaultSpace.id
            })),
            default_space_id: defaultSpace.id
          });
          return;
        }

        if (command === "EXT_SAVE_BOOKMARK") {
          const url = String(commandPayload.url || "").trim();
          if (!url) {
            throw new Error("Bookmark URL is required.");
          }
          const spaceId = String(commandPayload.spaceId || "").trim() || undefined;
          const screenshots = Array.isArray(commandPayload.screenshots) ? commandPayload.screenshots : [];
          const supplementalFiles: File[] = [];
          for (const shot of screenshots) {
            const dataUrl = String(shot?.dataUrl || "");
            if (!dataUrl.startsWith("data:image/")) continue;
            const file = await dataUrlToFile(
              dataUrl,
              String(shot?.name || `overlay-shot-${Date.now()}.png`),
              String(shot?.mimeType || "image/png")
            );
            supplementalFiles.push(file);
          }
          const sourceId = await useExtractionStore.getState().addBookmarkToContext(url, spaceId, supplementalFiles);
          respond(true, { sourceId });
          return;
        }

        if (command === "EXT_SAVE_SNIP") {
          const imageDataUrl = String(commandPayload.imageDataUrl || "").trim();
          if (!imageDataUrl.startsWith("data:image/")) {
            throw new Error("Snip image payload is missing.");
          }
          const spaceId = String(commandPayload.spaceId || "").trim() || undefined;
          const title = String(commandPayload.title || "Overlay Screen Snip");
          const file = await dataUrlToFile(imageDataUrl, `overlay-snip-${Date.now()}.png`, "image/png");
          const sourceId = await useExtractionStore.getState().addScreenSnipToContext(file, spaceId, title);
          respond(true, { sourceId });
          return;
        }

        if (command === "EXT_SAVE_DEV_EXTRACT") {
          const extraction = commandPayload.extraction;
          if (!extraction || typeof extraction !== "object") {
            throw new Error("Dev extraction payload is missing.");
          }
          const url = String(commandPayload.url || extraction.url || "").trim();
          if (!url) {
            throw new Error("Dev extraction URL is required.");
          }
          const title = String(commandPayload.title || extraction.title || document.title || "").trim() || null;
          const id = await dbService.saveDevPageExtraction({
            url,
            title,
            source: "extension_overlay",
            payload: extraction as Record<string, any>
          });
          respond(true, { id });
          return;
        }

        throw new Error(`Unsupported app command: ${command}`);
      } catch (error: any) {
        respond(false, {}, error?.message || "MEMUX app command failed.");
      }
    };

    window.addEventListener("message", handleAppCommand);
    return () => window.removeEventListener("message", handleAppCommand);
  }, []);

  if (isLoading) {
    return (
      <LayoutShell>
        <div className="flex items-center justify-center h-full">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">Loading documents...</p>
          </div>
        </div>
      </LayoutShell>
    );
  }

  const activeTab = location.startsWith('/chat') ? 'chat'
    : location.startsWith('/data') ? 'data'
      : location.startsWith('/dev') ? 'dev'
      : location.startsWith('/chunks') ? 'chunks'
      : location.startsWith('/spaces') ? 'spaces'
        : location.startsWith('/trash') ? 'trash'
          : 'dashboard';

  return (
    <LayoutShell>
      <Tabs
        value={activeTab}
        onValueChange={(val) => setLocation(val === 'dashboard' ? '/' : `/${val}`)}
        className="h-full flex flex-col"
      >
        {!selectedFileId && !selectedSourceId && (
          <div className={`transition-all duration-300 origin-top-left ${isScrolled ? 'mb-2 scale-90 opacity-80' : 'mb-4 scale-100 opacity-100'}`}>
            <TabsList className="transition-all duration-300 h-11 rounded-full border border-border dark:border-white/10 bg-muted/60 dark:bg-[#2b2d31] p-1 gap-1">
              <TabsTrigger value="dashboard" className="transition-all duration-300 rounded-full px-3 data-[state=active]:bg-white data-[state=active]:text-black dark:data-[state=active]:bg-white dark:data-[state=active]:text-black">Overview</TabsTrigger>
              <TabsTrigger value="chat" className="transition-all duration-300 rounded-full px-3 data-[state=active]:bg-white data-[state=active]:text-black dark:data-[state=active]:bg-white dark:data-[state=active]:text-black">Chat & RAG</TabsTrigger>
              <TabsTrigger value="data" className="transition-all duration-300 rounded-full px-3 data-[state=active]:bg-white data-[state=active]:text-black dark:data-[state=active]:bg-white dark:data-[state=active]:text-black">Data Explorer</TabsTrigger>
              <TabsTrigger value="dev" className="transition-all duration-300 rounded-full px-3 gap-1.5 data-[state=active]:bg-white data-[state=active]:text-black dark:data-[state=active]:bg-white dark:data-[state=active]:text-black">
                <FlaskConical className="w-3.5 h-3.5" />
                Dev
              </TabsTrigger>
              <TabsTrigger value="chunks" className="transition-all duration-300 rounded-full px-3 gap-1.5 data-[state=active]:bg-white data-[state=active]:text-black dark:data-[state=active]:bg-white dark:data-[state=active]:text-black">
                <SearchCode className="w-3.5 h-3.5" />
                Chunks
              </TabsTrigger>
              <TabsTrigger value="spaces" className="transition-all duration-300 rounded-full px-3 gap-1.5 data-[state=active]:bg-white data-[state=active]:text-black dark:data-[state=active]:bg-white dark:data-[state=active]:text-black">
                <Layers className="w-3.5 h-3.5" />
                Spaces
              </TabsTrigger>
              <TabsTrigger value="trash" className="gap-1.5 transition-all duration-300 rounded-full px-3 data-[state=active]:bg-white data-[state=active]:text-black dark:data-[state=active]:bg-white dark:data-[state=active]:text-black">
                <Trash2 className={`transition-all duration-300 ${isScrolled ? 'h-3 w-3' : 'h-3.5 w-3.5'}`} />
                Trash
                {trashCount > 0 && (
                  <span className="ml-1 rounded-full bg-destructive/15 text-destructive text-xs px-1.5 py-0.5 font-medium transition-all duration-300">
                    {trashCount}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
          </div>
        )}

        <TabsContent
          value="dashboard"
          className="flex-1 overflow-y-auto flex flex-col space-y-4 pr-1 pb-4"
          onScroll={(e) => {
            const scrollTop = e.currentTarget.scrollTop;
            setIsScrolled(scrollTop > 10);
          }}
        >
          {selectedSourceId ? (
            <ContextSourceDetailsView sourceId={selectedSourceId} />
          ) : selectedFileId ? (
            <FileDetailsView
              documentId={selectedFileId}
            />
          ) : (
            <>
              <div className="flex-1 min-h-[520px] shrink-0 mb-8">
                <FileExplorer
                  onSelectItem={(item: ContextExplorerItem) => {
                    setLocation(`/source/${item.id}`);
                  }}
                />
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="chat" className="flex-1 h-full overflow-hidden">
          <div className="h-full border rounded-md overflow-hidden">
            <ChatInterface />
          </div>
        </TabsContent>

        <TabsContent value="data" className="flex-1 h-full overflow-hidden">
          <DataExplorer />
        </TabsContent>

        <TabsContent value="dev" className="flex-1 h-full overflow-hidden">
          <DevToolsView />
        </TabsContent>

        <TabsContent value="chunks" className="flex-1 h-full overflow-hidden">
          <ChunkSearchView />
        </TabsContent>

        <TabsContent value="spaces" className="flex-1 overflow-y-auto pr-1 pb-4">
          <ContextSpacesView />
        </TabsContent>

        <TabsContent value="trash" className="flex-1 h-full overflow-hidden">
          <TrashView />
        </TabsContent>
      </Tabs>
    </LayoutShell>
  )
}

export default App
