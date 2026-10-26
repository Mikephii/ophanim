# Security Dashboard Architecture

## Overview

The security dashboard is the repo root page (`/dashboard/repos/$repoId`). It surfaces security analysis results with actionable UI: posture indicators, priority scoring, category breakdowns, triage workflow, and educational content.

## Data Flow

```
function_analysis (Supabase)
  → getSecurityDashboardStats (server fn)
    → counts issues by severity × confidence
    → excludes dismissed_issues
    → returns posture, counts, per-flag breakdown
  → SecurityHero + SecurityCategories (dashboard)

function_analysis (Supabase)
  → getSecurityIssues (server fn, existing)
    → returns EnrichedFunction[] with issues
  → TopIssues (client-side sort by priorityScore)

dismissed_issues (Supabase)
  → getDismissedIssues (server fn)
    → returns DismissedIssue[] for client-side filtering
  → Used by dashboard stats, issues list, function detail page
```

## Priority Scoring

Two-dimensional triage: `severity` × `confidence` → priority score → label.

```
priorityScore(severity, confidence) = severityScore(severity) * 3 + confidenceScore(confidence)

severityScore: error=3, warning=2, info=1
confidenceScore: high=3, medium=2, low=1

Range: 4 (info+low) to 12 (error+high)

Labels:
  P0: score >= 12 (error+high only)
  P1: score 9-11 (error+medium, warning+high)
  P2: score 6-8 (warning+medium, etc.)
  P3: score < 6 (info+low, etc.)
```

Utility functions in `packages/webapp/src/services/api/security-utils.ts`.

## Confidence Field

Added to `DetailedIssue` in `packages/core/src/schemas.ts`:
```typescript
confidence: z.enum(["high", "medium", "low"]).catch("medium")
```

- `.catch("medium")` ensures existing analysis rows (without confidence) parse as medium
- Claude prompt updated with definitions for high/medium/low
- Dashboard stats only count `criticalCount` for `severity=error AND confidence=high`

## Vulnerability Tiers

`SECURITY_FLAG_META` in `packages/core/src/schemas.ts` maps each known flag to:
- `tier`: 1 (Critical) through 4 (Low) -- based on exploitability, blast radius, FP rate
- `cwe`: CWE identifier
- `owasp`: OWASP Top 10 reference

Unknown flags default to tier 3 in UI: `SECURITY_FLAG_META[flag]?.tier ?? 3`.

## Dismissed Issues

Separate table from immutable content-addressed `function_analysis`:

```sql
dismissed_issues (
  repo_id, content_hash, issue_index, dismissed_by,
  flag, reason, note, dismissed_at
)
```

Key design decisions:
- `issue_index` = position in the `issues` array. Stable because source code hasn't changed (same content_hash). If source changes → new hash → old dismissals orphaned (correct: new code needs fresh review).
- Personal dismissals only (`dismissed_by = auth.uid()`). Team-wide later via `team_id` column.
- RLS: users can only see/manage their own dismissals.
- `flag` is denormalized for efficient per-flag counting without joining analysis.
- Dashboard stats exclude dismissed issues by default (server-side filtering).

## Route Structure

```
/dashboard/repos/$repoId/          → Security Dashboard (index.tsx)
/dashboard/repos/$repoId/functions → Function Table (functions.tsx)
/dashboard/repos/$repoId/security/
  issues                           → Paginated issues list with filters
  learn/                           → Explainer index (all 10 flags)
  learn/$flag                      → Explainer detail page
```

## Components

| Component | File | Purpose |
|-----------|------|---------|
| SecurityHero | `security-hero.tsx` | Posture badge, stat cards, distribution bar |
| TopIssues | `top-issues.tsx` | Top 8 issues sorted by priority score |
| SecurityCategories | `security-categories.tsx` | Per-flag category cards grid |
| IssueDismiss | `issue-dismiss.tsx` | Dismiss/restore dropdown per issue |
| FlagBadge (inline) | Various | Linked to explainer page if available |

## Explainer Content

`packages/webapp/src/data/security-explainers.ts` -- static educational content for all 10 known flags. Each explainer includes: what, how, vulnerable code, safe code, framework notes, CWE/OWASP references. Content is keyed by flag identifier and auto-populated with tier/CWE/OWASP from `SECURITY_FLAG_META`.
