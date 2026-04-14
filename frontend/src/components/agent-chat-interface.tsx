import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AutoResizeTextarea } from "@/components/ui/auto-resize-textarea";
import { contextRetrievalService } from "@/services/context-retrieval-service";
import { agentStreamService, type AgentStreamEvent } from "@/services/agent-stream-service";
import { Loader2, Pause, Play, Square, RefreshCcw, Wrench, Sparkles } from "lucide-react";

type ChatRole = "user" | "assistant";

interface AgentMessage {
  id: string;
  role: ChatRole;
  content: string;
  references?: Array<Record<string, any>>;
  error?: string;
}

interface TimelineEvent {
  id: string;
  phase: string;
  title: string;
  detail?: string;
  status: "running" | "done" | "error";
  timestamp: number;
}

function toTimelineEvent(event: AgentStreamEvent): TimelineEvent | null {
  const data = event.data || {};
  const base = {
    id: `${event.event}-${data.step_id || Math.random().toString(36).slice(2)}`,
    phase: String(data.phase || "runtime"),
    timestamp: Number(data.timestamp_ms || Date.now()),
  };

  if (event.event === "run_state") {
    return {
      ...base,
      title: String(data.message || "Agent state update"),
      detail: String(data.status || "running"),
      status: data.status === "error" ? "error" : "running",
    };
  }
  if (event.event === "tool_started") {
    return {
      ...base,
      title: `Tool: ${String(data.tool_name || "unknown")}`,
      detail: "started",
      status: "running",
    };
  }
  if (event.event === "tool_finished") {
    return {
      ...base,
      title: `Tool: ${String(data.tool_name || "unknown")}`,
      detail: "finished",
      status: "done",
    };
  }
  if (event.event === "error") {
    return {
      ...base,
      title: "Agent error",
      detail: String(data.message || "unknown error"),
      status: "error",
    };
  }
  return null;
}

function renderAssistantContent(content: string): string {
  return content.replace(/\[doc_(\d+)\]/g, (_, idx) => `[ref_${Number(idx) + 1}]`);
}

