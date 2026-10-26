// Community summarization module -- generates rich narrative documentation for
// detected function communities using Claude.
//
// Architecture:
//   1. Graph module detects communities → communities table
//   2. This module gathers context for each community (function analysis + edges)
//   3. Sends context to Claude with prompt asking for markdown documentation
//   4. Stores results in community_summaries table with input_hash for caching
//   5. Hierarchical: L1 (subsystem) → L2 (system) → L3 (architecture)
//
// Caching: input_hash = SHA256 of sorted member content hashes. Same members
// = same hash = skip re-summarization. Changes propagate up: if L1 changes,
// L2's input_hash changes too.

import type Database from "better-sqlite3";
import pLimit from "p-limit";
import { callClaude, getModel } from "./claude";
import { computeHash } from "./shared";
import {
  L1Summary,
  L2Summary,
  L3Summary,
  CrossCuttingConcernSummary,
  DATA_TAG_LABELS,
  SECURITY_FLAG_LABELS,
  type L1Summary as L1SummaryType,
  type L2Summary as L2SummaryType,
  type L3Summary as L3SummaryType,
  type CrossCuttingConcernSummary as CrossCuttingConcernSummaryType,
} from "./schemas";
import { buildGraph, computeCentrality, computePackage, type FunctionEdge, type ModuleResolver } from "./graph";

// ============ PACKAGE BREAKDOWN ============

export function computePackageBreakdown(
  members: { filePath: string }[],
  rootPath: string,
  resolver?: ModuleResolver
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of members) {
    const pkg = computePackage(m.filePath, rootPath, resolver);
    counts[pkg] = (counts[pkg] || 0) + 1;
  }
  return counts;
}

export function formatPackageBreakdown(breakdown: Record<string, number>): string {
  const total = Object.values(breakdown).reduce((sum, c) => sum + c, 0);
  if (total === 0) return "";
  return Object.entries(breakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([pkg, count]) => `${pkg} (${Math.round((count / total) * 100)}%)`)
    .join(", ");
}

// ============ TYPES ============

export interface MemberContext {
  contentHash: string;
  functionName: string;
  filePath: string;
  language: string;
  entityType: string;
  description: string;
  params: { name: string; type: string; description: string }[];
  returns: { type: string; description: string };
  dataTags: string[];
  securityFlags: string[];
  callsTo: string[];
  calledBy: string[];
}

export interface L1CommunityContext {
  communityId: string;
  algorithm: string;
  members: MemberContext[];
  inputHash: string;
  internalEdges: { from: string; to: string; type: string }[];
  packageInfo?: string;
}

export interface L2CommunityContext {
  communityId: string;
  algorithm: string;
  l1Summaries: { communityId: string; title: string; documentation: string; packageInfo?: string }[];
  crossEdges: { fromCommunity: string; toCommunity: string; count: number }[];
  inputHash: string;
}

export interface CrossCuttingConcern {
  tag: string;
  concernType: "data_flow" | "security";
  bridgeFunctions: { contentHash: string; functionName: string; communityId: string; centrality: number }[];
  affectedCommunities: { communityId: string; communityTitle: string }[];
  crossEdgeCount: number;
}

export interface StoredSummary {
  communityId: string;
  level: number;
  algorithm: string;
  inputHash: string;
  summary: unknown;
  modelVersion: string;
  createdAt: number;
}

export interface SummarizeConfig {
  algorithm: string;
  skipUnanalyzed: boolean;
}

export const DEFAULT_SUMMARIZE_CONFIG: SummarizeConfig = {
  algorithm: "louvain",
  skipUnanalyzed: true,
};

export interface SummarizeResult {
  l1Summarized: number;
  l1Cached: number;
  l1DriftSkipped: number;
  l1Failed?: number;
  l2Summarized: number;
  l2Cached: number;
  l3Summarized: number;
  l3Cached: number;
  ccDetected: number;
  ccSummarized: number;
  ccCached: number;
}

export interface SummarizeOptions {
  config?: Partial<SummarizeConfig>;
  onProgress?: (step: string) => void;
  /** When provided, L1 prompts use raw function source code instead of analysis metadata */
  sourceMap?: Map<string, string>;
  /** Repository root path -- enables package-aware labeling in prompts */
  rootPath?: string;
  /** Injectable for testing -- overrides actual Claude calls */
  _summarizeL1?: (context: L1CommunityContext) => Promise<L1SummaryType>;
  _summarizeL2?: (context: L2CommunityContext) => Promise<L2SummaryType>;
  _summarizeL3?: (l2Summaries: L2SummaryType[]) => Promise<L3SummaryType>;
  _summarizeCC?: (concern: CrossCuttingConcern, communityDocs: Map<string, string>) => Promise<CrossCuttingConcernSummaryType>;
}

// ============ INPUT HASH COMPUTATION ============

export function computeL1InputHash(memberHashes: string[], rawSource = false): string {
  const sorted = [...memberHashes].sort();
  const prefix = rawSource ? "RAW:" : "";
  return computeHash(prefix + sorted.join(","));
}

export function computeL2InputHash(l1InputHashes: string[]): string {
  const sorted = [...l1InputHashes].sort();
  return computeHash("L2:" + sorted.join(","));
}

export function computeL3InputHash(l2InputHashes: string[]): string {
  const sorted = [...l2InputHashes].sort();
  return computeHash("L3:" + sorted.join(","));
}

export function computeCCInputHash(concern: CrossCuttingConcern): string {
  const sortedHashes = [...concern.bridgeFunctions.map((b) => b.contentHash)].sort();
  const sortedCommunities = [...concern.affectedCommunities.map((c) => c.communityId)].sort();
  return computeHash("CC:" + concern.tag + ":" + sortedHashes.join(",") + ":" + sortedCommunities.join(","));
}

// ============ SIGNATURE DRIFT (Gate 2) ============

export interface FunctionSignature {
  name: string;
  paramCount: number;
}

export function storeCommunitySignatures(
  db: Database.Database,
  communityId: string,
  algorithm: string,
  members: MemberContext[]
): void {
  const signatures: FunctionSignature[] = members.map((m) => ({
    name: m.functionName,
    paramCount: m.params.length,
  }));
  db.prepare(`
    INSERT OR REPLACE INTO community_signatures (community_id, algorithm, signatures)
    VALUES (?, ?, ?)
  `).run(communityId, algorithm, JSON.stringify(signatures));
}

