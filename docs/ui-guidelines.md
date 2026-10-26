# UI Guidelines

Design language and implementation patterns for Ophan's web app and VS Code extension.

## Design Philosophy

Ophan uses a **sharp, technical aesthetic** -- squared-off edges communicate precision and seriousness befitting a security tool. The design is information-dense but not cluttered, using spacing and typography hierarchy rather than decorative elements to create visual structure.

**Key principles:**
- Security-first visual language -- red means danger, always
- High information density -- compact badges, small text, tight grids
- Dark mode as the primary experience (most devs use dark mode)
- Minimal chrome -- content over decoration

## Geometry: Squared Off with Selective Rounding

The global border radius is `--radius: 0`. All shadcn components (cards, buttons, inputs, badges, dialogs, sidebar items) render with sharp corners. This is intentional -- it gives the UI a technical, tool-like feel. **This applies everywhere by default**, including the main app navigation sidebar.

**Selective rounding exception:** Certain documentation-style UIs use `rounded-[4px]` (4px border radius) on interactive items like sidebar buttons. This is applied via the `.docs-sidebar` CSS class in `styles.css`, which targets `[data-sidebar="menu-button"]` and `[data-sidebar="menu-sub-button"]` elements. The rounding is scoped -- it only applies inside containers marked with `.docs-sidebar`.

```
Default (everywhere):          --radius: 0  (sharp corners)
Docs sidebar (scoped):         4px          (via .docs-sidebar CSS class)
Main app nav sidebar:          --radius: 0  (sharp corners, standard theme)
```

**When to use rounding:** Only in content-browsing UIs like documentation sidebars where the Fumadocs-inspired softer feel is appropriate. The main application chrome (app nav, settings, dashboards) stays squared off.

## Color System

Colors use OKLCH for perceptually uniform lightness across hues. The primary brand color is teal/cyan (hue ~183).

### Semantic Colors

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `primary` | `oklch(0.60 0.10 185)` | `oklch(0.70 0.12 183)` | Brand accent, primary actions, active indicators |
| `destructive` | `oklch(0.58 0.22 27)` | `oklch(0.704 0.191 22)` | Security warnings, high severity, danger |
| `muted` | `oklch(0.97 0 0)` | `oklch(0.269 0 0)` | Hover surfaces, secondary backgrounds |
| `secondary` | `oklch(0.967 0.001 286)` | `oklch(0.274 0.006 286)` | Metadata badges, supporting info |

### Chart Colors (5-step teal gradient)

Used for data visualizations. Ordered lightest to darkest: `chart-1` through `chart-5`.

## Surface Elevation Model

