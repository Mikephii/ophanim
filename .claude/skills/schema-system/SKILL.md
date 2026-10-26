---
name: schema-system
description: Zod schemas, analysis types, open-with-known-values pattern, discriminated unions, display labels. Use when working on schemas.ts, adding new analysis types, or modifying Claude's response format.
---

# Schema System

## Core Design: "Open with Known Values"

Enum-like fields use `z.string()` arrays, NOT `z.enum()`. Claude can return new flags/tags we haven't seen before. Unknown values are stored, synced, and displayed. No data is ever silently dropped.

**File:** `packages/core/src/schemas.ts`

## Analysis Type Split

Each function produces **2-3 rows** in `function_analysis`:

| Type | Fields | Use Case |
|------|--------|----------|
| `documentation` | description, params, returns | Function documentation |
| `security` | dataTags, securityFlags, issues | Security analysis |
| `practices` | violations | Team-defined coding practice violations (only when `.ophan/practices.json` exists) |

```typescript
export const AnalysisType = z.enum(["documentation", "security", "practices"]);
```

This split enables:
- Independent schema versioning per type
- Selective re-analysis (e.g., re-run security only)
- Future extensibility (add `"complexity"` or `"testing"` type without touching existing rows)

## Known Value Sets

```typescript
export const KNOWN_DATA_TAGS = [
  "user_input", "pii", "credentials", "database",
  "external_api", "file_system", "config", "internal",
] as const;

export const KNOWN_SECURITY_FLAGS = [
  "sql_injection", "xss", "hardcoded_secret", "unsanitized_input",
  "path_traversal", "prototype_pollution", "command_injection",
  "pickle_deserialization", "eval_exec", "insecure_subprocess",
] as const;
```

These are used for:
1. **Prompting Claude** -- included in analysis prompt so Claude knows our vocabulary
2. **Display labels** -- mapping raw values to human-readable names
3. **NOT for validation** -- Zod schemas use `z.string()`, not `z.enum()`

## Analysis Schemas

```typescript
export const ParamSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string(),
});

export const ReturnsSchema = z.object({
  type: z.string(),
  description: z.string(),
});

export const DocumentationAnalysis = z.object({
  description: z.string(),
  params: z.array(ParamSchema),
  returns: ReturnsSchema,
});

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

export const SecurityAnalysis = z.object({
  dataTags: z.array(z.string()),           // NOT z.enum()
  securityFlags: z.array(z.string()),      // NOT z.enum()
  issues: z.array(DetailedIssue).catch([]),// v2: rich structured findings
});

export const PracticesAnalysis = z.object({
  violations: z.array(DetailedIssue).catch([]),
});
```

`issues` and `violations` use `.catch([])` so rows without them parse to empty arrays -- no migration needed.

## Discriminated Union

```typescript
export const TypedAnalysis = z.discriminatedUnion("analysisType", [
  z.object({ analysisType: z.literal("documentation"), data: DocumentationAnalysis }),
  z.object({ analysisType: z.literal("security"), data: SecurityAnalysis }),
  z.object({ analysisType: z.literal("practices"), data: PracticesAnalysis }),
]);
```

Enables type-safe pattern matching:
```typescript
if (analysis.analysisType === "documentation") {
  // analysis.data is typed as DocumentationAnalysis
}
```

## Claude Response Validator

```typescript
export const ClaudeAnalysisResponse = z.object({
  name: z.string(),
  description: z.string().catch(""),                    // Graceful default
  params: z.array(ParamSchema).catch([]),
  returns: ReturnsSchema.catch({ type: "unknown", description: "" }),
  dataTags: z.array(z.string()).catch([]),
  securityFlags: z.array(z.string()).catch([]),
  issues: z.array(DetailedIssue).catch([]),             // v2: structured findings
  practiceViolations: z.array(DetailedIssue).catch([]),// practices violations
});
```

Uses `.catch()` for graceful degradation -- one malformed field doesn't reject the entire batch.

## Community Summary Schemas

```typescript
export const SummaryMeta = z.object({
  securityPosture: z.string().catch(""),
  dataClassification: z.array(z.string()).catch([]),
  boundaries: z.array(z.string()).catch([]),
  keyFunctions: z.array(z.string()).catch([]),
  complexity: z.enum(["low", "medium", "high"]).catch("medium"),
});
```

L1/L2/L3 summaries share: `{ title, documentation, meta: SummaryMeta }`

## Security Flag Metadata

```typescript
export interface SecurityFlagMeta {
  tier: 1 | 2 | 3 | 4;
  cwe: string;
  owasp: string;
}

export const SECURITY_FLAG_META: Record<string, SecurityFlagMeta> = {
  sql_injection: { tier: 1, cwe: "CWE-89", owasp: "A03:2021" },
  // ... all 10 flags
};

export const SECURITY_TIER_LABELS: Record<number, string> = {
  1: "Critical", 2: "High", 3: "Medium", 4: "Low",
};
```

**UI pattern:** `SECURITY_FLAG_META[flag]?.tier ?? 3` -- unknown flags default to tier 3 (Medium).

Tiers are based on exploitability, blast radius, and false positive rate:
- Tier 1: High confidence, high impact (SQL injection, command injection, hardcoded secrets)
- Tier 2: Dangerous but context-dependent (eval/exec, path traversal, insecure subprocess)
- Tier 3: Common flags with higher FP rates (unsanitized input, XSS, pickle)
- Tier 4: Theoretical or niche (prototype pollution)

## Confidence Field

`DetailedIssue.confidence` (added alongside severity) creates a 2D triage matrix:

