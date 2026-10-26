// DataBridge -- abstracts data access for VS Code and browser modes.
//
// VS Code mode: sends postMessage requests to extension host, waits for responses.
// Browser mode: queries local sql.js database directly.
//
// All views use useWebviewQuery() which consumes the bridge from React context.

import { createContext, useContext } from "react";

/** Request sent from webview to extension host */
export interface DataRequest {
  type: "request";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/** Response sent from extension host to webview */
export interface DataResponse {
  type: "response";
  id: string;
  data?: unknown;
  error?: string;
}

/** Push events from extension host (unsolicited) */
export type PushEvent =
  | { type: "dbReloaded" }
  | { type: "editStateChanged" }
  | { type: "statusChanged" }
  | { type: "showStatus" }
  | { type: "showFunction"; data: unknown }
  | { type: "showHome"; data: unknown }
  | { type: "clear" }
  | { type: "analysisProgress"; data: { event: string; detail?: string } }
  | { type: "fileStale"; filePath: string }
  | { type: "fileAnalyzing"; filePath: string }
  | { type: "fileAnalyzed"; filePath: string };

export interface DataBridge {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Subscribe to push events. Returns unsubscribe function. */
  onPush(handler: (event: PushEvent) => void): () => void;
}

// --- VS Code Bridge ---

interface VSCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

type PendingRequest = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
};

export class VSCodeBridge implements DataBridge {
  private api: VSCodeApi;
  private pending = new Map<string, PendingRequest>();
  private pushHandlers = new Set<(event: PushEvent) => void>();
  private listening = false;

  constructor(api: VSCodeApi) {
    this.api = api;
    this.startListening();
  }

  get vsCodeApi(): VSCodeApi {
    return this.api;
  }

  private startListening() {
    if (this.listening) return;
    this.listening = true;

    window.addEventListener("message", (event: MessageEvent) => {
      const message = event.data;
      if (!message || typeof message !== "object") return;

      // Handle responses to our requests
      if (message.type === "response" && typeof message.id === "string") {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          if (message.error) {
            pending.reject(new Error(message.error));
          } else {
            pending.resolve(message.data);
          }
        }
        return;
      }

      // Handle push events
      if (
        message.type === "dbReloaded" ||
        message.type === "editStateChanged" ||
        message.type === "statusChanged" ||
        message.type === "showStatus" ||
        message.type === "showFunction" ||
        message.type === "showHome" ||
        message.type === "clear" ||
        message.type === "analysisProgress" ||
        message.type === "fileStale" ||
        message.type === "fileAnalyzing" ||
        message.type === "fileAnalyzed"
      ) {
        for (const handler of this.pushHandlers) {
          handler(message as PushEvent);
        }
      }
    });
  }

  request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = crypto.randomUUID();
      this.pending.set(id, {
        resolve: resolve as (data: unknown) => void,
        reject,
      });

      const request: DataRequest = { type: "request", id, method, params };
      this.api.postMessage(request);

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 10_000);
    });
  }

  onPush(handler: (event: PushEvent) => void): () => void {
    this.pushHandlers.add(handler);
    return () => this.pushHandlers.delete(handler);
  }
}

// --- Browser Bridge ---

// In browser mode, query implementations are registered here.
// This allows data.ts to register its sql.js query functions.
type QueryHandler = (
  method: string,
  params?: Record<string, unknown>
) => Promise<unknown>;

export class BrowserBridge implements DataBridge {
  private handler: QueryHandler;
  private pushHandlers = new Set<(event: PushEvent) => void>();

  constructor(handler: QueryHandler) {
    this.handler = handler;
  }

  async request<T>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    return (await this.handler(method, params)) as T;
  }

  onPush(handler: (event: PushEvent) => void): () => void {
    this.pushHandlers.add(handler);
    return () => this.pushHandlers.delete(handler);
  }

  /** Emit a push event (used by browser mode to simulate extension events) */
  emit(event: PushEvent): void {
    for (const handler of this.pushHandlers) {
      handler(event);
    }
  }
}

// --- React Context ---

const DataBridgeContext = createContext<DataBridge | null>(null);

export const DataBridgeProvider = DataBridgeContext.Provider;

export function useDataBridge(): DataBridge {
  const bridge = useContext(DataBridgeContext);
  if (!bridge) {
    throw new Error("useDataBridge must be used within a DataBridgeProvider");
  }
  return bridge;
}
