# Analysis Types

## Overview

Analysis is split into independent **types** stored as separate rows in `function_analysis`. Each function produces multiple rows -- one per analysis type -- keyed by `(content_hash, analysis_type)`.

Current types:
- **documentation** -- description, parameters, return type
- **security** -- data flow tags, security vulnerability flags
- **practices** -- violations of team-defined coding practices

## Why Split Types?

### Independent Versioning

Each analysis type has its own `schema_version`. When we change the security analysis schema (e.g., add severity levels), we bump `security` to v2 without touching documentation rows. Old documentation rows remain valid and don't need re-analysis.

### Selective Re-analysis

When we add new security detectors (e.g., SSRF detection), we can re-run only the security analysis. Documentation hasn't changed, so those rows stay cached. This halves the Claude API cost for security-focused updates.

### Extensibility

Adding a new analysis type (e.g., `complexity`, `testing`, `api_contract`) requires:
1. Add a Zod schema in `schemas.ts`
2. Add a variant to the `TypedAnalysis` discriminated union
3. Add a prompt section in `analyzeFunctions()`
4. Add an `INSERT` statement in the analyze loop
5. Update the merge function in consumers

No migration needed -- new types coexist with existing ones.

### Smaller Payloads

Each row contains a focused JSONB payload. Security queries only read security rows. Documentation hover tooltips only read documentation rows. Less data transferred, parsed, and indexed.

## Schema Design

### Open With Known Values

All enum-like fields (security flags, data tags) use `z.string()` arrays in Zod, not `z.enum()`. This means:

- Claude can return new flags we haven't seen before (e.g., a novel vulnerability pattern)
- Unknown values are stored, synced, and displayed (using the raw string as a fallback label)
- No data is ever silently dropped due to enum mismatch
- Known values have display labels in `SECURITY_FLAG_LABELS` / `DATA_TAG_LABELS`
- UI code uses: `SECURITY_FLAG_LABELS[flag] ?? flag`

This design is intentional. Security analysis is adversarial -- we don't want to reject a valid finding just because we forgot to add it to an enum. The known value sets (`KNOWN_SECURITY_FLAGS`, `KNOWN_DATA_TAGS`) exist for prompting Claude and providing display labels, not for validation.

### Schema Versions

Each analysis type has a `schema_version` stored per row:

```typescript
SCHEMA_VERSIONS = { documentation: 1, security: 2, practices: 1 }
```

Version history:
- `security: 1` -- `{ dataTags, securityFlags }` (flat flags only)
- `security: 2` -- adds `issues: DetailedIssue[]` (rich structured findings with title, description, explanation, line-level location). Old v1 rows remain valid -- `issues` defaults to `[]` via `.catch([])`.
- `practices: 1` -- `{ violations: DetailedIssue[] }` -- team-defined coding practice violations. Practices are managed in the web dashboard (Supabase `repo_practices` table), synced to local SQLite `practices` table by `ophan sync`, and read by the analysis pipeline. Only written when practices exist for the repo. Reuses the `DetailedIssue` shape (same structure as security issues). `flag` field contains the practice id, not a security flag.

When the JSON shape changes:
1. Bump the version in `SCHEMA_VERSIONS`
2. New rows get the new version
3. Old rows remain valid (read code handles both)
4. Optional: lazy migration converts old rows on read

### Zod Validation

Claude's response is validated with `ClaudeAnalysisResponse.parse()`, which uses `.catch()` defaults for graceful degradation:

```typescript
const DetailedIssue = z.object({
  flag: z.string(),
  title: z.string().catch(""),
  description: z.string().catch(""),
  explanation: z.string().catch(""),
  line: z.number().catch(0),          // 1-indexed within the function (not file-absolute)
  startText: z.string().catch(""),
  endText: z.string().catch(""),
  severity: z.enum(["error", "warning", "info"]).catch("warning"),
});

const ClaudeAnalysisResponse = z.object({
  name: z.string(),
  description: z.string().catch(""),
  params: z.array(ParamSchema).catch([]),
  returns: ReturnsSchema.catch({ type: "unknown", description: "" }),
  dataTags: z.array(z.string()).catch([]),
  securityFlags: z.array(z.string()).catch([]),
  issues: z.array(DetailedIssue).catch([]),
  practiceViolations: z.array(DetailedIssue).catch([]),
});
```

