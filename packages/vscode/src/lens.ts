import type { FunctionData } from "./types";

export function buildLensTitle(fn: FunctionData, isStale: boolean): string {
  const parts: string[] = [];

  if (isStale) {
    parts.push("$(sync~spin)");
  } else if (fn.securityFlags.length > 0) {
    parts.push("$(warning)");
  } else if (
    fn.dataTags.includes("pii") ||
    fn.dataTags.includes("credentials")
  ) {
    parts.push("$(lock)");
  } else if (fn.dataTags.includes("database")) {
    parts.push("$(database)");
  } else if (fn.dataTags.includes("external_api")) {
    parts.push("$(globe)");
  } else {
    parts.push("Ophan:");
  }

  const desc =
    fn.description.length > 50
      ? fn.description.slice(0, 47) + "..."
      : fn.description;
  parts.push(desc);

  parts.push("[details]");

  if (fn.communityTitle) {
    parts.push(`{${fn.communityTitle}}`);
  }

  return parts.join(" ");
}