```
severity × confidence → priorityScore → label (P0-P3)
P0 = error + high (score 12)     → clearly exploitable
P1 = error + medium, warning + high (score 9-11)
P2 = warning + medium, etc. (score 6-8)
P3 = info + low, etc. (score < 6) → noise
```

`.catch("medium")` ensures existing rows without confidence parse as medium -- no migration needed.

## lineText Field (Modification Detection)

`DetailedIssue.lineText` stores the trimmed source line at analysis time. The VS Code extension compares this with the current document line to detect when a user has edited the flagged code. If the line text differs, the squiggle is suppressed (rather than misleadingly highlighting the fixed code).

- Computed in `packages/core/src/index.ts` from `sourceCode.split("\n")[issue.line - 1].trim()`
- `.catch("")` means old analysis rows without `lineText` fall back to anchor-only detection
- Raw text (not hashed) -- `startText`/`endText` already store raw source fragments, so hashing adds friction with no security benefit

See `docs/architecture/extension-lifecycle.md` (Remediation Detection).

Priority scoring utilities: `packages/webapp/src/services/api/security-utils.ts`

## Display Labels

```typescript
export const SECURITY_FLAG_LABELS: Record<string, string> = {
  sql_injection: "SQL Injection",
  xss: "XSS",
  hardcoded_secret: "Hardcoded Secret",
  unsanitized_input: "Unsanitized Input",
  // ...
};

export const DATA_TAG_LABELS: Record<string, string> = {
  user_input: "User Input",
  pii: "PII",
  credentials: "Credentials",
  // ...
};
```

**UI pattern:** `LABELS[value] ?? value` -- unknown values display their raw string.

## Schema Versions & Re-analysis

```typescript
export const SCHEMA_VERSIONS: Record<AnalysisType, number> = {
  documentation: 1,
  security: 2,       // v2: added DetailedIssue[] issues
  practices: 1,      // v1: violations of team-defined practices
};
```

Stored alongside each row in `function_analysis.schema_version`. When the schema changes:

1. Bump `SCHEMA_VERSIONS` for the affected type
2. Add `.catch()` default in the Zod schema for new fields
3. `analyzeFiles()` automatically detects stale rows and re-analyzes

**How re-analysis works:**

```typescript
// In analyzeFiles() -- checks schema freshness, not just existence
const minSchemaVersion = Math.min(SCHEMA_VERSIONS.documentation, SCHEMA_VERSIONS.security);
const checkAnalysis = db.prepare(
  `SELECT 1 FROM function_analysis
   WHERE content_hash = ? AND analysis_type = 'documentation'
   AND schema_version >= ?`
);
// Rows with old schema_version are cache misses → function gets re-analyzed
```

Analysis inserts use `INSERT OR REPLACE` so re-analysis overwrites stale rows. Re-analysis is incremental -- only functions in the current scan with stale `schema_version` get re-analyzed.

**When to bump schema_version:**
- Adding a new field to analysis JSON (e.g., `lineText` on `DetailedIssue`)
- Changing how Claude analyzes functions (different prompt, richer output)
- NOT needed for: new tables, new columns on non-analysis tables, new analysis types

Version history:
- `security: 1` -- `{ dataTags, securityFlags }`
- `security: 2` -- adds `issues: DetailedIssue[]` with line-level location, title, description, explanation, severity
- `practices: 1` -- `{ violations: DetailedIssue[] }` -- team-defined coding practice violations

## Migration System

Core migration runner at `packages/core/src/migrations.ts`. See `docs/architecture/migrations.md` for full docs.

**Quick reference:**
- Structural changes (tables, columns) → Add a migration to `CORE_MIGRATIONS` + update `createFreshSchema()`
- Analysis JSON changes → Bump `SCHEMA_VERSIONS` + add `.catch()` default (no migration needed)
- New analysis type → Add to `AnalysisType` + `SCHEMA_VERSIONS` + `TypedAnalysis` (no migration needed)

Migrations are idempotent, immutable, and run in transactions. Never rename tables/columns -- add new, deprecate old.

## Adding New Analysis Types

1. Add literal to `AnalysisType` enum
2. Create Zod schema for the new type
3. Add to `TypedAnalysis` discriminated union
4. Add to `SCHEMA_VERSIONS`
5. Update Claude prompt to request the new fields
6. Update `insertAnalysis` to write the new row
7. Update merge functions (core + webapp) to handle the new type

## Adding New Known Values

1. Add to `KNOWN_DATA_TAGS` or `KNOWN_SECURITY_FLAGS`
2. Add display label to corresponding `LABELS` map
3. Update Claude prompt if the value should be actively detected
4. No schema changes needed (uses `z.string()`)

## Key Files

- `packages/core/src/schemas.ts` -- All schemas, types, labels, versions, SECURITY_FLAG_META
- `packages/core/src/migrations.ts` -- Core migration runner, CORE_MIGRATIONS list
- `packages/core/src/index.ts` -- `initDb()`, `createFreshSchema()`, `analyzeFiles()` with schema-version check
- `packages/webapp/src/services/api/merge.ts` -- Merges split rows for display
- `packages/webapp/src/services/api/security-utils.ts` -- Priority scoring (severityScore, confidenceScore, priorityScore, priorityLabel, flagTier)
- `packages/webapp/src/data/security-explainers.ts` -- Educational content for all 10 known flags
- `packages/webapp/src/services/api/security.ts` -- Dismiss/undismiss server functions
- `packages/webapp/src/services/api/types.ts` -- DismissedIssue, DismissReason, SecurityDashboardStats