A malformed response degrades to empty arrays/defaults instead of rejecting the entire batch. The `issues` field uses `.catch([])` so v1 rows (without `issues`) parse successfully with an empty array default.

### DetailedIssue

Each issue in the `issues` array is a structured finding:

| Field | Type | Description |
|-------|------|-------------|
| `flag` | string | Machine-readable category (matches a `securityFlags` entry) |
| `title` | string | Human-readable one-line summary |
| `description` | string | What the vulnerability is |
| `explanation` | string | How to fix it |
| `line` | number | 1-based line number within the function source (convert to file-absolute via `start_line + line - 1`) |
| `startText` | string | Anchor text where the issue starts on that line |
| `endText` | string | Anchor text where the issue ends on that line |
| `severity` | `"error" \| "warning" \| "info"` | Severity level |

### Numbered-Line Prompt

To enable accurate line references, the Claude prompt sends source code with line numbers prepended via `numberLines()`:

```typescript
export function numberLines(sourceCode: string): string {
  const lines = sourceCode.split("\n");
  const pad = String(lines.length).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(pad)} | ${line}`)
    .join("\n");
}
```

The prompt instructs Claude to "read the line number labels, don't count lines yourself". This is applied only in the prompt -- content hashes are computed from the original unnumbered source, so no cache invalidation occurs.

## Storage

### Local SQLite

```sql
CREATE TABLE function_analysis (
  content_hash TEXT NOT NULL,
  analysis_type TEXT NOT NULL,        -- 'documentation' | 'security' | 'practices'
  analysis JSON NOT NULL,
  model_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  language TEXT NOT NULL DEFAULT 'typescript',
  entity_type TEXT NOT NULL DEFAULT 'function',
  synced_at INTEGER,
  PRIMARY KEY (content_hash, analysis_type)
);
```

### Supabase (Cloud)

```sql
CREATE TABLE function_analysis (
  content_hash TEXT NOT NULL,
  analysis_type TEXT NOT NULL,
  repo_id UUID NOT NULL,
  user_id UUID NOT NULL,
  analysis JSONB NOT NULL,
  model_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  -- ... generated columns, timestamps ...
  PRIMARY KEY (content_hash, repo_id, analysis_type)
);
```

### Consumer Merge Pattern

All consumers (VS Code, webview, webapp) merge the split rows back into a unified shape:

```typescript
// Group rows by content_hash
// Merge: doc fields from 'documentation' row, sec fields from 'security' row
{
  description: doc.description,
  params: doc.params,
  returns: doc.returns,
  dataTags: sec.dataTags,
  securityFlags: sec.securityFlags,
  issues: sec.issues || [],     // v2; defaults to [] for v1 rows
  practiceViolations: prac.violations || [],  // empty when no practices row
}
```

This keeps the consumer interface unchanged -- the split is an internal storage detail. The `|| []` fallback ensures backward compatibility with v1 security rows that lack the `issues` field.

## Migration

### Local SQLite

Automatic on first access after update. Core's `initDb()` detects the old schema via `PRAGMA table_info` and runs `migrateToAnalysisTypes()`:

1. Creates `function_analysis_v2` with new composite PK
2. Splits each old row into documentation + security rows using `json_extract()`
3. Drops old table, renames v2
4. Sets `synced_at = NULL` to force full re-sync

### Supabase

Manual migration: `supabase/migrations/00002_analysis_types.sql`. Same pattern -- create v2, split rows with `jsonb_build_object()`, drop old, rename. RLS policies re-applied.
