# Coding practices

Practices are your own rules, written in plain language, that Ophan checks every function against during analysis, alongside the security checks and in the same Claude call, so they add no extra requests.

Practices are managed per repo in the web dashboard, so they need a [self-hosted server](self-hosting.md).

## Set up

1. In the dashboard, open your repo's **Settings** and add practices under **Coding Practices**.
2. Run `npx @ophan/cli sync` in the repo to pull them into `.ophan/index.db`.
3. Run `analyze` or `watch` (or let the extension do it). Functions are checked against the practices from then on.

Changing practices doesn't re-check functions that are already analyzed: functions are re-checked as their code changes.

## Format

| Field | Rules |
|---|---|
| `id` | kebab-case, unique per repo, e.g. `no-eval`, `use-parameterized-queries` |
| `rule` | Plain-language instruction, at most 200 characters |
| `severity` | `error`, `warning` or `info` |

At most 10 practices per repo.

## Where violations show up

- Squiggles in VS Code and entries in the Problems panel, with the practice id as the code
- A **Practice Violations** section on the function in the Ophan panel and the web dashboard

## Writing good rules

- State the rule, don't ask a question: "Always use parameterized queries" works better than "Are queries parameterized?"
- Keep it to one idea per rule.
- Use `error` for must-never-happen rules, `warning` for strong preferences, `info` for style.
- Start with two or three high-value rules.