export function loadCommunitySignatures(
  db: Database.Database,
  communityId: string,
  algorithm: string
): FunctionSignature[] | null {
  // Table may not exist in older databases
  const hasTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='community_signatures'"
  ).get();
  if (!hasTable) return null;

  const row = db.prepare(
    "SELECT signatures FROM community_signatures WHERE community_id = ? AND algorithm = ?"
  ).get(communityId, algorithm) as { signatures: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.signatures) as FunctionSignature[];
}

/**
 * Determine if a community has meaningfully changed by comparing function signatures.
 * Returns true if the community should be re-summarized.
 *
 * A community is "drifted" if:
 * - >threshold of members were added or removed (by name)
 * - >threshold of surviving members changed param count
 */
export function hasCommunityDrifted(
  oldSigs: FunctionSignature[],
  newMembers: MemberContext[],
  threshold = 0.20
): boolean {
  if (oldSigs.length === 0) return true;

  const oldNames = new Set(oldSigs.map((s) => s.name));
  const newNames = new Set(newMembers.map((m) => m.functionName));

  // Count added/removed
  let added = 0;
  for (const name of newNames) {
    if (!oldNames.has(name)) added++;
  }
  let removed = 0;
  for (const name of oldNames) {
    if (!newNames.has(name)) removed++;
  }
  const membershipChange = (added + removed) / oldSigs.length;
  if (membershipChange > threshold) return true;

  // Count drifted among surviving members (param count changed)
  const oldMap = new Map(oldSigs.map((s) => [s.name, s]));
  let driftedCount = 0;
  for (const member of newMembers) {
    const old = oldMap.get(member.functionName);
    if (!old) continue;
    if (old.paramCount !== member.params.length) driftedCount++;
  }
  if (driftedCount / oldSigs.length > threshold) return true;

  return false;
}

// ============ STORAGE ============