export function AgentChatInterface() {
  const [messages, setMessages] = useState<AgentMessage[]>([
    {
      id: "intro",
      role: "assistant",
      content: "Beta Agent Chat is ready. I will stream reasoning progress, tool usage, and citations live.",
    },
  ]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [draftResponse, setDraftResponse] = useState("");
  const [draftReferences, setDraftReferences] = useState<Array<Record<string, any>>>([]);
  const [lastQuery, setLastQuery] = useState("");

  const abortRef = useRef<AbortController | null>(null);

  const canSend = input.trim().length > 0 && !isRunning;
  const makeId = () => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  };

  const pushTimeline = (entry: TimelineEvent | null) => {
    if (!entry) return;
    setTimeline((prev) => [entry, ...prev].slice(0, 80));
  };

  const appendAssistantDelta = (delta: string) => {
    setDraftResponse((prev) => prev + delta);
  };

  const runAgent = async (query: string) => {
    const runId = makeId();
    setActiveRunId(runId);
    setIsRunning(true);
    setIsPaused(false);
    setDraftResponse("");
    setDraftReferences([]);
    setLastQuery(query);

    setMessages((prev) => [
      ...prev,
      { id: makeId(), role: "user", content: query },
    ]);

    try {
      pushTimeline({
        id: `local-retrieve-${runId}`,
        phase: "retrieving",
        title: "Local retrieval started",
        detail: "Searching selected spaces and source types",
        status: "running",
        timestamp: Date.now(),
      });

      const retrieval = await contextRetrievalService.retrieve(query);
      const candidates = contextRetrievalService.formatForModels(retrieval.items);

      pushTimeline({
        id: `local-retrieve-finish-${runId}`,
        phase: "retrieving",
        title: "Local retrieval completed",
        detail: `${candidates.length} candidate chunks`,
        status: "done",
        timestamp: Date.now(),
      });

      abortRef.current = new AbortController();
      await agentStreamService.streamRun(
        {
          run_id: runId,
          user_query: query,
          context_chunks: candidates,
          conversation: messages.slice(-6).map((m) => ({ role: m.role, content: m.content })),
        },
        {
          signal: abortRef.current.signal,
          onEvent: (event) => {
            pushTimeline(toTimelineEvent(event));
            if (event.event === "token") {
              appendAssistantDelta(String(event.data.delta || ""));
            }
            if (event.event === "citation" && event.data.reference) {
              setDraftReferences((prev) => [...prev, event.data.reference]);
            }
            if (event.event === "final") {
              const finalText = String(event.data.response || draftResponse || "");
              const refs = Array.isArray(event.data.references) ? event.data.references : draftReferences;
              setMessages((prev) => [
                ...prev,
                {
                  id: makeId(),
                  role: "assistant",
                  content: finalText,
                  references: refs,
                },
              ]);
              setDraftResponse("");
              setDraftReferences([]);
              setIsRunning(false);
              setIsPaused(false);
            }
            if (event.event === "error") {
              setMessages((prev) => [
                ...prev,
                {
                  id: makeId(),
                  role: "assistant",
                  content: "Run failed.",
                  error: String(event.data.message || "unknown error"),
                },
              ]);
              setIsRunning(false);
              setIsPaused(false);
            }
          },
        },
      );
    } catch (error: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role: "assistant",
          content: "The agent run could not complete.",
          error: error?.message || "unknown error",
        },
      ]);
      setIsRunning(false);
      setIsPaused(false);
    }
  };

  const handlePauseResume = async () => {
    if (!activeRunId) return;
    if (isPaused) {
      await agentStreamService.resumeRun(activeRunId);
      setIsPaused(false);
      return;
    }
    await agentStreamService.pauseRun(activeRunId);
    setIsPaused(true);
  };

  const handleStop = async () => {
    if (!activeRunId) return;
    await agentStreamService.stopRun(activeRunId);
    abortRef.current?.abort();
    setIsRunning(false);
    setIsPaused(false);
  };

  const handleRetry = async () => {
    if (!lastQuery || isRunning) return;
    await runAgent(lastQuery);
  };

  const draftBlock = useMemo(() => {
    if (!draftResponse) return null;
    return (
      <div className="rounded-2xl border bg-card p-4">
        <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Streaming</div>
        <p className="text-sm whitespace-pre-wrap">{renderAssistantContent(draftResponse)}</p>
      </div>
    );
  }, [draftResponse]);

  return (
    <div className="h-full grid grid-cols-1 lg:grid-cols-[1.65fr_1fr] gap-4">
      <div className="min-h-0 rounded-2xl border bg-background flex flex-col">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <div>
              <div className="text-sm font-semibold">Beta Agent Chat</div>
              <div className="text-xs text-muted-foreground">Streaming, transparent tool trace, strict references</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handlePauseResume} disabled={!isRunning}>
              {isPaused ? <Play className="w-3.5 h-3.5 mr-1" /> : <Pause className="w-3.5 h-3.5 mr-1" />}
              {isPaused ? "Resume" : "Pause"}
            </Button>
            <Button variant="outline" size="sm" onClick={handleStop} disabled={!isRunning}>
              <Square className="w-3.5 h-3.5 mr-1" /> Stop
            </Button>
            <Button variant="outline" size="sm" onClick={handleRetry} disabled={isRunning || !lastQuery}>
              <RefreshCcw className="w-3.5 h-3.5 mr-1" /> Retry
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((message) => (
            <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-3 border ${message.role === "user" ? "bg-muted" : "bg-card"}`}>
                <p className="text-sm whitespace-pre-wrap">{renderAssistantContent(message.content)}</p>
                {message.error && <p className="mt-2 text-xs text-destructive">{message.error}</p>}
                {message.references && message.references.length > 0 && (
                  <div className="mt-3 border-t pt-2 space-y-1">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">References</div>
                    {message.references.map((ref, idx) => (
                      <a
                        key={`${message.id}-ref-${idx}`}
                        href={String(ref.citation_payload?.canonical_uri || "#")}
                        target="_blank"
                        rel="noreferrer"
                        className="block text-xs rounded border px-2 py-1 hover:bg-muted/40"
                      >
                        [{idx + 1}] {String(ref.filename || "Untitled")} • {String(ref.source_type || "source")}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {draftBlock}
          {isRunning && !draftResponse && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Agent run is in progress...
            </div>
          )}
        </div>

        <div className="p-4 border-t">
          <div className="flex gap-2">
            <AutoResizeTextarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onEnter={() => {
                if (!canSend) return;
                const q = input.trim();
                setInput("");
                void runAgent(q);
              }}
              placeholder="Ask with agent mode..."
              className="min-h-[44px] rounded-2xl"
              disabled={isRunning}
            />
            <Button
              disabled={!canSend}
              onClick={() => {
                const q = input.trim();
                setInput("");
                void runAgent(q);
              }}
              size="icon"
              className="rounded-full h-11 w-11"
            >
              {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wrench className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 rounded-2xl border bg-background flex flex-col">
        <div className="px-4 py-3 border-b">
          <div className="text-sm font-semibold">Live Tool Usage</div>
          <div className="text-xs text-muted-foreground">Planner, retriever, tool execution, synthesis trace</div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {timeline.map((event) => (
            <div key={event.id} className="rounded-xl border p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">{event.phase}</span>
                <span className={`text-[10px] uppercase ${
                  event.status === "error" ? "text-destructive" : event.status === "done" ? "text-emerald-600" : "text-blue-600"
                }`}>
                  {event.status}
                </span>
              </div>
              <div className="text-sm mt-1">{event.title}</div>
              {event.detail && <div className="text-xs text-muted-foreground mt-1">{event.detail}</div>}
            </div>
          ))}
          {timeline.length === 0 && (
            <div className="text-sm text-muted-foreground">No tool events yet. Start a run to inspect live orchestration.</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AgentChatInterface;

