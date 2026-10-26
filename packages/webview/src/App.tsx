import { FC, useEffect, useMemo, useState, useCallback } from "react";
import { FunctionData, initBrowserDb, getFunctionsByFile, getDb } from "./data";
import { browserQueryHandler, setBrowserDb } from "./browser-queries";
import { useVSCode, getVSCode, type FileGroup, type FunctionData as VSCodeFunctionData } from "./useVSCode";
import { Logo } from "./components/Logo";
import { Header } from "./components/Header";
import { ViewRouter } from "./components/ViewRouter";
import { NavSheet } from "./components/NavSheet";
import { UpdatedToast } from "./components/UpdatedToast";
import { useNavigation, NavigationProvider, type ViewType } from "./navigation";
import {
  VSCodeBridge,
  BrowserBridge,
  DataBridgeProvider,
  type DataBridge,
} from "./data-bridge";

// Detect environment
const isBrowser = typeof acquireVsCodeApi === "undefined";
const repoPath = isBrowser
  ? new URLSearchParams(window.location.search).get("repo")
  : null;

// Use the shared singleton (acquired once in useVSCode.ts)
const vsCodeApi = getVSCode();

const App: FC = () => {
  const [loading, setLoading] = useState(isBrowser);
  const [error, setError] = useState<string | null>(null);
  // Legacy data state (used during transition)
  const [_functionsByFile, setFunctionsByFile] = useState<
    Map<string, FunctionData[]>
  >(new Map());
  const [selectedFunction, setSelectedFunction] =
    useState<VSCodeFunctionData | null>(null);

  // Navigation stack with state persistence
  const nav = useNavigation(
    vsCodeApi ? () => vsCodeApi!.getState() : undefined,
    vsCodeApi ? (s) => vsCodeApi!.setState(s) : undefined
  );

  // Create DataBridge based on mode
  const bridge = useMemo<DataBridge | null>(() => {
    if (!isBrowser && vsCodeApi) {
      return new VSCodeBridge(vsCodeApi);
    }
    // Browser bridge will be initialized after db loads
    return null;
  }, []);

  const [browserBridge, setBrowserBridge] = useState<BrowserBridge | null>(null);
  const activeBridge = bridge || browserBridge;

  // VS Code mode: get data from extension (legacy protocol)
  const {
    functionData,
    homeData,
    view,
    goToDefinition: _goToDefinition,
    selectFunction: _selectFunction,
  } = useVSCode();

  // Browser mode: load db on mount
  useEffect(() => {
    if (!isBrowser) return;

    if (!repoPath) {
      setError("Add ?repo=/path/to/your/project to the URL");
      setLoading(false);
      return;
    }

    initBrowserDb(repoPath)
      .then(() => {
        setFunctionsByFile(getFunctionsByFile());
        // Register db with browser queries and create bridge
        const database = getDb();
        if (database) setBrowserDb(database);
        const bb = new BrowserBridge(browserQueryHandler);
        setBrowserBridge(bb);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  // VS Code mode: handle legacy showFunction messages by pushing to nav stack
  useEffect(() => {
    if (functionData) {
      setSelectedFunction(functionData);
      nav.push({
        view: "function-detail",
        params: {
          contentHash: functionData.contentHash,
          name: functionData.name,
          filePath: functionData.filePath,
        },
      });
    }
  }, [functionData]); // eslint-disable-line react-hooks/exhaustive-deps

  // VS Code mode: handle showStatus message by resetting nav stack to status view
  useEffect(() => {
    if (!activeBridge) return;
    return activeBridge.onPush((event) => {
      if (event.type === "showStatus") {
        nav.reset({ view: "status", params: {} });
      }
    });
  }, [activeBridge]); // eslint-disable-line react-hooks/exhaustive-deps

  // VS Code mode: handle legacy showHome messages by resetting nav stack
  useEffect(() => {
    if (view === "home" && homeData) {
      const vscodeFunctionsByFile = new Map<string, FunctionData[]>(
        homeData.map((group: FileGroup) => [group.filePath, group.functions])
      );
      setFunctionsByFile(vscodeFunctionsByFile);
      // Only reset if we're not already on home
      if (nav.current.view !== "home") {
        nav.reset({ view: "home", params: {} });
      }
    }
  }, [view, homeData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nav sheet state
  const [navSheetOpen, setNavSheetOpen] = useState(false);

  // Escape key: close nav sheet first, then navigate back
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't interfere if an input/textarea is focused
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      // Let vaul Drawer handle its own Escape (it will set open=false)
      if (navSheetOpen) return;
      // Navigate back if possible
      if (nav.canGoBack) {
        e.preventDefault();
        nav.pop();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navSheetOpen, nav.canGoBack, nav.pop]);

  const handleNavSheetNavigate = useCallback(
    (view: ViewType) => {
      nav.reset({ view, params: {} });
    },
    [nav] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Loading state (browser only)
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-screen text-center text-muted-foreground">
        <Logo size={48} className="mb-4 opacity-40 animate-pulse" />
        <p className="text-sm">Loading database...</p>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen text-center text-muted-foreground">
        <Logo size={48} className="mb-4 opacity-40" />
        <h2 className="font-medium mb-1 text-foreground">Error</h2>
        <p className="text-sm">{error}</p>
      </div>
    );
  }

  // Main app with navigation
  const content = (
    <NavigationProvider value={nav}>
      <div className="flex flex-col h-screen">
        <Header
          route={nav.current}
          canGoBack={nav.canGoBack}
          onBack={nav.pop}
          onMenuOpen={() => setNavSheetOpen(true)}
        />
        <main className="flex-1 overflow-y-auto">
          <ViewRouter
            route={nav.current}
            legacyFunctionData={selectedFunction}
          />
        </main>
        <NavSheet
          open={navSheetOpen}
          onOpenChange={setNavSheetOpen}
          onNavigate={handleNavSheetNavigate}
          currentView={nav.current.view}
        />
        <UpdatedToast />
      </div>
    </NavigationProvider>
  );

  // Wrap in DataBridgeProvider if bridge is available
  if (activeBridge) {
    return (
      <DataBridgeProvider value={activeBridge}>
        {content}
      </DataBridgeProvider>
    );
  }

  return content;
};

export default App;
