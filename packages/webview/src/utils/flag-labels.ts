/** Display labels for security flags (copied from @ophan/core/schemas) */
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
}

/** Tier labels (1=Critical, 2=High, 3=Medium, 4=Low) */
export const SECURITY_TIER_LABELS: Record<number, string> = {
  1: "Critical",
  2: "High",
  3: "Medium",
  4: "Low",
}

/** Tier → tailwind background color class for distribution bar segments and dots */
export const TIER_COLORS: Record<number, string> = {
  1: "bg-red-500",
  2: "bg-amber-500",
  3: "bg-yellow-400",
  4: "bg-gray-400",
}

/** Flag → tier mapping (copied from @ophan/core/schemas SECURITY_FLAG_META) */
export const FLAG_TIERS: Record<string, 1 | 2 | 3 | 4> = {
  sql_injection: 1,
  command_injection: 1,
  hardcoded_secret: 1,
  eval_exec: 2,
  path_traversal: 2,
  insecure_subprocess: 2,
  unsanitized_input: 3,
  xss: 3,
  pickle_deserialization: 3,
  prototype_pollution: 4,
}

/** Get human-readable flag label, falling back to raw flag name */
export function flagLabel(flag: string): string {
  return SECURITY_FLAG_LABELS[flag] ?? flag.replace(/_/g, " ")
}

/** Get tier for a flag, defaulting to 3 */
export function flagTier(flag: string): 1 | 2 | 3 | 4 {
  return FLAG_TIERS[flag] ?? 3
}
