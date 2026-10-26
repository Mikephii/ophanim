import { describe, it, expect } from "vitest";
import { buildLensTitle } from "./lens";
import type { FunctionData } from "./types";

function makeFn(overrides: Partial<FunctionData> = {}): FunctionData {
  return {
    name: "testFn",
    filePath: "src/test.ts",
    startLine: 1,
    endLine: 10,
    contentHash: "abc123",
    description: "A test function",
    params: [],
    returns: { type: "void", description: "" },
    dataTags: [],
    securityFlags: [],
    issues: [],
    language: "typescript",
    entityType: "function",
    ...overrides,
  };
}

describe("buildLensTitle", () => {
  it("shows stale icon when stale", () => {
    const result = buildLensTitle(makeFn({ securityFlags: ["xss"] }), true);
    expect(result).toContain("$(sync~spin)");
    // Stale takes priority over security icon
    expect(result).not.toContain("$(warning)");
  });

  it("shows warning for security flags", () => {
    const result = buildLensTitle(makeFn({ securityFlags: ["sql_injection"] }), false);
    expect(result).toContain("$(warning)");
  });

  it("shows lock for pii data tag", () => {
    const result = buildLensTitle(makeFn({ dataTags: ["pii"] }), false);
    expect(result).toContain("$(lock)");
  });

  it("shows lock for credentials data tag", () => {
    const result = buildLensTitle(makeFn({ dataTags: ["credentials"] }), false);
    expect(result).toContain("$(lock)");
  });

  it("shows database icon for database tag", () => {
    const result = buildLensTitle(makeFn({ dataTags: ["database"] }), false);
    expect(result).toContain("$(database)");
  });

  it("shows globe for external_api tag", () => {
    const result = buildLensTitle(makeFn({ dataTags: ["external_api"] }), false);
    expect(result).toContain("$(globe)");
  });

  it("shows text prefix for no flags/tags", () => {
    const result = buildLensTitle(makeFn(), false);
    expect(result).toContain("Ophan:");
  });

  it("truncates long descriptions to 50 chars", () => {
    const longDesc = "This is a very long description that should be truncated because it exceeds fifty characters";
    const result = buildLensTitle(makeFn({ description: longDesc }), false);
    expect(result).toContain("...");
    // Description portion should be max 50 chars (47 + "...")
    expect(result.length).toBeLessThan(longDesc.length + 10);
  });

  it("does not truncate short descriptions", () => {
    const shortDesc = "Short desc";
    const result = buildLensTitle(makeFn({ description: shortDesc }), false);
    expect(result).toContain(shortDesc);
    expect(result).not.toContain("...");
  });

  it("always shows [details] hint", () => {
    const result = buildLensTitle(makeFn(), false);
    expect(result).toContain("[details]");
  });

  it("does not show data tags in brackets", () => {
    const result = buildLensTitle(
      makeFn({ dataTags: ["database", "pii", "credentials"] }),
      false
    );
    expect(result).not.toContain("[database");
    expect(result).toContain("[details]");
  });

  it("security flags take priority over pii icon", () => {
    const result = buildLensTitle(
      makeFn({ securityFlags: ["xss"], dataTags: ["pii"] }),
      false
    );
    expect(result).toContain("$(warning)");
    expect(result).not.toContain("$(lock)");
  });

  it("shows community title in braces when present", () => {
    const result = buildLensTitle(
      makeFn({ communityTitle: "Auth System" }),
      false
    );
    expect(result).toContain("{Auth System}");
  });

  it("omits community braces when communityTitle is undefined", () => {
    const result = buildLensTitle(makeFn(), false);
    expect(result).not.toContain("{");
    expect(result).not.toContain("}");
  });
});
