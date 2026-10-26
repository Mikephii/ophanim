import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderHook, act } from "@testing-library/react";
import {
  useNavigation,
  useNavigationContext,
  NavigationProvider,
  getViewTitle,
  isArchitectureView,
  type Route,
  type NavigationState,
} from "./navigation";

// Mock window.scrollTo
vi.stubGlobal("scrollTo", vi.fn());

describe("useNavigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts with home route by default", () => {
    const { result } = renderHook(() => useNavigation());
    expect(result.current.current).toEqual({ view: "home", params: {} });
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.depth).toBe(1);
  });

  it("pushes a route onto the stack", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => {
      result.current.push({ view: "function-detail", params: { contentHash: "abc123", filePath: "src/foo.ts" } });
    });

    expect(result.current.current.view).toBe("function-detail");
    expect(result.current.current.params.contentHash).toBe("abc123");
    expect(result.current.current.params.filePath).toBe("src/foo.ts");
    expect(result.current.canGoBack).toBe(true);
    expect(result.current.depth).toBe(2);
  });

  it("pops back to previous route", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => {
      result.current.push({ view: "function-detail", params: { contentHash: "abc", filePath: "src/bar.ts" } });
    });
    act(() => {
      result.current.pop();
    });

    expect(result.current.current.view).toBe("home");
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.depth).toBe(1);
  });

  it("does not pop below the root", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => {
      result.current.pop();
    });

    expect(result.current.current.view).toBe("home");
    expect(result.current.depth).toBe(1);
  });

  it("replaces the current route", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => {
      result.current.push({ view: "functions", params: {} });
    });
    act(() => {
      result.current.replace({ view: "security-issues", params: { flag: "xss" } });
    });

    expect(result.current.current.view).toBe("security-issues");
    expect(result.current.current.params.flag).toBe("xss");
    expect(result.current.depth).toBe(2); // Still 2, not 3
  });

  it("resets the stack to a single route", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => {
      result.current.push({ view: "functions", params: {} });
      result.current.push({ view: "function-detail", params: {} });
      result.current.push({ view: "security-learn", params: {} });
    });

    expect(result.current.depth).toBe(4);

    act(() => {
      result.current.reset({ view: "home", params: {} });
    });

    expect(result.current.depth).toBe(1);
    expect(result.current.current.view).toBe("home");
    expect(result.current.canGoBack).toBe(false);
  });

  it("enforces max depth of 20", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => {
      for (let i = 0; i < 25; i++) {
        result.current.push({ view: "functions", params: { i: String(i) } });
      }
    });

    expect(result.current.depth).toBe(20);
    // The most recent push should be current
    expect(result.current.current.params.i).toBe("24");
  });

  it("restores from persisted state", () => {
    const savedStack: Route[] = [
      { view: "home", params: {} },
      { view: "security-issues", params: { flag: "xss" } },
    ];

    const getState = vi.fn().mockReturnValue({ navigationStack: savedStack });
    const setState = vi.fn();

    const { result } = renderHook(() => useNavigation(getState, setState));

    expect(result.current.current.view).toBe("security-issues");
    expect(result.current.depth).toBe(2);
    expect(result.current.canGoBack).toBe(true);
  });

  it("persists stack changes via setState", () => {
    const getState = vi.fn().mockReturnValue(null);
    const setState = vi.fn();

    const { result } = renderHook(() => useNavigation(getState, setState));

    act(() => {
      result.current.push({ view: "functions", params: {} });
    });

    // setState should have been called with the updated stack
    expect(setState).toHaveBeenCalled();
    const lastCall = setState.mock.calls[setState.mock.calls.length - 1][0];
    expect(lastCall.navigationStack).toHaveLength(2);
    expect(lastCall.navigationStack[1].view).toBe("functions");
  });
});

describe("getViewTitle", () => {
  it("returns correct titles for each view type", () => {
    expect(getViewTitle({ view: "home", params: {} })).toBe("Ophan");
    expect(getViewTitle({ view: "status", params: {} })).toBe("Status");
    expect(getViewTitle({ view: "security-issues", params: {} })).toBe("Security Issues");
    expect(getViewTitle({ view: "functions", params: {} })).toBe("Functions");
    expect(getViewTitle({ view: "architecture", params: {} })).toBe("Architecture");
    expect(getViewTitle({ view: "settings", params: {} })).toBe("Practices");
  });

  it("uses params for dynamic titles", () => {
    expect(getViewTitle({ view: "function-detail", params: { name: "fetchUser" } })).toBe("fetchUser");
    expect(getViewTitle({ view: "community-detail", params: { title: "Auth Layer" } })).toBe("Auth Layer");
  });

  it("uses fallback for missing params", () => {
    expect(getViewTitle({ view: "function-detail", params: {} })).toBe("Function");
    expect(getViewTitle({ view: "community-detail", params: {} })).toBe("Community");
  });
});

describe("useNavigationContext", () => {
  it("returns navigation from provider", () => {
    const nav: NavigationState = {
      stack: [{ view: "home", params: {} }],
      current: { view: "home", params: {} },
      push: vi.fn(),
      pop: vi.fn(),
      replace: vi.fn(),
      reset: vi.fn(),
      canGoBack: false,
      depth: 1,
    };

    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(NavigationProvider, { value: nav }, children);

    const { result } = renderHook(() => useNavigationContext(), { wrapper });
    expect(result.current).toBe(nav);
  });

  it("throws without provider", () => {
    // Suppress console.error from React for expected throw
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => {
      renderHook(() => useNavigationContext());
    }).toThrow("useNavigationContext must be used within a NavigationProvider");
    spy.mockRestore();
  });
});

describe("isArchitectureView", () => {
  it("returns true for architecture views", () => {
    expect(isArchitectureView("architecture")).toBe(true);
    expect(isArchitectureView("community-detail")).toBe(true);
    expect(isArchitectureView("group-detail")).toBe(true);
    expect(isArchitectureView("concern-detail")).toBe(true);
    expect(isArchitectureView("concerns-index")).toBe(true);
  });

  it("returns false for non-architecture views", () => {
    expect(isArchitectureView("home")).toBe(false);
    expect(isArchitectureView("functions")).toBe(false);
    expect(isArchitectureView("security-issues")).toBe(false);
    expect(isArchitectureView("function-detail")).toBe(false);
    expect(isArchitectureView("settings")).toBe(false);
  });
});
