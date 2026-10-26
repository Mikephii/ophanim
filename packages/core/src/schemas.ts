import { z } from "zod";

// ============ ANALYSIS TYPE ENUM ============

export const AnalysisType = z.enum(["documentation", "security", "practices"]);
export type AnalysisType = z.infer<typeof AnalysisType>;

// ============ KNOWN VALUE SETS ============
//
// These are the values we prompt Claude for and have display labels for.
// They are NOT used for validation -- all schemas accept arbitrary strings.
// This "open with known values" design means:
//   - Claude can return new flags/tags we haven't seen before
//   - Unknown values are stored, synced, and displayed (using the raw string as fallback label)
//   - No data is ever silently dropped due to enum mismatch
//   - New known values are added here + in LABELS maps when we want display names
//   - UI code uses LABELS maps for display, falling back to raw string for unknown values

export const KNOWN_DATA_TAGS = [
  "user_input",
  "pii",
  "credentials",
  "database",
  "external_api",
  "file_system",
  "config",
  "internal",
] as const;
export type KnownDataTag = (typeof KNOWN_DATA_TAGS)[number];

export const KNOWN_SECURITY_FLAGS = [
  "sql_injection",
  "xss",
  "hardcoded_secret",
  "unsanitized_input",
  "path_traversal",
  "prototype_pollution",
  "command_injection",
  "pickle_deserialization",
  "eval_exec",
  "insecure_subprocess",
] as const;
export type KnownSecurityFlag = (typeof KNOWN_SECURITY_FLAGS)[number];

// ============ ANALYSIS PAYLOADS ============

export const ParamSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string(),
});
export type Param = z.infer<typeof ParamSchema>;

export const ReturnsSchema = z.object({
  type: z.string(),
  description: z.string(),
});
export type Returns = z.infer<typeof ReturnsSchema>;

/** Documentation analysis: description, parameters, return type */
export const DocumentationAnalysis = z.object({
  description: z.string(),
  params: z.array(ParamSchema),
  returns: ReturnsSchema,
});
export type DocumentationAnalysis = z.infer<typeof DocumentationAnalysis>;

/**
 * A rich security or practice issue with location, description, and fix guidance.
 * Every field uses .catch() so malformed Claude responses degrade gracefully.
 * The `line` field is 1-indexed within the function (from line-numbered prompt context).
 * `startText`/`endText` are anchor snippets for character-level precision.
 */
export const DetailedIssue = z.object({
  flag: z.string(),
  title: z.string().catch(""),
  description: z.string().catch(""),
  explanation: z.string().catch(""),
  line: z.number().catch(0),
  startText: z.string().catch(""),
  endText: z.string().catch(""),
  severity: z.enum(["error", "warning", "info"]).catch("warning"),
  confidence: z.enum(["high", "medium", "low"]).catch("medium"),
  lineText: z.string().catch(""),  // trimmed source line at analysis time, for modification detection
});
export type DetailedIssue = z.infer<typeof DetailedIssue>;

/**
 * Security analysis: data flow tags, vulnerability flags, and detailed issues.
 * `securityFlags` is kept as a lightweight summary (for CodeLens icons, filtering, badge counts).
 * `issues` provides rich details (title, description, explanation, line location).
 * `issues` uses .catch([]) so v1 rows (without issues) parse successfully.
 */
export const SecurityAnalysis = z.object({
  dataTags: z.array(z.string()),
  securityFlags: z.array(z.string()),
  issues: z.array(DetailedIssue).catch([]),
});
export type SecurityAnalysis = z.infer<typeof SecurityAnalysis>;

/** Practices analysis: violations of team-defined coding practices. */
export const PracticesAnalysis = z.object({
  violations: z.array(DetailedIssue).catch([]),
});
export type PracticesAnalysis = z.infer<typeof PracticesAnalysis>;

// ============ DISCRIMINATED UNION ============

