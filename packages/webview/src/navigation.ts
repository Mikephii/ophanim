// Stack-based navigation for the VS Code webview panel.
//
// Implements a mobile-style navigation stack where views are pushed/popped.
// No URL routing -- the stack is in-memory, persisted via vscode.getState/setState
// across panel hide/show cycles.

import { useState, useCallback, useEffect, useRef, createContext, useContext } from "react";

export type ViewType =
  | "home"
  | "status"
  | "security-issues"
  | "functions"
  | "function-detail"
  | "architecture"
  | "community-detail"
  | "group-detail"
  | "concern-detail"
  | "concerns-index"
  | "security-learn-index"
  | "security-learn"
  | "graph"
  | "settings";

export interface Route {
  view: ViewType;
  params: Record<string, string>;
  scrollY?: number;
}

const MAX_DEPTH = 20;
const DEFAULT_STACK: Route[] = [{ view: "home", params: {} }];

/** View type → display title for the header */
export function getViewTitle(route: Route): string {
  switch (route.view) {
    case "home":
      return "Ophan";
    case "status":
      return "Status";
    case "security-issues":
      return "Security Issues";
    case "functions":
      return "Functions";
    case "function-detail":
      return route.params.name || "Function";
    case "architecture":
      return "Architecture";
    case "community-detail":
      return route.params.title || "Community";
    case "group-detail":
      return route.params.title || "Group";
    case "concern-detail":
      return route.params.title || "Concern";
    case "concerns-index":
      return "Cross-Cutting Concerns";
    case "security-learn-index":
      return "Security Reference";
    case "security-learn":
      return route.params.title || "Security";
    case "graph":
      return "Graph Explorer";
    case "settings":
      return "Practices";
    default:
      return "Ophan";
  }
}

/** Check if a view is within the architecture section (for drawer toggle) */
export function isArchitectureView(view: ViewType): boolean {
  return (
    view === "architecture" ||
    view === "community-detail" ||
    view === "group-detail" ||
    view === "concern-detail" ||
    view === "concerns-index"
  );
}

export interface NavigationState {
  stack: Route[];
  current: Route;
  push: (route: Route) => void;
  pop: () => void;
  replace: (route: Route) => void;
  reset: (route: Route) => void;
  canGoBack: boolean;
  depth: number;
}

// --- React Context ---

const NavigationContext = createContext<NavigationState | null>(null);

/** Wrap children to share a single navigation instance. */
export const NavigationProvider = NavigationContext.Provider;

/** Read navigation from the nearest NavigationProvider. Throws if none found. */
export function useNavigationContext(): NavigationState {
  const ctx = useContext(NavigationContext);
  if (!ctx) {
    throw new Error(
      "useNavigationContext must be used within a NavigationProvider"
    );
  }
  return ctx;
}

interface PersistedWebviewState {
  navigationStack?: Route[];
}

export function useNavigation(
  getState?: () => unknown,
  setState?: (state: unknown) => void
): NavigationState {
  const [stack, setStack] = useState<Route[]>(() => {
    // Restore from persisted state if available
    if (getState) {
      const saved = getState() as PersistedWebviewState | null;
      if (saved?.navigationStack && saved.navigationStack.length > 0) {
        return saved.navigationStack;
      }
    }
    return DEFAULT_STACK;
  });

  const stackRef = useRef(stack);
  stackRef.current = stack;

  // Persist stack changes
  useEffect(() => {
    if (setState) {
      const current = (getState?.() as PersistedWebviewState) || {};
      setState({ ...current, navigationStack: stack });
    }
  }, [stack, setState, getState]);

  const push = useCallback((route: Route) => {
    setStack((prev) => {
      // Save current scroll position before pushing
      const updated = [...prev];
      if (updated.length > 0) {
        const last = updated[updated.length - 1];
        updated[updated.length - 1] = { ...last, scrollY: window.scrollY };
      }
      updated.push(route);
      // Enforce max depth
      if (updated.length > MAX_DEPTH) {
        updated.shift();
      }
      return updated;
    });
    // Scroll to top for new view
    window.scrollTo(0, 0);
  }, []);

  const pop = useCallback(() => {
    setStack((prev) => {
      if (prev.length <= 1) return prev;
      const updated = prev.slice(0, -1);
      // Restore scroll position
      const restored = updated[updated.length - 1];
      if (restored?.scrollY != null) {
        requestAnimationFrame(() => window.scrollTo(0, restored.scrollY!));
      }
      return updated;
    });
  }, []);

  const replace = useCallback((route: Route) => {
    setStack((prev) => {
      if (prev.length === 0) return [route];
      return [...prev.slice(0, -1), route];
    });
  }, []);

  const reset = useCallback((route: Route) => {
    setStack([route]);
    window.scrollTo(0, 0);
  }, []);

  const current = stack[stack.length - 1] || DEFAULT_STACK[0];

  return {
    stack,
    current,
    push,
    pop,
    replace,
    reset,
    canGoBack: stack.length > 1,
    depth: stack.length,
  };
}