export function storeSummary(
  db: Database.Database,
  communityId: string,
  level: number,
  algorithm: string,
  inputHash: string,
  summary: object,
  modelVersion: string
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT OR REPLACE INTO community_summaries
    (community_id, level, algorithm, input_hash, summary, model_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(communityId, level, algorithm, inputHash, JSON.stringify(summary), modelVersion, now);
}

export function loadSummary(
  db: Database.Database,
  communityId: string,
  level: number,
  algorithm: string
): StoredSummary | null {
  const row = db.prepare(`
    SELECT community_id, level, algorithm, input_hash, summary, model_version, created_at
    FROM community_summaries
    WHERE community_id = ? AND level = ? AND algorithm = ?
  `).get(communityId, level, algorithm) as {
    community_id: string; level: number; algorithm: string;
    input_hash: string; summary: string; model_version: string; created_at: number;
  } | undefined;

  if (!row) return null;
  return {
    communityId: row.community_id,
    level: row.level,
    algorithm: row.algorithm,
    inputHash: row.input_hash,
    summary: JSON.parse(row.summary),
    modelVersion: row.model_version,
    createdAt: row.created_at,
  };
}

export function loadAllSummaries(
  db: Database.Database,
  algorithm: string,
  level: number
): StoredSummary[] {
  const rows = db.prepare(`
    SELECT community_id, level, algorithm, input_hash, summary, model_version, created_at
    FROM community_summaries
    WHERE algorithm = ? AND level = ?
  `).all(algorithm, level) as {
    community_id: string; level: number; algorithm: string;
    input_hash: string; summary: string; model_version: string; created_at: number;
  }[];

  return rows.map((row) => ({
    communityId: row.community_id,
    level: row.level,
    algorithm: row.algorithm,
    inputHash: row.input_hash,
    summary: JSON.parse(row.summary),
    modelVersion: row.model_version,
    createdAt: row.created_at,
  }));
}

/**
 * Delete community_summaries rows at a given level whose community_id
 * is NOT in the activeIds set. Called after each summarization level
 * to remove orphans from previous runs.
 */
export function cleanupOrphanedSummaries(
  db: Database.Database,
  algorithm: string,
  level: number,
  activeIds: Set<string>
): void {
  if (activeIds.size === 0) {
    // No active IDs means we didn't process this level at all -- delete everything
    db.prepare(
      "DELETE FROM community_summaries WHERE algorithm = ? AND level = ?"
    ).run(algorithm, level);
    return;
  }

  const placeholders = [...activeIds].map(() => "?").join(",");
  db.prepare(
    `DELETE FROM community_summaries WHERE algorithm = ? AND level = ? AND community_id NOT IN (${placeholders})`
  ).run(algorithm, level, ...activeIds);
}

// ============ CONTEXT BUILDING ============

/**
 * Resolve internal edges for a community's members.
 * Finds all function_edges where both endpoints are in the member set,
 * and populates callsTo/calledBy arrays on member contexts.
 */
function resolveInternalEdges(
  db: Database.Database,
  memberHashSet: Set<string>,
  memberContexts: MemberContext[]
): L1CommunityContext["internalEdges"] {
  const hashToName = new Map(memberContexts.map((m) => [m.contentHash, m.functionName]));
  const internalEdges: L1CommunityContext["internalEdges"] = [];

  const edges = db.prepare(
    "SELECT source_hash, target_hash, edge_type FROM function_edges"
  ).all() as { source_hash: string; target_hash: string; edge_type: string }[];

  for (const edge of edges) {
    if (memberHashSet.has(edge.source_hash) && memberHashSet.has(edge.target_hash)) {
      const fromName = hashToName.get(edge.source_hash);
      const toName = hashToName.get(edge.target_hash);
      if (fromName && toName) {
        internalEdges.push({ from: fromName, to: toName, type: edge.edge_type });
        if (edge.edge_type === "call") {
          const fromCtx = memberContexts.find((m) => m.contentHash === edge.source_hash);
          const toCtx = memberContexts.find((m) => m.contentHash === edge.target_hash);
          if (fromCtx && !fromCtx.callsTo.includes(toName)) fromCtx.callsTo.push(toName);
          if (toCtx && !toCtx.calledBy.includes(fromName)) toCtx.calledBy.push(fromName);
        }
      }
    }
  }

  return internalEdges;
}

export function buildL1Context(
  db: Database.Database,
  communityId: string,
  algorithm: string,
  rootPath?: string
): L1CommunityContext | null {
  const members = db.prepare(
    "SELECT content_hash FROM communities WHERE community_id = ? AND level = 0 AND algorithm = ?"
  ).all(communityId, algorithm) as { content_hash: string }[];

  if (members.length === 0) return null;

  const memberHashes = members.map((m) => m.content_hash);
  const memberHashSet = new Set(memberHashes);

  const getFnInfo = db.prepare(
    "SELECT function_name, file_path, language, entity_type FROM file_functions WHERE content_hash = ? LIMIT 1"
  );
  const getAnalysis = db.prepare(
    "SELECT analysis_type, analysis FROM function_analysis WHERE content_hash = ?"
  );

  const memberContexts: MemberContext[] = [];

  for (const hash of memberHashes) {
    const fnInfo = getFnInfo.get(hash) as {
      function_name: string; file_path: string; language: string; entity_type: string;
    } | undefined;

    if (!fnInfo) continue;

    const analysisRows = getAnalysis.all(hash) as { analysis_type: string; analysis: string }[];
    let doc: Record<string, unknown> = {};
    let sec: Record<string, unknown> = {};
    for (const row of analysisRows) {
      const parsed = JSON.parse(row.analysis);
      if (row.analysis_type === "documentation") doc = parsed;
      else if (row.analysis_type === "security") sec = parsed;
    }

    memberContexts.push({
      contentHash: hash,
      functionName: fnInfo.function_name,
      filePath: fnInfo.file_path,
      language: fnInfo.language,
      entityType: fnInfo.entity_type,
      description: (doc.description as string) || "",
      params: (doc.params as MemberContext["params"]) || [],
      returns: (doc.returns as MemberContext["returns"]) || { type: "unknown", description: "" },
      dataTags: (sec.dataTags as string[]) || [],
      securityFlags: (sec.securityFlags as string[]) || [],
      callsTo: [],
      calledBy: [],
    });
  }

  if (memberContexts.length === 0) return null;

  const internalEdges = resolveInternalEdges(db, memberHashSet, memberContexts);

  return {
    communityId,
    algorithm,
    members: memberContexts,
    inputHash: computeL1InputHash(memberHashes),
    internalEdges,
    packageInfo: rootPath
      ? formatPackageBreakdown(computePackageBreakdown(memberContexts, rootPath))
      : undefined,
  };
}

/**
 * Build L1 context using raw function source code instead of analysis metadata.
 * Used when --raw-source flag is set. Source code comes from the sourceMap
 * (contentHash → sourceCode) which is built from FunctionInfo[] during extraction.
 */
export function buildL1RawContext(
  db: Database.Database,
  communityId: string,
  algorithm: string,
  sourceMap: Map<string, string>,
  rootPath?: string
): L1CommunityContext | null {
  const members = db.prepare(
    "SELECT content_hash FROM communities WHERE community_id = ? AND level = 0 AND algorithm = ?"
  ).all(communityId, algorithm) as { content_hash: string }[];

  if (members.length === 0) return null;

  const memberHashes = members.map((m) => m.content_hash);
  const memberHashSet = new Set(memberHashes);

  const getFnInfo = db.prepare(
    "SELECT function_name, file_path, language, entity_type FROM file_functions WHERE content_hash = ? LIMIT 1"
  );
  const getAnalysis = db.prepare(
    "SELECT analysis_type, analysis FROM function_analysis WHERE content_hash = ?"
  );

  const memberContexts: MemberContext[] = [];

  for (const hash of memberHashes) {
    const fnInfo = getFnInfo.get(hash) as {
      function_name: string; file_path: string; language: string; entity_type: string;
    } | undefined;
    if (!fnInfo) continue;

    const source = sourceMap.get(hash);
    if (!source) continue;

    // Load security analysis if available (still useful for meta even in raw-source mode)
    const analysisRows = getAnalysis.all(hash) as { analysis_type: string; analysis: string }[];
    let sec: Record<string, unknown> = {};
    for (const row of analysisRows) {
      if (row.analysis_type === "security") sec = JSON.parse(row.analysis);
    }

    memberContexts.push({
      contentHash: hash,
      functionName: fnInfo.function_name,
      filePath: fnInfo.file_path,
      language: fnInfo.language,
      entityType: fnInfo.entity_type,
      description: source, // Raw source code instead of analysis description
      params: [],
      returns: { type: "", description: "" },
      dataTags: (sec.dataTags as string[]) || [],
      securityFlags: (sec.securityFlags as string[]) || [],
      callsTo: [],
      calledBy: [],
    });
  }

  if (memberContexts.length === 0) return null;

  const internalEdges = resolveInternalEdges(db, memberHashSet, memberContexts);

  return {
    communityId,
    algorithm,
    members: memberContexts,
    inputHash: computeL1InputHash(memberHashes, true),
    internalEdges,
    packageInfo: rootPath
      ? formatPackageBreakdown(computePackageBreakdown(memberContexts, rootPath))
      : undefined,
  };
}

// ============ PROMPT TEMPLATES ============

const MODEL_VERSION = getModel();

function buildL1Prompt(context: L1CommunityContext): string {
  const memberDescriptions = context.members.map((m) => {
    let desc = `### ${m.functionName} (${m.filePath})`;
    if (m.description) desc += `\n${m.description}`;
    if (m.params.length > 0) {
      desc += `\nParams: ${m.params.map((p) => `${p.name}: ${p.type}`).join(", ")}`;
    }
    if (m.returns.type !== "unknown") desc += `\nReturns: ${m.returns.type} — ${m.returns.description}`;
    if (m.dataTags.length > 0) desc += `\nData tags: ${m.dataTags.join(", ")}`;
    if (m.securityFlags.length > 0) desc += `\nSecurity flags: ${m.securityFlags.join(", ")}`;
    if (m.callsTo.length > 0) desc += `\nCalls: ${m.callsTo.join(", ")}`;
    if (m.calledBy.length > 0) desc += `\nCalled by: ${m.calledBy.join(", ")}`;
    return desc;
  }).join("\n\n");

  const edgesSummary = context.internalEdges.length > 0
    ? `\nInternal relationships:\n${context.internalEdges.map(
        (e) => `  ${e.from} -> ${e.to} (${e.type})`
      ).join("\n")}`
    : "";

  const count = context.members.length;
  const lengthGuidance = count <= 5
    ? "This is a small group — keep the documentation concise (150-250 words)."
    : count <= 10
    ? "This is a medium group — write moderately detailed documentation (300-600 words)."
    : "This is a large, complex group — write thorough documentation (500-1000 words).";

  const packageLine = context.packageInfo
    ? `\nPackage distribution: ${context.packageInfo}\n`
    : "";

  return `You are a senior engineer writing internal documentation for your team. A group of ${count} functions have been identified as a cohesive subsystem based on their call relationships and co-location in code.

Write documentation that helps a junior engineer understand what this subsystem does, how it works, and what to watch out for. ${lengthGuidance}
${packageLine}
${memberDescriptions}
${edgesSummary}

Return a JSON object with exactly these fields:
- "title": string — short descriptive name for this subsystem (2-5 words, e.g. "Authentication Flow", "Database Connection Pool")
- "documentation": string — rich markdown documentation. Use ## for the title, ### for sections like "How It Works", "Key Functions", "Data Flow", "Security Notes" as appropriate. Write in a clear, helpful tone.
- "meta": object with:
  - "securityPosture": string — one sentence about security characteristics (or "" if none)
  - "dataClassification": string[] — what kind of data this handles (e.g. ["credentials", "pii"])
  - "boundaries": string[] — external systems or interfaces (e.g. ["database", "external API"])
  - "keyFunctions": string[] — names of the 2-3 most important functions
  - "complexity": "low" | "medium" | "high"

CRITICAL: Return ONLY the raw JSON object. No markdown code fences, no explanation. Just the { ... } object directly.`;
}

function buildL1RawPrompt(context: L1CommunityContext): string {
  const memberCode = context.members.map((m) => {
    const lang = m.language || "typescript";
    return `### ${m.functionName} (${m.filePath})\n\`\`\`${lang}\n${m.description}\n\`\`\``;
  }).join("\n\n");

  const edgesSummary = context.internalEdges.length > 0
    ? `\nInternal call relationships:\n${context.internalEdges.map(
        (e) => `  ${e.from} -> ${e.to} (${e.type})`
      ).join("\n")}`
    : "";

  const count = context.members.length;
  const lengthGuidance = count <= 5
    ? "This is a small group — keep the documentation concise (200-350 words)."
    : count <= 10
    ? "This is a medium group — write moderately detailed documentation (400-700 words)."
    : "This is a large, complex group — write thorough documentation (600-1200 words).";

  const packageLine = context.packageInfo
    ? `\nPackage distribution: ${context.packageInfo}\n`
    : "";

  return `You are a senior engineer writing internal documentation for your team. A group of ${count} functions have been identified as a cohesive subsystem based on their call relationships and co-location in code.

Analyze the source code below and write documentation that helps a junior engineer understand what this subsystem does, how it works, and what to watch out for. ${lengthGuidance}
${packageLine}
${memberCode}
${edgesSummary}

Return a JSON object with exactly these fields:
- "title": string — short descriptive name for this subsystem (2-5 words, e.g. "Authentication Flow", "Database Connection Pool")
- "documentation": string — rich markdown documentation. Use ## for the title, ### for sections like "How It Works", "Key Functions", "Data Flow", "Security Notes" as appropriate. Write in a clear, helpful tone.
- "meta": object with:
  - "securityPosture": string — one sentence about security characteristics (or "" if none)
  - "dataClassification": string[] — what kind of data this handles (e.g. ["credentials", "pii"])
  - "boundaries": string[] — external systems or interfaces (e.g. ["database", "external API"])
  - "keyFunctions": string[] — names of the 2-3 most important functions
  - "complexity": "low" | "medium" | "high"

CRITICAL: Return ONLY the raw JSON object. No markdown code fences, no explanation. Just the { ... } object directly.`;
}

function buildL2Prompt(context: L2CommunityContext): string {
  const subsystemDocs = context.l1Summaries.map((s) => {
    const pkgLine = s.packageInfo ? ` [${s.packageInfo}]` : "";
    return `### ${s.title}${pkgLine}\n${s.documentation}`;
  }).join("\n\n---\n\n");

  const crossEdges = context.crossEdges.length > 0
    ? `\nCross-subsystem connections:\n${context.crossEdges.map(
        (e) => `  ${e.fromCommunity} <-> ${e.toCommunity} (${e.count} connections)`
      ).join("\n")}`
    : "";

  return `You are a senior engineer writing system-level documentation that serves as a **standalone overview page** for a group of related subsystems. ${context.l1Summaries.length} subsystems have been identified as working together to form a larger system.

This documentation will be displayed as the top-level page for this system group, with links to each subsystem's detailed documentation below it. Write it as a comprehensive overview that orients a reader BEFORE they drill into subsystem details.

Below is the documentation for each subsystem:

${subsystemDocs}
${crossEdges}

Write documentation that helps a junior engineer understand:
1. What this system group does overall (high-level purpose)
2. How the subsystems relate to each other (which depends on which, data flow between them)
3. Key architectural patterns and boundaries
4. What to understand before diving into any individual subsystem

Return a JSON object with exactly these fields:
- "title": string — short descriptive name for this system (2-5 words)
- "documentation": string — rich markdown documentation. Use ## for the title, ### for sections like "Overview", "How Subsystems Connect", "Data Flow", "Key Patterns", "Security Considerations". This should work as a standalone page.
- "meta": object with:
  - "securityPosture": string — system-level security assessment
  - "dataClassification": string[] — aggregate data types handled
  - "boundaries": string[] — external interfaces of the system
  - "keyFunctions": string[] — most important functions across subsystems
  - "complexity": "low" | "medium" | "high"

CRITICAL: Return ONLY the raw JSON object. No markdown code fences, no explanation.`;
}

function buildL3Prompt(l2Summaries: L2SummaryType[]): string {
  const systemDocs = l2Summaries.map((s) => {
    return `### ${s.title}\n${s.documentation}`;
  }).join("\n\n---\n\n");

  return `You are a senior engineer writing the **top-level architecture overview page** for a codebase. This will be the first page a new team member reads. The codebase has ${l2Summaries.length} major system(s).

Below is the documentation for each system:

${systemDocs}

Write an architecture overview that serves as a standalone landing page. It should:
1. Explain what this software does in 1-2 sentences
2. Describe the major systems and how they're organized
3. Explain key architectural decisions and patterns
4. Cover cross-cutting concerns (security, data flow, shared infrastructure)
5. Guide a new team member on where to start reading

Return a JSON object with exactly these fields:
- "title": string — name for this architecture (e.g. "Ophan Security Analysis Platform")
- "documentation": string — rich markdown architecture overview. Use ## for the title, ### for sections like "Overview", "Major Systems", "Architecture Decisions", "Cross-Cutting Concerns", "Getting Started". This is a standalone page.
- "meta": object with:
  - "securityPosture": string — overall security assessment
  - "dataClassification": string[] — all data types handled across the codebase
  - "boundaries": string[] — all external interfaces
  - "keyFunctions": string[] — most critical functions in the codebase
  - "complexity": "low" | "medium" | "high"

CRITICAL: Return ONLY the raw JSON object. No markdown code fences, no explanation.`;
}

// ============ CLAUDE CALLERS ============

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    if (obj.message) return String(obj.message);
    if (obj.error && typeof obj.error === "object") {
      const inner = obj.error as Record<string, unknown>;
      return inner.message ? String(inner.message) : JSON.stringify(obj.error);
    }
    if (obj.status) return `HTTP ${obj.status}${obj.type ? ` (${obj.type})` : ""}`;
    return JSON.stringify(err);
  }
  return String(err);
}

