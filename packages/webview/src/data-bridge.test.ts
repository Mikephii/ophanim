import { describe, it, expect, vi } from "vitest";
import { BrowserBridge, VSCodeBridge } from "./data-bridge";

describe("BrowserBridge", () => {
  it("delegates request to handler", async () => {
    const handler = vi.fn().mockResolvedValue({ count: 42 });
    const bridge = new BrowserBridge(handler);

    const result = await bridge.request("getNavCounts", { foo: "bar" });
    expect(result).toEqual({ count: 42 });
    expect(handler).toHaveBeenCalledWith("getNavCounts", { foo: "bar" });
  });

  it("propagates handler errors", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("query failed"));
    const bridge = new BrowserBridge(handler);

    await expect(bridge.request("bad")).rejects.toThrow("query failed");
  });

  it("supports onPush subscribe and unsubscribe", () => {
    const handler = vi.fn().mockResolvedValue(null);
    const bridge = new BrowserBridge(handler);
    const listener = vi.fn();

    const unsub = bridge.onPush(listener);
    bridge.emit({ type: "dbReloaded" });
    expect(listener).toHaveBeenCalledWith({ type: "dbReloaded" });

    unsub();
    bridge.emit({ type: "clear" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("emits file-level events", () => {
    const handler = vi.fn().mockResolvedValue(null);
    const bridge = new BrowserBridge(handler);
    const listener = vi.fn();

    bridge.onPush(listener);
    bridge.emit({ type: "fileStale", filePath: "/src/a.ts" });
    expect(listener).toHaveBeenCalledWith({ type: "fileStale", filePath: "/src/a.ts" });
  });

  it("emits to multiple listeners", () => {
    const handler = vi.fn().mockResolvedValue(null);
    const bridge = new BrowserBridge(handler);
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    bridge.onPush(listener1);
    bridge.onPush(listener2);
    bridge.emit({ type: "dbReloaded" });

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
  });
});

describe("VSCodeBridge", () => {
  it("sends request via postMessage and resolves on response", async () => {
    const mockApi = {
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    };
    const bridge = new VSCodeBridge(mockApi);

    // Start a request
    const promise = bridge.request("getNavCounts");

    // Get the request id from the postMessage call
    expect(mockApi.postMessage).toHaveBeenCalledTimes(1);
    const sentMessage = mockApi.postMessage.mock.calls[0][0] as any;
    expect(sentMessage.type).toBe("request");
    expect(sentMessage.method).toBe("getNavCounts");

    // Simulate response
    const event = new MessageEvent("message", {
      data: { type: "response", id: sentMessage.id, data: { count: 5 } },
    });
    window.dispatchEvent(event);

    const result = await promise;
    expect(result).toEqual({ count: 5 });
  });

  it("rejects on error response", async () => {
    const mockApi = {
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    };
    const bridge = new VSCodeBridge(mockApi);

    const promise = bridge.request("bad");
    const sentMessage = mockApi.postMessage.mock.calls[0][0] as any;

    const event = new MessageEvent("message", {
      data: { type: "response", id: sentMessage.id, error: "not found" },
    });
    window.dispatchEvent(event);

    await expect(promise).rejects.toThrow("not found");
  });

  it("dispatches push events to handlers", () => {
    const mockApi = {
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    };
    const bridge = new VSCodeBridge(mockApi);
    const handler = vi.fn();

    bridge.onPush(handler);

    const event = new MessageEvent("message", {
      data: { type: "dbReloaded" },
    });
    window.dispatchEvent(event);

    expect(handler).toHaveBeenCalledWith({ type: "dbReloaded" });
  });

  it("unsubscribes push handler", () => {
    const mockApi = {
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    };
    const bridge = new VSCodeBridge(mockApi);
    const handler = vi.fn();

    const unsub = bridge.onPush(handler);
    unsub();

    const event = new MessageEvent("message", {
      data: { type: "dbReloaded" },
    });
    window.dispatchEvent(event);

    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches file-level push events to handlers", () => {
    const mockApi = {
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    };
    const bridge = new VSCodeBridge(mockApi);
    const handler = vi.fn();

    bridge.onPush(handler);

    for (const type of ["fileStale", "fileAnalyzing", "fileAnalyzed"] as const) {
      const event = new MessageEvent("message", {
        data: { type, filePath: "/abs/src/foo.ts" },
      });
      window.dispatchEvent(event);
    }

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenCalledWith({ type: "fileStale", filePath: "/abs/src/foo.ts" });
    expect(handler).toHaveBeenCalledWith({ type: "fileAnalyzing", filePath: "/abs/src/foo.ts" });
    expect(handler).toHaveBeenCalledWith({ type: "fileAnalyzed", filePath: "/abs/src/foo.ts" });
  });

  it("dispatches statusChanged push event", () => {
    const mockApi = {
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    };
    const bridge = new VSCodeBridge(mockApi);
    const handler = vi.fn();

    bridge.onPush(handler);

    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "statusChanged" },
    }));

    expect(handler).toHaveBeenCalledWith({ type: "statusChanged" });
  });

  it("dispatches showStatus push event", () => {
    const mockApi = {
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    };
    const bridge = new VSCodeBridge(mockApi);
    const handler = vi.fn();

    bridge.onPush(handler);

    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "showStatus" },
    }));

    expect(handler).toHaveBeenCalledWith({ type: "showStatus" });
  });

  it("exposes vsCodeApi", () => {
    const mockApi = {
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    };
    const bridge = new VSCodeBridge(mockApi);
    expect(bridge.vsCodeApi).toBe(mockApi);
  });
});
