import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderHook, act } from "@testing-library/react";
import { BrowserBridge, DataBridgeProvider } from "./data-bridge";
import { useFileAnalysisState } from "./use-file-analysis-state";

function setup(filePath: string | undefined) {
  const handler = vi.fn().mockResolvedValue(null);
  const bridge = new BrowserBridge(handler);

  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(DataBridgeProvider, { value: bridge }, children);

  const hook = renderHook(() => useFileAnalysisState(filePath), { wrapper });
  return { hook, bridge };
}

describe("useFileAnalysisState", () => {
  it("returns 'fresh' by default", () => {
    const { hook } = setup("/src/foo.ts");
    expect(hook.result.current).toBe("fresh");
  });

  it("returns 'fresh' when filePath is undefined", () => {
    const { hook } = setup(undefined);
    expect(hook.result.current).toBe("fresh");
  });

  it("transitions to 'stale' on fileStale event", () => {
    const { hook, bridge } = setup("/src/foo.ts");
    act(() => bridge.emit({ type: "fileStale", filePath: "/src/foo.ts" }));
    expect(hook.result.current).toBe("stale");
  });

  it("transitions to 'analyzing' on fileAnalyzing event", () => {
    const { hook, bridge } = setup("/src/foo.ts");
    act(() => bridge.emit({ type: "fileAnalyzing", filePath: "/src/foo.ts" }));
    expect(hook.result.current).toBe("analyzing");
  });

  it("transitions stale → analyzing → fresh", () => {
    const { hook, bridge } = setup("/src/foo.ts");

    act(() => bridge.emit({ type: "fileStale", filePath: "/src/foo.ts" }));
    expect(hook.result.current).toBe("stale");

    act(() => bridge.emit({ type: "fileAnalyzing", filePath: "/src/foo.ts" }));
    expect(hook.result.current).toBe("analyzing");

    act(() => bridge.emit({ type: "fileAnalyzed", filePath: "/src/foo.ts" }));
    expect(hook.result.current).toBe("fresh");
  });

  it("ignores events for different files", () => {
    const { hook, bridge } = setup("/src/foo.ts");
    act(() => bridge.emit({ type: "fileStale", filePath: "/src/bar.ts" }));
    expect(hook.result.current).toBe("fresh");
  });

  it("resets to fresh on dbReloaded from stale state", () => {
    const { hook, bridge } = setup("/src/foo.ts");

    act(() => bridge.emit({ type: "fileStale", filePath: "/src/foo.ts" }));
    expect(hook.result.current).toBe("stale");

    act(() => bridge.emit({ type: "dbReloaded" }));
    expect(hook.result.current).toBe("fresh");
  });

  it("resets to fresh on dbReloaded from analyzing state", () => {
    const { hook, bridge } = setup("/src/foo.ts");

    act(() => bridge.emit({ type: "fileAnalyzing", filePath: "/src/foo.ts" }));
    expect(hook.result.current).toBe("analyzing");

    act(() => bridge.emit({ type: "dbReloaded" }));
    expect(hook.result.current).toBe("fresh");
  });
});
