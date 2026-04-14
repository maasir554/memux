const API_URL = "http://localhost:8000";

export type AgentStreamEventType =
  | "run_state"
  | "tool_started"
  | "tool_progress"
  | "tool_finished"
  | "token"
  | "citation"
  | "final"
  | "error";

export interface AgentStreamEvent {
  event: AgentStreamEventType;
  data: Record<string, any>;
}

export interface AgentStreamRequest {
  run_id: string;
  user_query: string;
  context_chunks: Array<Record<string, any>>;
  conversation?: Array<{ role: "user" | "assistant"; content: string }>;
}

function parseSseChunk(
  chunk: string,
  onEvent: (event: AgentStreamEvent) => void,
): void {
  const lines = chunk.split("\n");
  let eventName = "";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (!eventName || dataLines.length === 0) return;
  try {
    const payload = JSON.parse(dataLines.join("\n"));
    onEvent({ event: eventName as AgentStreamEventType, data: payload });
  } catch {
    onEvent({
      event: "error",
      data: {
        message: "Failed to parse streaming event payload.",
      },
    });
  }
}

export const agentStreamService = {
  async streamRun(
    request: AgentStreamRequest,
    handlers: {
      onEvent: (event: AgentStreamEvent) => void;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    const response = await fetch(`${API_URL}/agent_chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: handlers.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error("Failed to start agent stream.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";
      for (const chunk of chunks) {
        parseSseChunk(chunk, handlers.onEvent);
      }
    }
  },

  async pauseRun(runId: string): Promise<void> {
    await fetch(`${API_URL}/agent_chat/run/${runId}/pause`, { method: "POST" });
  },

  async resumeRun(runId: string): Promise<void> {
    await fetch(`${API_URL}/agent_chat/run/${runId}/resume`, { method: "POST" });
  },

  async stopRun(runId: string): Promise<void> {
    await fetch(`${API_URL}/agent_chat/run/${runId}/stop`, { method: "POST" });
  },
};

