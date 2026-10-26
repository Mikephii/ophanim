import { describe, it, expect } from "vitest";
import { buildCliEnv, parseServerUrl, shouldPromptSignIn, shouldSync, signInCommand } from "./server-settings";

describe("parseServerUrl", () => {
  it("accepts http(s) URLs and trims trailing slashes", () => {
    expect(parseServerUrl(" https://ophan.example.com/ ")).toBe("https://ophan.example.com");
    expect(parseServerUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("treats empty, invalid and non-http values as no server", () => {
    expect(parseServerUrl(undefined)).toBe("");
    expect(parseServerUrl("")).toBe("");
    expect(parseServerUrl("not a url")).toBe("");
    expect(parseServerUrl("file:///etc/passwd")).toBe("");
  });
});

describe("buildCliEnv", () => {
  it("passes the API key and server URL to the CLI", () => {
    const env = buildCliEnv({ PATH: "/bin" }, { apiKey: "sk-test", serverUrl: "https://ophan.example.com" });
    expect(env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-test", OPHAN_SERVER_URL: "https://ophan.example.com" });
  });

  it("drops an inherited OPHAN_SERVER_URL when no server is set", () => {
    const env = buildCliEnv({ OPHAN_SERVER_URL: "https://stale.example.com" }, { apiKey: "k", serverUrl: "" });
    expect(env.OPHAN_SERVER_URL).toBeUndefined();
  });
});

describe("sync and sign-in gating", () => {
  it("only syncs when auto-sync is on and a server is configured", () => {
    expect(shouldSync(true, "https://ophan.example.com")).toBe(true);
    expect(shouldSync(true, "")).toBe(false);
    expect(shouldSync(false, "https://ophan.example.com")).toBe(false);
  });

  it("never prompts to sign in without a server", () => {
    expect(shouldPromptSignIn({ serverUrl: "", dismissed: false, hasCredentials: false })).toBe(false);
    expect(shouldPromptSignIn({ serverUrl: "https://o.example.com", dismissed: false, hasCredentials: false })).toBe(true);
    expect(shouldPromptSignIn({ serverUrl: "https://o.example.com", dismissed: true, hasCredentials: false })).toBe(false);
    expect(shouldPromptSignIn({ serverUrl: "https://o.example.com", dismissed: false, hasCredentials: true })).toBe(false);
  });

  it("builds a quoted login command for the configured server", () => {
    expect(signInCommand("https://ophan.example.com")).toBe("npx @ophan/cli login --server 'https://ophan.example.com'");
    expect(signInCommand("")).toBeNull();
  });
});
