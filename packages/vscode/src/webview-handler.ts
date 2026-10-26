// Webview request/response handler for the extension host.
//
// Routes incoming DataRequest messages from the webview to the appropriate
// query implementation, and sends back DataResponse messages.
//
// Uses a single better-sqlite3 (native) database handle for all reads and writes
// on the local .ophan/index.db file.

import type BetterDatabase from "better-sqlite3";
import type { ExtensionStore } from "./store";
import {
  getNavCounts,
  getSecurityDashboardStats,
  getTopIssues,
  getSecurityIssues,
  dismissIssue,
  undismissIssue,
  getEnrichedFunctions,
  getEnrichedFunction,
  getAvailableLanguages,
  getArchitectureHierarchy,
  getCommunityDetail,
  getGroupDetail,
  getConcernDetail,
  getConcernsIndex,
  getPractices,
  resolveCurrentHash,
  getGraphData,
} from "./webview-queries";

export interface DataRequest {
  type: "request";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface DataResponse {
  type: "response";
  id: string;
  data?: unknown;
  error?: string;
}

/** Context for non-DB request handlers (store access, extension actions). */
export interface HandlerContext {
  store: ExtensionStore | null;
  onAnalyzeNow?: () => void;
  onOpenOutput?: () => void;
  onOpenFile?: (filePath: string) => Promise<void>;
}

/** Dispatch a webview request to the appropriate query handler */
export async function handleWebviewRequest(
  db: BetterDatabase.Database | null,
  message: DataRequest,
  context?: HandlerContext,
): Promise<DataResponse> {
  try {
    const data = await routeRequest(db, message.method, message.params, context);
    return { type: "response", id: message.id, data };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    return { type: "response", id: message.id, error };
  }
}

async function routeRequest(
  db: BetterDatabase.Database | null,
  method: string,
  params?: Record<string, unknown>,
  context?: HandlerContext,
): Promise<unknown> {
  // Status & action routes don't need DB
  switch (method) {
    case "getStatus":
      if (!context?.store) throw new Error("Store not available");
      return context.store.getStatusSnapshot();
    case "analyzeNow":
      context?.onAnalyzeNow?.();
      return null;
    case "openOutput":
      context?.onOpenOutput?.();
      return null;
    case "openFile":
      await context?.onOpenFile?.(params?.filePath as string);
      return null;
  }

  if (!db) {
    throw new Error("Database not loaded");
  }

  switch (method) {
    // Security dashboard
    case "getSecurityDashboardStats":
      return getSecurityDashboardStats(db);
    case "getTopIssues":
      return getTopIssues(db, (params?.limit as number) ?? 8);
    case "getDismissedIssues":
      return [];

    // Security issues
    case "getSecurityIssues":
      return getSecurityIssues(db, params as any);

    // Functions
    case "getEnrichedFunctions":
      return getEnrichedFunctions(db, params as any);
    case "getEnrichedFunction":
      return getEnrichedFunction(db, params?.contentHash as string);
    case "getAvailableLanguages":
      return getAvailableLanguages(db);
    case "resolveCurrentHash":
      return resolveCurrentHash(db, params?.functionName as string, params?.filePath as string);

    // Architecture
    case "getArchitectureHierarchy":
      return getArchitectureHierarchy(db);
    case "getCommunityDetail":
      return getCommunityDetail(db, params?.communityId as string);
    case "getGroupDetail":
      return getGroupDetail(db, params?.groupId as string);
    case "getConcernDetail":
      return getConcernDetail(db, params?.concernId as string);
    case "getConcernsIndex":
      return getConcernsIndex(db);

    // Graph
    case "getGraphData":
      return getGraphData(db);

    // Practices
    case "getPractices":
      return getPractices(db);

    // Actions (write to index.db via better-sqlite3)
    case "dismissIssue":
      dismissIssue(db, params as any);
      return null;
    case "undismissIssue":
      undismissIssue(db, params as any);
      return null;

    // Navigation counts
    case "getNavCounts":
      return getNavCounts(db);

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}