Instead of shadows (which don't work well in dark mode), Ophan uses **background color steps** to indicate elevation -- inspired by Material Design's dark theme surfaces.

### Sidebar elevation example (dark mode)

| Level | Color | OKLCH Lightness | Usage |
|-------|-------|-----------------|-------|
| Base | `--sidebar` | 0.205 | Sidebar background |
| Elevated | `--muted` | 0.269 | Hover state |
| Active | `--sidebar-primary/10` | primary at 10% opacity | Selected item |

Hover = one step up from the base surface (neutral gray).
Selected = tinted with the primary color at low opacity.

These are always visually distinct from each other -- hover is achromatic (gray), selected is chromatic (teal-tinted).

## Interactive States

### Selection (active/current item)

Use a subdued wash of the primary color -- **not** the full primary. This follows the Fumadocs pattern.

```
Background: bg-sidebar-primary/10   (10% opacity of primary)
Text:       text-sidebar-primary     (full primary color)
Font:       font-medium              (slightly bolder)
```

The 10% opacity wash is visible in both light and dark mode as a subtle teal tint over the surface, clearly indicating "you are here" without being overwhelming.

### Hover

Use a neutral surface elevation change -- **not** the same color as selected.

```
Background: bg-muted                 (neutral gray, one step up)
Text:       text-sidebar-foreground  (standard text color)
```

This must be visually distinct from the selected state. Hover is achromatic (gray), selected is chromatic (teal). Users should never confuse "I'm hovering" with "this is selected."

### Summary table

| State | Background | Text | Shape |
|-------|-----------|------|-------|
| Idle | transparent | foreground | -- |
| Hover | `muted` (neutral surface) | foreground | `rounded-[4px]` |
| Selected | `primary/10` (subdued teal) | `primary` (teal) | `rounded-[4px]` |
| Pressed | `muted` | foreground | `rounded-[4px]` |
| Disabled | transparent, 50% opacity | -- | -- |

## Sidebar Navigation

The architecture docs sidebar uses a Fumadocs-inspired tree navigation.

### Collapsible folders

- Single chevron on the left of folder labels
- Clicking the chevron toggles collapse/expand (does not navigate)
- Clicking the folder label text navigates to the folder overview page
- Folders auto-expand when navigating to a child item
- Collapse/expand is animated using `animate-collapsible-down` / `animate-collapsible-up` (from `tw-animate-css`, powered by Radix `--radix-collapsible-content-height`)

### Chevron behavior

The chevron intercepts clicks with `preventDefault()` + `stopPropagation()` so it toggles collapse without triggering the parent link's navigation. The folder label text is the navigation target.

## Typography

**Font:** Figtree Variable (sans-serif) -- clean, modern, highly legible at small sizes.

### Hierarchy

```
Page title:      text-2xl font-semibold
Section heading: text-lg font-semibold
Card title:      text-base font-medium (or text-sm font-medium)
Body:            text-sm
Small/meta:      text-xs
Code:            font-mono text-sm (or text-xs)
```

### Markdown content

Architecture documentation uses `@tailwindcss/typography` with `prose prose-sm dark:prose-invert max-w-none`. Code blocks use `rehype-highlight` with the `github-dark-dimmed` theme.

## Badge System

Badges communicate metadata density -- security posture, severity, data classification, complexity.

| Variant | Usage |
|---------|-------|
| `destructive` | Security concerns, high severity, PII |
| `default` | Primary classifications (medium complexity) |
| `secondary` | Low severity, boundaries, general metadata |
| `outline` | Data classification tags, neutral labels |

### Severity color coding (on outline badges)

```
High:   border-red-500 text-red-600
Medium: border-yellow-500 text-yellow-600
Low:    border-green-500 text-green-600
```

## Layout Patterns

### Docs-style pages (architecture)

```
SidebarProvider
  sidebar (fixed, collapsible tree)
  main (flex-1, overflow-auto)
    centered container (mx-auto max-w-5xl px-8 py-6)
      content + ToC sidebar (flex gap-8)
```

### Card grids

```
grid gap-3 sm:grid-cols-2
```

Cards use `hover:border-primary/50 transition-colors` for interactive feedback (not ring, not shadow).

### Spacing scale

- Tight: `gap-1`, `gap-1.5` (inline badges, breadcrumbs)
- Compact: `gap-2`, `gap-3` (card content, button groups)
- Default: `gap-4` (sections within a page)
- Loose: `gap-6`, `gap-8` (page-level sections, main + ToC)

## VS Code Extension

The extension follows VS Code's native design language but with Ophan-specific patterns.

### Status bar

Right-aligned with shield icon: `$(shield) Ophan`. States: "Setup needed", "Ready", "X stale", loading spinner.

### CodeLens icons

Semantic icons indicate function characteristics at a glance:

| Icon | Meaning |
|------|---------|
| `$(sync~spin)` | Stale / analyzing |
| Warning sign | Security warning |
| Lock | PII / credentials |
| Database | Database operations |
| Globe | External API calls |
| Diamond | Default (no special flags) |

### Webview

The VS Code webview panel syncs dark/light mode with the editor theme via `MutationObserver` on the `<body>` class. It uses the same React component library as the web app but communicates via `postMessage` protocol.

## Function References

Functions are displayed across many contexts (subsystem member tables, concern bridge function tables, search results). The `FunctionRef` component (`packages/webapp/src/components/dashboard/function-ref.tsx`) provides a consistent display.

### Display format

```
ƒ functionName  [↗]
```

- **ƒ prefix** -- muted color, indicates this is a function (not a variable, class, etc.)
- **Function name** -- monospace, primary color, links to `/dashboard/repos/$repoId/fn/$contentHash`
- **Open-in-editor icon** -- always visible (subdued `text-muted-foreground/50`, brightens on hover), opens dropdown to select editor (VS Code). Only shown when `filePath` is available.

### "Open in editor" flow

Functions with a known file path show a persistent external-link icon. Clicking it opens a `vscode://file/...` URI to jump directly to the file in VS Code.

**Two display sizes:**
- **Inline (FunctionRef):** Small `icon-xs` button next to the function name. If base path is set, shows a dropdown with editor options. If not set, opens the base path configuration dialog.
- **Block (OpenInEditorBlock):** Full `Button` variant `outline` size `sm` with "Open in VS Code" text + icon. Used on the function detail page where there's more room.

**Base path requirement:** The VS Code URI needs the absolute local path to the repository. This is stored per-repo in localStorage (`ophan:basePath:${repoId}`). If not set, clicking the button shows a dialog explaining the URI construction with an example. The base path can also be managed from the repo settings page under "Local Settings".

**Settings page integration:** The repo settings page (`/dashboard/repos/$repoId/settings`) has a "Local Settings" section above the Danger Zone. This shows the current base path, allows editing, and clearly labels it as a per-device/browser-only setting not shared with the team.

**Adding new editors:** Add items to the dropdown in `OpenInEditorButton`. Each editor uses its own URI scheme (e.g., `cursor://file/...`, `jetbrains://...`).

## Security Dashboard UI Patterns

### Tier colors

Vulnerability tiers use consistent colors throughout the dashboard:

```
Tier 1 (Critical): bg-red-500     / text-destructive
Tier 2 (High):     bg-amber-500   / text-amber-500
Tier 3 (Medium):   bg-yellow-400  / text-yellow-500
Tier 4 (Low):      bg-gray-400    / text-muted-foreground
```

Used in: distribution bar segments, category card dot indicators, learn page cards.

### Confidence badges

Confidence badges use progressive visual weight:

```
High:   border-current font-medium           (solid, same color as severity -- reinforces signal)
Medium: border-muted-foreground/40 text-muted-foreground  (outline, muted)
Low:    border-muted-foreground/20 text-muted-foreground/60  (very faded -- tentative)
```

### Priority labels

Priority labels (P0–P3) use badge variants:

```
P0: variant="destructive"  font-mono  (red -- urgent)
P1: variant="default"      font-mono  (neutral emphasis)
P2: variant="secondary"    font-mono  (subdued)
P3: variant="secondary"    font-mono  (subdued)
```

### Dismissed issue styling

Dismissed issues are shown with:
- `opacity-50` on the container
- `line-through` on the issue title
- Dismiss reason badge (outline variant, muted text)
- "Restore" button visible on hover

### Issue cards (top issues)

Issue cards use a left border colored by severity:

```
error:   border-l-red-500
warning: border-l-amber-500
info:    border-l-blue-400
```

### Posture indicator

The hero section shows a posture badge:
- **Critical** (red): `IconFlame` + "Critical Issues Found"
- **Needs Attention** (amber): `IconAlertTriangle` + "Needs Attention"
- **Clean** (green): `IconShieldCheck` + "No Issues Found"

### Flag badge linking

Flag name badges (e.g., "SQL Injection") link to the corresponding explainer page when one exists. Check `flag in SECURITY_EXPLAINERS` before wrapping in a Link. Unknown flags remain non-linked badges.

## Implementation Notes

### Where styles live

- **CSS variables:** `packages/webapp/src/styles.css` -- all theme tokens (light + dark)
- **Component variants:** `packages/webapp/src/components/ui/sidebar.tsx` -- `sidebarMenuButtonVariants` cva defines hover/active classes
- **Scoped overrides:** `.docs-sidebar` CSS rule in styles.css applies 4px rounding to docs sidebar items
- **Tailwind config:** `@theme inline` block in styles.css maps CSS vars to Tailwind tokens
- **Animation:** `tw-animate-css` provides collapsible, accordion, fade, slide keyframes

### Adding new interactive elements

**Color rules (apply everywhere):**

1. Hover: `hover:bg-muted` (neutral surface elevation) -- never same as active
2. Active/selected: `bg-primary/10 text-primary` (subdued primary wash)
3. Never use the same color for hover and active -- they must be visually distinct
4. Prefer `transition-colors` for smooth state changes

**Shape rules (context-dependent):**

- **App chrome** (main nav, settings, dashboards): use the default theme radius (`rounded-md` = 0px). Sharp corners match the technical aesthetic.
- **Docs-style UIs** (architecture sidebar): add the `docs-sidebar` class to the sidebar wrapper. This applies `border-radius: 4px` to menu buttons via CSS, giving a softer Fumadocs-inspired feel for content browsing.
- Do not mix -- a given sidebar is either squared off (app) or rounded (docs), never both.
