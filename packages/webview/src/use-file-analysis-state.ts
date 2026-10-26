import { useState, useEffect } from "react";
import { useDataBridge } from "./data-bridge";

export type FileAnalysisState = "fresh" | "stale" | "analyzing";

/**
 * Tracks the analysis lifecycle state for a single file.
 *
 * Subscribes to file-level push events from the extension host:
 *   fileStale     → "stale"
 *   fileAnalyzing → "analyzing"
 *   fileAnalyzed  → "fresh"
 *   dbReloaded    → "fresh" (safety valve)
 *
 * Returns "fresh" if filePath is undefined (no file in view).
 * In browser dev mode, no push events fire, so it stays "fresh" (correct).
 */
export function useFileAnalysisState(
  filePath: string | undefined,
): FileAnalysisState {
  const bridge = useDataBridge();
  const [state, setState] = useState<FileAnalysisState>("fresh");

  useEffect(() => {
    if (!filePath) {
      setState("fresh");
      return;
    }

    // Reset to fresh when filePath changes (navigating to a different function)
    setState("fresh");

    return bridge.onPush((event) => {
      switch (event.type) {
        case "fileStale":
          if (event.filePath === filePath) setState("stale");
          break;
        case "fileAnalyzing":
          if (event.filePath === filePath) setState("analyzing");
          break;
        case "fileAnalyzed":
          if (event.filePath === filePath) setState("fresh");
          break;
        case "dbReloaded":
          // Safety valve: DB reload means fresh data is available.
          // This handles edge cases (SCAN_COMPLETE, manual DB changes).
          setState("fresh");
          break;
      }
    });
  }, [bridge, filePath]);

  return state;
}