export const TypedAnalysis = z.discriminatedUnion("analysisType", [
  z.object({
    analysisType: z.literal("documentation"),
    data: DocumentationAnalysis,
  }),
  z.object({
    analysisType: z.literal("security"),
    data: SecurityAnalysis,
  }),
  z.object({
    analysisType: z.literal("practices"),
    data: PracticesAnalysis,
  }),
]);
export type TypedAnalysis = z.infer<typeof TypedAnalysis>;

// ============ CLAUDE RESPONSE VALIDATOR ============

/**
 * Validates the raw JSON response from Claude's analysis.
 * The prompt returns a flat object per function with all fields combined.
 * We validate here, then split into separate analysis type rows on storage.
 *
 * Uses .catch() defaults so partial/malformed responses degrade gracefully
 * instead of rejecting entire batches.
 */
export const ClaudeAnalysisResponse = z.object({
  name: z.string(),
  description: z.string().catch(""),
  params: z.array(ParamSchema).catch([]),
  returns: ReturnsSchema.catch({ type: "unknown", description: "" }),
  dataTags: z.array(z.string()).catch([]),
  securityFlags: z.array(z.string()).catch([]),
  issues: z.array(DetailedIssue).catch([]),
  practiceViolations: z.array(DetailedIssue).catch([]),
});
export type ClaudeAnalysisResponse = z.infer<typeof ClaudeAnalysisResponse>;

// ============ COMMUNITY SUMMARY SCHEMAS ============
//
// Each community summary has two parts:
//   - documentation: rich markdown explaining the subsystem to a junior engineer
//   - meta: structured data for badges, search, filtering in the UI
//
// Length scales dynamically with complexity -- Claude decides based on
// function count, relationship density, and security concerns.

export const SummaryMeta = z.object({
  securityPosture: z.string().catch(""),
  dataClassification: z.array(z.string()).catch([]),
  boundaries: z.array(z.string()).catch([]),
  keyFunctions: z.array(z.string()).catch([]),
  complexity: z.enum(["low", "medium", "high"]).catch("medium"),
});
export type SummaryMeta = z.infer<typeof SummaryMeta>;

const defaultMeta: SummaryMeta = {
  securityPosture: "",
  dataClassification: [],
  boundaries: [],
  keyFunctions: [],
  complexity: "medium",
};

/** L1 subsystem summary: docs for a group of closely-related functions */
export const L1Summary = z.object({
  title: z.string().catch("Untitled Subsystem"),
  documentation: z.string().catch(""),
  meta: SummaryMeta.catch(defaultMeta),
});
export type L1Summary = z.infer<typeof L1Summary>;

/** L2 system summary: docs for a group of L1 subsystems */
export const L2Summary = z.object({
  title: z.string().catch("Untitled System"),
  documentation: z.string().catch(""),
  meta: SummaryMeta.catch(defaultMeta),
});
export type L2Summary = z.infer<typeof L2Summary>;

/** L3 architecture overview: top-level docs from L2 summaries */
export const L3Summary = z.object({
  title: z.string().catch("Architecture Overview"),
  documentation: z.string().catch(""),
  meta: SummaryMeta.catch(defaultMeta),
});
export type L3Summary = z.infer<typeof L3Summary>;

// ============ CROSS-CUTTING CONCERN SCHEMA ============

const defaultCCMeta = {
  bridgeFunctions: [] as { functionName: string; contentHash: string; communityId: string; centrality: number }[],
  affectedCommunities: [] as { communityId: string; communityTitle: string }[],
};

