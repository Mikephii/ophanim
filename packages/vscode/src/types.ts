export interface DetailedIssue {
  flag: string;
  title: string;
  description: string;
  explanation: string;
  line: number;
  startText: string;
  endText: string;
  severity: "error" | "warning" | "info";
  lineText?: string;
}

export interface FunctionAnalysis {
  description: string;
  params: { name: string; type: string; description: string }[];
  returns: { type: string; description: string };
  dataTags: string[];
  securityFlags: string[];
  issues: DetailedIssue[];
  practiceViolations: DetailedIssue[];
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

export interface DbEntry {
  functionName: string;
  contentHash: string;
  analysis: FunctionAnalysis;
  language: string;
  entityType: string;
}

// Webview request/response protocol types (re-exported from webview-handler)
export type { DataRequest, DataResponse } from "./webview-handler";