async function callSummaryModel(prompt: string): Promise<string> {
  const text = await callClaude({ prompt, maxTokens: 16000 });
  return text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

export async function summarizeL1(context: L1CommunityContext): Promise<L1SummaryType> {
  const text = await callSummaryModel(buildL1Prompt(context));
  try {
    return L1Summary.parse(JSON.parse(text));
  } catch {
    return L1Summary.parse({});
  }
}

export async function summarizeL1Raw(context: L1CommunityContext): Promise<L1SummaryType> {
  const text = await callSummaryModel(buildL1RawPrompt(context));
  try {
    return L1Summary.parse(JSON.parse(text));
  } catch {
    return L1Summary.parse({});
  }
}

export async function summarizeL2(context: L2CommunityContext): Promise<L2SummaryType> {
  const text = await callSummaryModel(buildL2Prompt(context));
  try {
    return L2Summary.parse(JSON.parse(text));
  } catch {
    return L2Summary.parse({});
  }
}

export async function summarizeL3(summaries: L2SummaryType[]): Promise<L3SummaryType> {
  const text = await callSummaryModel(buildL3Prompt(summaries));
  try {
    return L3Summary.parse(JSON.parse(text));
  } catch {
    return L3Summary.parse({});
  }
}

// ============ CROSS-EDGE COMPUTATION ============

function computeCrossEdges(
  db: Database.Database,
  l1Summaries: { communityId: string; title: string }[],
  algorithm: string
): L2CommunityContext["crossEdges"] {
  const hashToCommunity = new Map<string, string>();
  for (const { communityId } of l1Summaries) {
    const members = db.prepare(
      "SELECT content_hash FROM communities WHERE community_id = ? AND level = 0 AND algorithm = ?"
    ).all(communityId, algorithm) as { content_hash: string }[];
    for (const { content_hash } of members) {
      hashToCommunity.set(content_hash, communityId);
    }
  }

  const crossCounts = new Map<string, number>();
  const edges = db.prepare(
    "SELECT source_hash, target_hash FROM function_edges"
  ).all() as { source_hash: string; target_hash: string }[];

  const communityTitles = new Map(l1Summaries.map((s) => [s.communityId, s.title]));

  for (const { source_hash, target_hash } of edges) {
    const fromCommunity = hashToCommunity.get(source_hash);
    const toCommunity = hashToCommunity.get(target_hash);
    if (fromCommunity && toCommunity && fromCommunity !== toCommunity) {
      const key = [fromCommunity, toCommunity].sort().join("|");
      crossCounts.set(key, (crossCounts.get(key) || 0) + 1);
    }
  }

  return [...crossCounts.entries()].map(([key, count]) => {
    const [a, b] = key.split("|");
    return {
      fromCommunity: communityTitles.get(a) || a,
      toCommunity: communityTitles.get(b) || b,
      count,
    };
  });
}

// ============ CROSS-CUTTING CONCERN DETECTION ============

/**
 * Detect cross-cutting concerns by analyzing cross-community edges for shared
 * dataTags/securityFlags. Returns concerns sorted by significance (security first,
 * then by affected community count).
 *
 * Significance filter: only returns concerns with 2+ affected community pairs
 * OR at least one bridge function above median centrality.
 */
export function detectCrossCuttingConcerns(
  db: Database.Database,
  algorithm: string,
  centralityScores: Map<string, number>,
  l1Communities: { communityId: string; title: string }[]
): CrossCuttingConcern[] {
  if (l1Communities.length < 2) return [];

  // Build hash→community lookup
  const hashToCommunity = new Map<string, string>();
  for (const { communityId } of l1Communities) {
    const members = db.prepare(
      "SELECT content_hash FROM communities WHERE community_id = ? AND level = 0 AND algorithm = ?"
    ).all(communityId, algorithm) as { content_hash: string }[];
    for (const { content_hash } of members) {
      hashToCommunity.set(content_hash, communityId);
    }
  }

  const communityTitles = new Map(l1Communities.map((c) => [c.communityId, c.title]));

  // Build hash→{dataTags, securityFlags, name} lookup
  const hashToMeta = new Map<string, { functionName: string; dataTags: string[]; securityFlags: string[] }>();
  const allHashes = [...hashToCommunity.keys()];
  const getAnalysis = db.prepare(
    "SELECT analysis_type, analysis FROM function_analysis WHERE content_hash = ?"
  );
  const getFnName = db.prepare(
    "SELECT function_name FROM file_functions WHERE content_hash = ? LIMIT 1"
  );

  for (const hash of allHashes) {
    const nameRow = getFnName.get(hash) as { function_name: string } | undefined;
    const analysisRows = getAnalysis.all(hash) as { analysis_type: string; analysis: string }[];
    let dataTags: string[] = [];
    let securityFlags: string[] = [];
    for (const row of analysisRows) {
      if (row.analysis_type === "security") {
        const parsed = JSON.parse(row.analysis);
        dataTags = parsed.dataTags || [];
        securityFlags = parsed.securityFlags || [];
      }
    }
    hashToMeta.set(hash, {
      functionName: nameRow?.function_name || hash.slice(0, 8),
      dataTags,
      securityFlags,
    });
  }

  // Scan cross-community edges and collect tags/flags per tag
  const tagToConcern = new Map<string, {
    concernType: "data_flow" | "security";
    bridgeHashes: Set<string>;
    communityPairs: Set<string>;
    crossEdgeCount: number;
  }>();

  const edges = db.prepare(
    "SELECT source_hash, target_hash FROM function_edges"
  ).all() as { source_hash: string; target_hash: string }[];

  for (const { source_hash, target_hash } of edges) {
    const fromCommunity = hashToCommunity.get(source_hash);
    const toCommunity = hashToCommunity.get(target_hash);
    if (!fromCommunity || !toCommunity || fromCommunity === toCommunity) continue;

    const sourceMeta = hashToMeta.get(source_hash);
    const targetMeta = hashToMeta.get(target_hash);
    if (!sourceMeta || !targetMeta) continue;

    const pairKey = [fromCommunity, toCommunity].sort().join("|");

    // Collect shared tags from both endpoints
    const allTags = new Set([...sourceMeta.dataTags, ...targetMeta.dataTags]);
    const allFlags = new Set([...sourceMeta.securityFlags, ...targetMeta.securityFlags]);

    for (const tag of allTags) {
      if (!tagToConcern.has(tag)) {
        tagToConcern.set(tag, {
          concernType: "data_flow",
          bridgeHashes: new Set(),
          communityPairs: new Set(),
          crossEdgeCount: 0,
        });
      }
      const c = tagToConcern.get(tag)!;
      c.bridgeHashes.add(source_hash);
      c.bridgeHashes.add(target_hash);
      c.communityPairs.add(pairKey);
      c.crossEdgeCount++;
    }

    for (const flag of allFlags) {
      if (!tagToConcern.has(flag)) {
        tagToConcern.set(flag, {
          concernType: "security",
          bridgeHashes: new Set(),
          communityPairs: new Set(),
          crossEdgeCount: 0,
        });
      }
      const c = tagToConcern.get(flag)!;
      c.bridgeHashes.add(source_hash);
      c.bridgeHashes.add(target_hash);
      c.communityPairs.add(pairKey);
      c.crossEdgeCount++;
    }
  }

  // Compute median centrality for significance filter
  const centralityValues = [...centralityScores.values()].filter((v) => v > 0);
  centralityValues.sort((a, b) => a - b);
  const medianCentrality = centralityValues.length > 0
    ? centralityValues[Math.floor(centralityValues.length / 2)]
    : 0;

  // Filter and build results
  const concerns: CrossCuttingConcern[] = [];

  for (const [tag, data] of tagToConcern) {
    // Check significance: 2+ community pairs OR high-centrality bridge
    const hasHighCentralityBridge = [...data.bridgeHashes].some(
      (hash) => (centralityScores.get(hash) || 0) > medianCentrality
    );

    if (data.communityPairs.size < 2 && !hasHighCentralityBridge) continue;

    // Build bridge functions list with centrality
    const bridgeFunctions = [...data.bridgeHashes].map((hash) => {
      const meta = hashToMeta.get(hash)!;
      return {
        contentHash: hash,
        functionName: meta.functionName,
        communityId: hashToCommunity.get(hash) || "",
        centrality: centralityScores.get(hash) || 0,
      };
    }).sort((a, b) => b.centrality - a.centrality);

    // Build affected communities list
    const affectedCommunityIds = new Set<string>();
    for (const pair of data.communityPairs) {
      const [a, b] = pair.split("|");
      affectedCommunityIds.add(a);
      affectedCommunityIds.add(b);
    }

    const affectedCommunities = [...affectedCommunityIds].map((id) => ({
      communityId: id,
      communityTitle: communityTitles.get(id) || id,
    }));

    concerns.push({
      tag,
      concernType: data.concernType,
      bridgeFunctions,
      affectedCommunities,
      crossEdgeCount: data.crossEdgeCount,
    });
  }

  // Sort: security concerns first, then by affected community count descending
  concerns.sort((a, b) => {
    if (a.concernType !== b.concernType) {
      return a.concernType === "security" ? -1 : 1;
    }
    return b.affectedCommunities.length - a.affectedCommunities.length;
  });

  return concerns;
}

// ============ CROSS-CUTTING CONCERN PROMPT + CALLER ============

function buildCCPrompt(
  concern: CrossCuttingConcern,
  communityDocs: Map<string, string>
): string {
  const tagLabel = concern.concernType === "security"
    ? (SECURITY_FLAG_LABELS[concern.tag] || concern.tag)
    : (DATA_TAG_LABELS[concern.tag] || concern.tag);

  const bridgeList = concern.bridgeFunctions.slice(0, 10).map((b) => {
    const communityTitle = concern.affectedCommunities.find(
      (c) => c.communityId === b.communityId
    )?.communityTitle || b.communityId;
    return `  - ${b.functionName} (community: ${communityTitle}, centrality: ${b.centrality.toFixed(3)})`;
  }).join("\n");

  const communityExcerpts = concern.affectedCommunities.map((c) => {
    const doc = communityDocs.get(c.communityId);
    const excerpt = doc ? doc.slice(0, 500) + (doc.length > 500 ? "..." : "") : "(no documentation)";
    return `### ${c.communityTitle}\n${excerpt}`;
  }).join("\n\n");

  return `You are a senior engineer documenting cross-cutting concerns in a codebase. A ${concern.concernType === "security" ? "security vulnerability pattern" : "data flow pattern"} has been detected spanning ${concern.affectedCommunities.length} subsystems.

Concern: "${tagLabel}" (${concern.concernType})
Cross-community edges: ${concern.crossEdgeCount}

Bridge functions (high-centrality functions connecting subsystems):
${bridgeList}

Affected subsystems:
${communityExcerpts}

Write documentation (200-400 words) that helps engineers understand:
1. What this cross-cutting ${concern.concernType === "security" ? "vulnerability" : "data flow"} is and why it matters
2. Which subsystems are affected and how they're connected through this concern
3. What the bridge functions do in this context
4. ${concern.concernType === "security" ? "What remediation steps should be considered" : "How data flows between the subsystems through this concern"}

Return a JSON object with exactly these fields:
- "title": string — descriptive name (e.g. "Cross-System PII Data Flow", "SQL Injection Attack Surface")
- "documentation": string — rich markdown documentation with ## title and ### sections
- "severity": "low" | "medium" | "high" — based on breadth and security impact

CRITICAL: Return ONLY the raw JSON object. No markdown code fences, no explanation.`;
}

export async function summarizeCC(
  concern: CrossCuttingConcern,
  communityDocs: Map<string, string>
): Promise<CrossCuttingConcernSummaryType> {
  const text = await callSummaryModel(buildCCPrompt(concern, communityDocs));
  try {
    const parsed = JSON.parse(text);
    return CrossCuttingConcernSummary.parse({
      ...parsed,
      concernType: concern.concernType,
      tag: concern.tag,
      bridgeFunctions: concern.bridgeFunctions,
      affectedCommunities: concern.affectedCommunities,
    });
  } catch {
    return CrossCuttingConcernSummary.parse({
      concernType: concern.concernType,
      tag: concern.tag,
      bridgeFunctions: concern.bridgeFunctions,
      affectedCommunities: concern.affectedCommunities,
    });
  }
}

// ============ ORCHESTRATION ============

export async function summarizeCommunities(
  db: Database.Database,
  options: SummarizeOptions = {}
): Promise<SummarizeResult> {
  const config = { ...DEFAULT_SUMMARIZE_CONFIG, ...options.config };
  const { onProgress } = options;
  const algorithm = config.algorithm;

  const rawMode = !!options.sourceMap;
  const rootPath = options.rootPath;
  const doL1 = options._summarizeL1 || (rawMode ? summarizeL1Raw : summarizeL1);
  const doL2 = options._summarizeL2 || summarizeL2;
  const doL3 = options._summarizeL3 || summarizeL3;

  const result: SummarizeResult = {
    l1Summarized: 0, l1Cached: 0, l1DriftSkipped: 0,
    l2Summarized: 0, l2Cached: 0,
    l3Summarized: 0, l3Cached: 0,
    ccDetected: 0, ccSummarized: 0, ccCached: 0,
  };

  // Track active community IDs at each level for orphan cleanup
  const activeL1Ids = new Set<string>();
  const activeL2Ids = new Set<string>();
  const activeCCIds = new Set<string>();

  // ===== L1: Subsystem summaries =====
  onProgress?.("Building L1 subsystem summaries...");

  const l0Communities = db.prepare(
    "SELECT DISTINCT community_id FROM communities WHERE level = 0 AND algorithm = ? AND community_id != '__dissolved'"
  ).all(algorithm) as { community_id: string }[];

  const l1Results: { communityId: string; summary: L1SummaryType; inputHash: string; packageInfo?: string }[] = [];

  // Pass 1: build contexts, check cache, collect work
  const l1Work: { context: L1CommunityContext; communityId: string }[] = [];

  for (const { community_id } of l0Communities) {
    const context = rawMode
      ? buildL1RawContext(db, community_id, algorithm, options.sourceMap!, rootPath)
      : buildL1Context(db, community_id, algorithm, rootPath);
    if (!context) continue;

    // Skip communities where no members have descriptions (or source code in raw mode)
    if (config.skipUnanalyzed && context.members.every((m) => !m.description)) {
      onProgress?.(`  Skipping community ${community_id} (no ${rawMode ? "source code" : "analysis data — run ophan analyze first"})`);
      continue;
    }

    // Gate 1: Check cache (exact input hash match)
    const existing = loadSummary(db, community_id, 1, algorithm);
    if (existing && existing.inputHash === context.inputHash) {
      result.l1Cached++;
      activeL1Ids.add(community_id);
      l1Results.push({
        communityId: community_id,
        summary: L1Summary.parse(existing.summary),
        inputHash: context.inputHash,
        packageInfo: context.packageInfo,
      });
      continue;
    }

    // Gate 2: Signature drift check (input hash changed but community may not have meaningfully drifted)
    if (existing) {
      const oldSigs = loadCommunitySignatures(db, community_id, algorithm);
      if (oldSigs && !hasCommunityDrifted(oldSigs, context.members)) {
        // Not drifted -- reuse old summary, keep OLD inputHash to prevent L2/L3 cascade
        result.l1DriftSkipped++;
        activeL1Ids.add(community_id);
        l1Results.push({
          communityId: community_id,
          summary: L1Summary.parse(existing.summary),
          inputHash: existing.inputHash,
          packageInfo: context.packageInfo,
        });
        onProgress?.(`  Community ${community_id}: drift-skipped (reusing summary)`);
        continue;
      }
    }

    l1Work.push({ context, communityId: community_id });
  }

  // Pass 2: parallel Claude calls for cache misses
  const l1Limit = pLimit(5);
  await Promise.all(l1Work.map((work) => l1Limit(async () => {
    onProgress?.(`  Summarizing community ${work.communityId} (${work.context.members.length} functions)...`);
    try {
      const summary = await doL1(work.context);
      storeSummary(db, work.communityId, 1, algorithm, work.context.inputHash, summary, MODEL_VERSION);
      storeCommunitySignatures(db, work.communityId, algorithm, work.context.members);
      result.l1Summarized++;
      activeL1Ids.add(work.communityId);
      l1Results.push({ communityId: work.communityId, summary, inputHash: work.context.inputHash, packageInfo: work.context.packageInfo });
    } catch (err) {
      onProgress?.(`  ⚠ Failed to summarize community ${work.communityId}: ${formatError(err)}`);
      result.l1Failed = (result.l1Failed ?? 0) + 1;
      activeL1Ids.add(work.communityId);
    }
  })));

  // Clean up orphaned L1 summaries
  cleanupOrphanedSummaries(db, algorithm, 1, activeL1Ids);

  // ===== L2: System summaries =====
  if (l1Results.length < 2) return result;

  onProgress?.("Building L2 system summaries...");

  // Check for L1 hierarchy assignments
  const l1HierarchyRows = db.prepare(
    "SELECT content_hash, community_id FROM communities WHERE level = 1 AND algorithm = ? AND community_id != '__dissolved'"
  ).all(algorithm) as { content_hash: string; community_id: string }[];

  const l0ToGroup = new Map<string, string>();
  for (const row of l1HierarchyRows) {
    l0ToGroup.set(row.content_hash, row.community_id);
  }

  // Group L1 summaries by their L1 parent group
  const distinctGroups = new Set(l0ToGroup.values());

  if (distinctGroups.size >= 2) {
    // Per-group L2 summaries
    const groupedL1s = new Map<string, typeof l1Results>();
    for (const l1 of l1Results) {
      const groupId = l0ToGroup.get(l1.communityId) ?? "ungrouped";
      const group = groupedL1s.get(groupId) || [];
      group.push(l1);
      groupedL1s.set(groupId, group);
    }

    // Pass 1: check cache, collect L2 work
    const l2Work: { groupId: string; l2Context: L2CommunityContext; l2CommunityId: string }[] = [];

    for (const [groupId, groupL1s] of groupedL1s) {
      if (groupL1s.length < 1) continue;

      const l2CommunityId = `group_${groupId}`;
      const l2InputHash = computeL2InputHash(groupL1s.map((s) => s.inputHash));

      const existingL2 = loadSummary(db, l2CommunityId, 2, algorithm);
      if (existingL2 && existingL2.inputHash === l2InputHash) {
        result.l2Cached++;
        activeL2Ids.add(l2CommunityId);
        continue;
      }

      const crossEdges = computeCrossEdges(
        db,
        groupL1s.map((s) => ({ communityId: s.communityId, title: s.summary.title })),
        algorithm
      );

      const l2Context: L2CommunityContext = {
        communityId: l2CommunityId,
        algorithm,
        l1Summaries: groupL1s.map((s) => ({
          communityId: s.communityId,
          title: s.summary.title,
          documentation: s.summary.documentation,
          packageInfo: s.packageInfo,
        })),
        crossEdges,
        inputHash: l2InputHash,
      };

      l2Work.push({ groupId, l2Context, l2CommunityId });
    }

    // Pass 2: parallel Claude calls for L2 cache misses
    const l2Limit = pLimit(3);
    await Promise.all(l2Work.map((work) => l2Limit(async () => {
      onProgress?.(`  Summarizing group ${work.groupId} from ${work.l2Context.l1Summaries.length} subsystems...`);
      try {
        const l2Summary = await doL2(work.l2Context);
        storeSummary(db, work.l2CommunityId, 2, algorithm, work.l2Context.inputHash, l2Summary, MODEL_VERSION);
        result.l2Summarized++;
        activeL2Ids.add(work.l2CommunityId);
      } catch (err) {
        onProgress?.(`  ⚠ Failed to summarize group ${work.groupId}: ${formatError(err)}`);
        activeL2Ids.add(work.l2CommunityId);
      }
    })));
  } else {
    // Fallback: single system_0 (no hierarchy or only 1 group)
    const l2InputHash = computeL2InputHash(l1Results.map((s) => s.inputHash));
    const l2CommunityId = "system_0";

    const existingL2 = loadSummary(db, l2CommunityId, 2, algorithm);
    if (existingL2 && existingL2.inputHash === l2InputHash) {
      result.l2Cached++;
      activeL2Ids.add(l2CommunityId);
    } else {
      const crossEdges = computeCrossEdges(
        db,
        l1Results.map((s) => ({ communityId: s.communityId, title: s.summary.title })),
        algorithm
      );

      const l2Context: L2CommunityContext = {
        communityId: l2CommunityId,
        algorithm,
        l1Summaries: l1Results.map((s) => ({
          communityId: s.communityId,
          title: s.summary.title,
          documentation: s.summary.documentation,
          packageInfo: s.packageInfo,
        })),
        crossEdges,
        inputHash: l2InputHash,
      };

      onProgress?.(`  Summarizing system from ${l1Results.length} subsystems...`);
      try {
        const l2Summary = await doL2(l2Context);
        storeSummary(db, l2CommunityId, 2, algorithm, l2InputHash, l2Summary, MODEL_VERSION);
        result.l2Summarized++;
        activeL2Ids.add(l2CommunityId);
      } catch (err) {
        onProgress?.(`  ⚠ Failed to summarize system: ${formatError(err)}`);
        activeL2Ids.add(l2CommunityId);
      }
    }
  }

  // ===== L3: Architecture overview =====
  onProgress?.("Building L3 architecture overview...");

  const allL2 = loadAllSummaries(db, algorithm, 2);
  if (allL2.length === 0) return result;

  const l3InputHash = computeL3InputHash(allL2.map((s) => s.inputHash));
  const l3CommunityId = "architecture";

  const existingL3 = loadSummary(db, l3CommunityId, 3, algorithm);
  if (existingL3 && existingL3.inputHash === l3InputHash) {
    result.l3Cached++;
  } else {
    const l2Summaries = allL2.map((s) => L2Summary.parse(s.summary));
    onProgress?.("  Generating architecture overview...");
    try {
      const l3Summary = await doL3(l2Summaries);
      storeSummary(db, l3CommunityId, 3, algorithm, l3InputHash, l3Summary, MODEL_VERSION);
      result.l3Summarized++;
    } catch (err) {
      onProgress?.(`  ⚠ Failed to generate architecture overview: ${formatError(err)}`);
    }
  }

  // Clean up orphaned L2 summaries
  cleanupOrphanedSummaries(db, algorithm, 2, activeL2Ids);

  // ===== Cross-Cutting Concerns =====
  if (l1Results.length >= 2) {
    onProgress?.("Detecting cross-cutting concerns...");

    // Load edges and build graph for centrality
    const edgeRows = db.prepare(
      "SELECT source_hash, target_hash, edge_type, weight FROM function_edges"
    ).all() as { source_hash: string; target_hash: string; edge_type: string; weight: number }[];

    const graphEdges: FunctionEdge[] = edgeRows.map((r) => ({
      sourceHash: r.source_hash,
      targetHash: r.target_hash,
      edgeType: r.edge_type as FunctionEdge["edgeType"],
      weight: r.weight,
    }));

    const graph = buildGraph(graphEdges);
    const centrality = computeCentrality(graph);

    const concerns = detectCrossCuttingConcerns(
      db,
      algorithm,
      centrality.scores,
      l1Results.map((s) => ({ communityId: s.communityId, title: s.summary.title }))
    );
    result.ccDetected = concerns.length;

    if (concerns.length > 0) {
      const communityDocs = new Map(
        l1Results.map((r) => [r.communityId, r.summary.documentation])
      );
      const doCC = options._summarizeCC || summarizeCC;

      // Pass 1: check cache, collect CC work
      const ccWork: { concern: typeof concerns[0]; inputHash: string; ccId: string }[] = [];

      for (const concern of concerns) {
        const inputHash = computeCCInputHash(concern);
        const ccId = `concern_${concern.tag}`;
        const existing = loadSummary(db, ccId, 10, algorithm);
        if (existing && existing.inputHash === inputHash) {
          result.ccCached++;
          activeCCIds.add(ccId);
          continue;
        }
        ccWork.push({ concern, inputHash, ccId });
      }

      // Pass 2: parallel Claude calls for CC cache misses
      const ccLimit = pLimit(5);
      await Promise.all(ccWork.map((work) => ccLimit(async () => {
        onProgress?.(`  Documenting concern: ${work.concern.tag} (${work.concern.affectedCommunities.length} subsystems)...`);
        try {
          const summary = await doCC(work.concern, communityDocs);
          storeSummary(db, work.ccId, 10, algorithm, work.inputHash, summary, MODEL_VERSION);
          result.ccSummarized++;
          activeCCIds.add(work.ccId);
        } catch (err) {
          onProgress?.(`  ⚠ Failed to document concern ${work.concern.tag}: ${formatError(err)}`);
          activeCCIds.add(work.ccId);
        }
      })));
    }
  }

  // Clean up orphaned cross-cutting concern summaries
  cleanupOrphanedSummaries(db, algorithm, 10, activeCCIds);

  return result;
}