/** Cross-cutting concern summary: docs for a data flow or security pattern spanning communities */
export const CrossCuttingConcernSummary = z.object({
  title: z.string().catch("Untitled Concern"),
  concernType: z.string().catch("data_flow"),
  tag: z.string().catch("unknown"),
  documentation: z.string().catch(""),
  bridgeFunctions: z.array(z.object({
    functionName: z.string(),
    contentHash: z.string(),
    communityId: z.string(),
    centrality: z.number(),
  })).catch(defaultCCMeta.bridgeFunctions),
  affectedCommunities: z.array(z.object({
    communityId: z.string(),
    communityTitle: z.string(),
  })).catch(defaultCCMeta.affectedCommunities),
  severity: z.string().catch("medium"),
});
export type CrossCuttingConcernSummary = z.infer<typeof CrossCuttingConcernSummary>;

// ============ SCHEMA VERSIONS ============

/**
 * Each analysis type has an independent schema version.
 * Bump when the JSON shape changes. Old rows remain readable.
 * Stored alongside each row for forward-compatibility.
 */
export const SCHEMA_VERSIONS: Record<AnalysisType, number> = {
  documentation: 1,
  security: 2,
  practices: 1,
};

// ============ PRACTICE CONSTRAINTS ============

export const MAX_PRACTICES = 10;
export const MAX_RULE_LENGTH = 200;

// ============ DISPLAY LABELS ============
//
// Label maps for known values. UI code should use these for display,
// falling back to the raw string for unknown values:
//   SECURITY_FLAG_LABELS[flag] ?? flag

export const SECURITY_FLAG_LABELS: Record<string, string> = {
  sql_injection: "SQL Injection",
  xss: "XSS",
  hardcoded_secret: "Hardcoded Secret",
  unsanitized_input: "Unsanitized Input",
  path_traversal: "Path Traversal",
  prototype_pollution: "Prototype Pollution",
  command_injection: "Command Injection",
  pickle_deserialization: "Pickle Deserialization",
  eval_exec: "Eval/Exec",
  insecure_subprocess: "Insecure Subprocess",
};

// ============ SECURITY FLAG METADATA ============
//
// Tier + industry-standard identifiers for each known security flag.
// Used for dashboard sorting, explainer pages, and display.
// Unknown flags default to tier 3 in UI: SECURITY_FLAG_META[flag]?.tier ?? 3
//
// Tier 1 (Critical): High confidence, high impact, low FP rate
// Tier 2 (High): Dangerous patterns, moderate context-dependence
// Tier 3 (Medium): Common flags with higher FP rates
// Tier 4 (Low): Theoretical or niche vulnerabilities

export interface SecurityFlagMeta {
  tier: 1 | 2 | 3 | 4;
  cwe: string;
  owasp: string;
}

export const SECURITY_FLAG_META: Record<string, SecurityFlagMeta> = {
  sql_injection: { tier: 1, cwe: "CWE-89", owasp: "A03:2021" },
  command_injection: { tier: 1, cwe: "CWE-78", owasp: "A03:2021" },
  hardcoded_secret: { tier: 1, cwe: "CWE-798", owasp: "A07:2021" },
  eval_exec: { tier: 2, cwe: "CWE-95", owasp: "A03:2021" },
  path_traversal: { tier: 2, cwe: "CWE-22", owasp: "A01:2021" },
  insecure_subprocess: { tier: 2, cwe: "CWE-78", owasp: "A03:2021" },
  unsanitized_input: { tier: 3, cwe: "CWE-20", owasp: "A03:2021" },
  xss: { tier: 3, cwe: "CWE-79", owasp: "A03:2021" },
  pickle_deserialization: { tier: 3, cwe: "CWE-502", owasp: "A08:2021" },
  prototype_pollution: { tier: 4, cwe: "CWE-1321", owasp: "A03:2021" },
};

export const SECURITY_TIER_LABELS: Record<number, string> = {
  1: "Critical",
  2: "High",
  3: "Medium",
  4: "Low",
};

export const DATA_TAG_LABELS: Record<string, string> = {
  user_input: "User Input",
  pii: "PII",
  credentials: "Credentials",
  database: "Database",
  external_api: "External API",
  file_system: "File System",
  config: "Config",
  internal: "Internal",
};
