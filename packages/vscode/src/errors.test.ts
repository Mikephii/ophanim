import { describe, it, expect } from "vitest";
import { classifyWatchError, type OphanError } from "./errors";

describe("classifyWatchError", () => {
  it("classifies API key errors", () => {
    const err = classifyWatchError("Invalid api_key provided");
    expect(err.type).toBe("api_key_invalid");
    expect(err.severity).toBe("fatal");
    expect(err.recovery.command).toBe("workbench.action.openSettings");
  });

  it("classifies authentication errors", () => {
    const err = classifyWatchError("authentication failed for request");
    expect(err.type).toBe("api_key_invalid");
  });

  it("classifies 401 errors", () => {
    const err = classifyWatchError("Request failed with status 401");
    expect(err.type).toBe("api_key_invalid");
  });

  it("classifies invalid x-api-key header", () => {
    const err = classifyWatchError("invalid x-api-key header");
    expect(err.type).toBe("api_key_invalid");
  });

  it("classifies rate limit errors (429)", () => {
    const err = classifyWatchError("Request failed with status 429");
    expect(err.type).toBe("rate_limited");
    expect(err.severity).toBe("transient");
    expect((err as Extract<OphanError, { type: "rate_limited" }>).retryAfterMs).toBe(60_000);
  });

  it("classifies rate_limit text errors", () => {
    const err = classifyWatchError("rate_limit_exceeded: too many requests");
    expect(err.type).toBe("rate_limited");
  });

  it("classifies network errors (ECONNREFUSED)", () => {
    const err = classifyWatchError("connect ECONNREFUSED 127.0.0.1:443");
    expect(err.type).toBe("network_error");
    expect(err.severity).toBe("recoverable");
    expect(err.recovery.command).toBe("ophan.analyzeNow");
  });

  it("classifies fetch failed errors", () => {
    const err = classifyWatchError("fetch failed");
    expect(err.type).toBe("network_error");
  });

  it("classifies DNS resolution errors (ENOTFOUND)", () => {
    const err = classifyWatchError("getaddrinfo ENOTFOUND api.anthropic.com");
    expect(err.type).toBe("network_error");
  });

  it("classifies timeout errors (ETIMEDOUT)", () => {
    const err = classifyWatchError("connect ETIMEDOUT 1.2.3.4:443");
    expect(err.type).toBe("timeout");
    expect(err.severity).toBe("recoverable");
  });

  it("classifies general timeout errors", () => {
    const err = classifyWatchError("Analysis timeout after 120s for src/foo.ts");
    expect(err.type).toBe("timeout");
  });

  it("classifies database lock errors", () => {
    const err = classifyWatchError("SQLITE_BUSY: database is locked");
    expect(err.type).toBe("db_locked");
    expect(err.severity).toBe("transient");
  });

  it("classifies sqlite_busy errors", () => {
    const err = classifyWatchError("sqlite_busy error during write");
    expect(err.type).toBe("db_locked");
  });

  it("falls back to analysis_failed for unknown errors", () => {
    const err = classifyWatchError("something unexpected happened");
    expect(err.type).toBe("analysis_failed");
    expect(err.severity).toBe("recoverable");
    expect(err.message).toBe("something unexpected happened");
  });

  it("includes file in analysis_failed fallback", () => {
    const err = classifyWatchError("parse error", "/src/test.ts");
    expect(err.type).toBe("analysis_failed");
    expect((err as Extract<OphanError, { type: "analysis_failed" }>).file).toBe("/src/test.ts");
  });

  it("handles empty message", () => {
    const err = classifyWatchError("");
    expect(err.type).toBe("analysis_failed");
    expect(err.message).toBe("Analysis failed");
  });

  it("handles case-insensitive matching", () => {
    const err = classifyWatchError("ECONNREFUSED from proxy");
    expect(err.type).toBe("network_error");
  });

  it("every error type has a recovery action", () => {
    const testMessages = [
      "api_key invalid",
      "rate limit exceeded",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "SQLITE_BUSY",
      "unknown error",
    ];
    for (const msg of testMessages) {
      const err = classifyWatchError(msg);
      expect(err.recovery).toBeDefined();
      expect(err.recovery.label).toBeTruthy();
      expect(err.recovery.command).toBeTruthy();
    }
  });
});
