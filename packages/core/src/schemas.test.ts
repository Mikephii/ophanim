import { describe, it, expect } from "vitest";
import {
  KNOWN_SECURITY_FLAGS,
  SECURITY_FLAG_META,
  SECURITY_FLAG_LABELS,
  SECURITY_TIER_LABELS,
  DetailedIssue,
} from "./schemas";

describe("SECURITY_FLAG_META", () => {
  it("has an entry for every KNOWN_SECURITY_FLAGS member", () => {
    for (const flag of KNOWN_SECURITY_FLAGS) {
      expect(SECURITY_FLAG_META[flag]).toBeDefined();
      expect(SECURITY_FLAG_META[flag].tier).toBeGreaterThanOrEqual(1);
      expect(SECURITY_FLAG_META[flag].tier).toBeLessThanOrEqual(4);
      expect(SECURITY_FLAG_META[flag].cwe).toMatch(/^CWE-\d+$/);
      expect(SECURITY_FLAG_META[flag].owasp).toMatch(/^A\d{2}:\d{4}$/);
    }
  });

  it("has a label for every KNOWN_SECURITY_FLAGS member", () => {
    for (const flag of KNOWN_SECURITY_FLAGS) {
      expect(SECURITY_FLAG_LABELS[flag]).toBeDefined();
      expect(SECURITY_FLAG_LABELS[flag].length).toBeGreaterThan(0);
    }
  });

  it("has a label for every tier", () => {
    expect(SECURITY_TIER_LABELS[1]).toBe("Critical");
    expect(SECURITY_TIER_LABELS[2]).toBe("High");
    expect(SECURITY_TIER_LABELS[3]).toBe("Medium");
    expect(SECURITY_TIER_LABELS[4]).toBe("Low");
  });
});

describe("DetailedIssue", () => {
  it("parses a complete issue", () => {
    const raw = {
      flag: "xss",
      title: "XSS via innerHTML",
      description: "User input rendered without escaping",
      explanation: "Use textContent instead",
      line: 5,
      startText: "el.innerHTML = ",
      endText: "userInput;",
      severity: "error",
    };
    const parsed = DetailedIssue.parse(raw);
    expect(parsed.severity).toBe("error");
  });

  it("defaults severity to warning for invalid value", () => {
    const raw = { flag: "test", severity: "extreme" };
    const parsed = DetailedIssue.parse(raw);
    expect(parsed.severity).toBe("warning");
  });

  it("defaults missing optional fields gracefully", () => {
    const raw = { flag: "test" };
    const parsed = DetailedIssue.parse(raw);
    expect(parsed.title).toBe("");
    expect(parsed.description).toBe("");
    expect(parsed.explanation).toBe("");
    expect(parsed.line).toBe(0);
    expect(parsed.startText).toBe("");
    expect(parsed.endText).toBe("");
    expect(parsed.severity).toBe("warning");
    expect(parsed.confidence).toBe("medium");
  });

  it("preserves valid confidence values", () => {
    expect(DetailedIssue.parse({ flag: "test", confidence: "high" }).confidence).toBe("high");
    expect(DetailedIssue.parse({ flag: "test", confidence: "medium" }).confidence).toBe("medium");
    expect(DetailedIssue.parse({ flag: "test", confidence: "low" }).confidence).toBe("low");
  });

  it("defaults confidence to medium for invalid value", () => {
    const parsed = DetailedIssue.parse({ flag: "test", confidence: "extreme" });
    expect(parsed.confidence).toBe("medium");
  });

  it("defaults confidence to medium when field is missing (v2 compat)", () => {
    const raw = {
      flag: "xss",
      title: "XSS issue",
      severity: "error",
    };
    const parsed = DetailedIssue.parse(raw);
    expect(parsed.confidence).toBe("medium");
  });
});
