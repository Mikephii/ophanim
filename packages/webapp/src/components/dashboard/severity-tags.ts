/**
 * Shared tag color schemes for security issue cards.
 *
 * All security-related badges and pills should use these mappings
 * so colors are consistent across top-issues, issues list, etc.
 */

/** Severity → Badge variant. Controls vulnerability type badge color. */
export const SEVERITY_VARIANT: Record<string, 'destructive' | 'warning' | 'outline'> = {
  error: 'destructive',
  warning: 'warning',
  info: 'outline',
}

/** Left border stripe color by severity */
export const SEVERITY_BORDER: Record<string, string> = {
  error: 'border-l-red-500',
  warning: 'border-l-amber-500',
  info: 'border-l-border',
}

/** Severity label + tooltip text */
export const SEVERITY_INFO: Record<string, { label: string; tooltip: string }> = {
  error: { label: 'error', tooltip: 'Error — high-impact issue that should be addressed urgently' },
  warning: { label: 'warning', tooltip: 'Warning — potential issue that warrants investigation' },
  info: { label: 'alert', tooltip: 'Alert — informational finding, lower risk' },
}

/** Priority label → Badge variant */
export const PRIORITY_VARIANT: Record<string, 'destructive' | 'outline' | 'secondary'> = {
  P0: 'destructive',
  P1: 'outline',
  P2: 'secondary',
  P3: 'secondary',
}

/** Priority explanations for tooltips */
export const PRIORITY_INFO: Record<string, string> = {
  P0: 'Critical — confirmed exploitable vulnerability requiring immediate attention',
  P1: 'High — likely exploitable or high-severity issue',
  P2: 'Medium — potential issue worth investigating',
  P3: 'Low — informational finding, low risk',
}

/** Confidence → likelihood word */
export const CONFIDENCE_LABEL: Record<string, string> = {
  high: 'confirmed',
  medium: 'likely',
  low: 'possible',
}
