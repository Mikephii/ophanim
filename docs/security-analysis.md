# Security analysis

Claude reviews every function and returns two kinds of results: **security flags** (possible vulnerabilities, each with a detailed finding) and **data tags** (what kind of data the function handles).

## Security flags

| Flag | What it means |
|---|---|
| **SQL injection** | Untrusted input reaches a SQL query |
| **XSS** | Unescaped output in HTML or the DOM |
| **Hardcoded secret** | Credentials, API keys or tokens in source code |
| **Unsanitized input** | User input used without validation |
| **Path traversal** | A file path an attacker can steer outside the intended directory |
| **Prototype pollution** | Unchecked property assignment that can reach `Object.prototype` |
| **Command injection** | Untrusted input in a shell command |
| **Pickle deserialization** | Deserializing untrusted data (Python `pickle` and similar) |
| **Eval/exec** | Running strings as code (`eval`, `exec`, `new Function`) |
| **Insecure subprocess** | Shell commands built from untrusted input (`shell=True`, `exec`) |

Claude may report other flags too; they're shown with their raw name and treated the same way.

### Priority

Flags fall into four tiers by typical impact and false-positive rate:

| Tier | Flags |
|---|---|
| 1, Critical | SQL injection, command injection, hardcoded secret |
| 2, High | Eval/exec, path traversal, insecure subprocess |
| 3, Medium | Unsanitized input, XSS, pickle deserialization |
| 4, Low | Prototype pollution |

## Findings

Each flagged problem comes with:

- **Title**, e.g. "SQL injection via string concatenation"
- **Description**: what's wrong
- **Explanation**: why it matters and how to fix it
- **Location**: the exact line and code range (used to place the squiggle)
- **Severity**: `error` (exploitable), `warning` (risky pattern), `info` (worth knowing)
- **Confidence**: `high` (clearly exploitable from the visible code), `medium` (depends on callers), `low` (matches a known pattern but is usually safe)

Severity and confidence combine into a priority from **P0** (error, high confidence) to **P3**, used to sort issues in the dashboard.

## Data tags

| Tag | Meaning |
|---|---|
| `user_input` | Request bodies, query parameters, form fields |
| `pii` | Names, emails, addresses and other personal data |
| `credentials` | Passwords, tokens, API keys |
| `database` | Queries and writes |
| `external_api` | Calls to other services |
| `file_system` | Reads or writes files |
| `config` | Configuration and environment variables |
| `internal` | Internal helper with no sensitive data |

Tags make data flow visible: a function tagged `user_input` and `database` with an `unsanitized_input` flag deserves a close look.

## Designed to under-report

Ophan prefers missing an issue to showing a wrong one. When Claude is unsure, findings come back as `info` rather than `warning`. If Ophan can't find the exact line a finding refers to, it doesn't place a squiggle. When you edit a flagged line, its squiggle disappears immediately and only comes back if re-analysis confirms the problem is still there.

Treat findings as a starting point for review, not a verdict: a parameterized query flagged for SQL injection may be fine in context. You can dismiss a finding as a false positive, accepted risk or won't fix, with a note.

## Where findings show up

- **VS Code**: squiggles, gutter shields, the Problems panel, hovers, CodeLens and the Ophan panel's dashboard and issue list. See [extension.md](extension.md).
- **Web dashboard** on a [self-hosted server](self-hosting.md): the same dashboard across all synced repos, plus a **Learn** section with vulnerable and safe examples, CWE and OWASP references for each flag.
- **Directly**: `.ophan/index.db` is plain SQLite (table `function_analysis`, rows with `analysis_type = 'security'`).
