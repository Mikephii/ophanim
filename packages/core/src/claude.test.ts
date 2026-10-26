import { describe, it, expect, vi } from "vitest";
import { ClaudeRefusalError, DEFAULT_MODEL, callClaude, extractText, getModel, isRetryable } from "./claude";

const reply = (content: any[], stop_reason: any = "end_turn", stop_details: any = null) => ({ content, stop_reason, stop_details });

describe("getModel", () => {
  it("defaults to a current model and honours OPHAN_MODEL", () => {
    expect(getModel({})).toBe(DEFAULT_MODEL);
    expect(getModel({ OPHAN_MODEL: " claude-opus-5-5 " })).toBe("claude-opus-5-5");
  });
});

describe("extractText", () => {
  it("skips thinking blocks before the text", () => {
    expect(extractText(reply([{ type: "thinking", thinking: "" }, { type: "text", text: "[1]" }]))).toBe("[1]");
  });

  it("throws a refusal error with its category", () => {
    const err = (() => { try { extractText(reply([], "refusal", { category: "cyber" })); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(ClaudeRefusalError);
    expect((err as ClaudeRefusalError).category).toBe("cyber");
  });

  it("throws when the reply was truncated", () => {
    expect(() => extractText(reply([{ type: "text", text: "[{" }], "max_tokens"))).toThrow("max_tokens");
  });
});

describe("isRetryable", () => {
  it("retries rate limits, overload and 5xx only", () => {
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 529 })).toBe(true);
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 404 })).toBe(false);
    expect(isRetryable(new Error("boom"))).toBe(false);
  });
});

describe("callClaude", () => {
  it("rejects with the original API error instead of a retry context", async () => {
    const notFound = Object.assign(new Error("model: claude-old"), { status: 404 });
    const client = { messages: { create: vi.fn().mockRejectedValue(notFound) } } as any;
    await expect(callClaude({ prompt: "p", maxTokens: 10, client })).rejects.toBe(notFound);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("retries a rate limit and returns the text", async () => {
    const rateLimited = Object.assign(new Error("slow down"), { status: 429 });
    const create = vi.fn()
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce(reply([{ type: "text", text: "ok" }]));
    const onRetry = vi.fn();
    const text = await callClaude({ prompt: "p", maxTokens: 10, client: { messages: { create } } as any, onRetry });
    expect(text).toBe("ok");
    expect(onRetry).toHaveBeenCalledWith(1, rateLimited);
    expect(create.mock.calls[0][0].model).toBe(getModel());
  }, 10000);
});
