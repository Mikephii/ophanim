// VS Code webview communication hook
//
// Handles bidirectional postMessage protocol between the VS Code extension and the
// React webview. Detects whether we're running inside VS Code (acquireVsCodeApi exists)
// or in a browser (standalone dev mode).
//
// Message protocol:
//   Extension → Webview: showFunction, showHome, clear
//   Webview → Extension: ready, selectFunction, backToHome, goToDefinition, refresh
//
// Multi-IDE future:
//   This module is tightly coupled to VS Code's acquireVsCodeApi / postMessage protocol.
//   To support JetBrains (JCEF), Neovim, or other IDEs, the communication layer will be
//   abstracted behind an IDEAdapter interface. Each IDE provides its own adapter
//   implementation. The FunctionData shape and message types remain the same.

import { useEffect, useState, useCallback, useRef } from "react";

// Detect if we're in VS Code or browser
const isBrowser = typeof acquireVsCodeApi === "undefined";

// Types for messages between extension and webview
export interface DetailedIssue {
  flag: string;
  title: string;
  description: string;
  explanation: string;
  line: number;
  startText: string;
  endText: string;
  severity: "error" | "warning" | "info";
  /** 0-indexed file-absolute line after edit tracking. undefined = no edit tracked. */
  adjustedLine?: number;
  /** true when the code on this line was modified -- re-analysis pending. */
  potentiallyRemediated?: boolean;
}

export interface FunctionData {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  description: string;
  params: { name: string; type: string; description: string }[];
  returns: { type: string; description: string };
  dataTags: string[];
  securityFlags: string[];
  issues: DetailedIssue[];
  practiceViolations: DetailedIssue[];
  language: string;
  entityType: string;
  communityTitle?: string;
}

export interface FileGroup {
  filePath: string;
  functions: FunctionData[];
}

export type ExtensionMessage =
  | { type: "showFunction"; data: FunctionData }
  | { type: "showHome"; data: FileGroup[] }
  | { type: "clear" };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "selectFunction"; fn: FunctionData }
  | { type: "backToHome" }
  | { type: "goToDefinition"; filePath: string; line: number; functionName: string }
  | { type: "refresh" };

// VS Code API type
export interface VSCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VSCodeApi;

function getVSCodeApi(): VSCodeApi | null {
  if (isBrowser) {
    return null; // Browser mode - no VS Code API
  }
  if (typeof acquireVsCodeApi === "function") {
    return acquireVsCodeApi();
  }
  return null;
}

// Singleton - VS Code API can only be acquired once
const vscode = getVSCodeApi();

/** Access the singleton VS Code API (null in browser mode) */
export function getVSCode(): VSCodeApi | null {
  return vscode;
}

export function useVSCode() {
  const [functionData, setFunctionData] = useState<FunctionData | null>(null);
  const [homeData, setHomeData] = useState<FileGroup[] | null>(null);
  const [view, setView] = useState<"home" | "detail" | "empty">("empty");
  const readySent = useRef(false);

  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionMessage>) => {
      const message = event.data;
      switch (message.type) {
        case "showFunction":
          setFunctionData(message.data);
          setView("detail");
          break;
        case "showHome":
          setHomeData(message.data);
          setFunctionData(null);
          setView("home");
          break;
        case "clear":
          setFunctionData(null);
          setHomeData(null);
          setView("empty");
          break;
      }
    };

    window.addEventListener("message", handler);

    // Tell extension we're ready (only once)
    if (vscode && !readySent.current) {
      readySent.current = true;
      vscode.postMessage({ type: "ready" });
    }

    return () => window.removeEventListener("message", handler);
  }, []);

  const goToDefinition = useCallback(
    (filePath: string, line: number, functionName?: string) => {
      vscode?.postMessage({
        type: "goToDefinition",
        filePath,
        line,
        functionName: functionName || "",
      });
    },
    []
  );

  const selectFunction = useCallback((fn: FunctionData) => {
    vscode?.postMessage({ type: "selectFunction", fn });
  }, []);

  const backToHome = useCallback(() => {
    vscode?.postMessage({ type: "backToHome" });
  }, []);

  const refresh = useCallback(() => {
    vscode?.postMessage({ type: "refresh" });
  }, []);

  return {
    functionData,
    homeData,
    view,
    goToDefinition,
    selectFunction,
    backToHome,
    refresh,
    isConnected: !!vscode,
  };
}
