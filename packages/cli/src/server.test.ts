import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  NoServerConfiguredError,
  fetchServerConfig,
  normalizeServerUrl,
  readSavedServer,
  requireServerConfig,
  resolveServerConfig,
  saveServer,
  type FetchLike,
} from "./server";

const saved = { serverUrl: "https://ophan.example.com", supabaseUrl: "https://sb.example.com", supabaseAnonKey: "anon-saved" };

function fakeFetch(body: unknown, status = 200): FetchLike {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
}

describe("normalizeServerUrl", () => {
  it("strips trailing slashes and defaults to https", () => {
    expect(normalizeServerUrl("ophan.example.com/")).toBe("https://ophan.example.com");
    expect(normalizeServerUrl("http://localhost:3000//")).toBe("http://localhost:3000");
  });
});

describe("resolveServerConfig", () => {
  it("returns null when nothing is configured", async () => {
    expect(await resolveServerConfig({ env: {}, saved: null })).toBeNull();
  });

  it("uses Supabase env vars first, without any network call", async () => {
    const fetchFn = fakeFetch({});
    const config = await resolveServerConfig({
      env: { OPHAN_SUPABASE_URL: "https://ci.supabase.co", OPHAN_SUPABASE_ANON_KEY: "anon-ci" },
      saved,
      fetchFn,
    });
    expect(config).toEqual({ serverUrl: "", supabaseUrl: "https://ci.supabase.co", supabaseAnonKey: "anon-ci" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("falls back to the saved server", async () => {
    expect(await resolveServerConfig({ env: {}, saved })).toEqual(saved);
  });

  it("uses the saved Supabase settings when the explicit server matches it", async () => {
    const fetchFn = fakeFetch({});
    const config = await resolveServerConfig({ env: { OPHAN_SERVER_URL: "https://ophan.example.com/" }, saved, fetchFn });
    expect(config).toEqual(saved);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches /api/config for an explicit server that is not saved", async () => {
    const fetchFn = fakeFetch({ supabaseUrl: "https://other-sb.example.com", supabaseAnonKey: "anon-other" });
    const config = await resolveServerConfig({ server: "http://localhost:3000", env: {}, saved, fetchFn });
    expect(fetchFn).toHaveBeenCalledWith("http://localhost:3000/api/config", expect.anything());
    expect(config).toEqual({ serverUrl: "http://localhost:3000", supabaseUrl: "https://other-sb.example.com", supabaseAnonKey: "anon-other" });
  });

  it("prefers the --server flag over OPHAN_SERVER_URL", async () => {
    const fetchFn = fakeFetch({ supabaseUrl: "u", supabaseAnonKey: "k" });
    await resolveServerConfig({ server: "https://flag.example.com", env: { OPHAN_SERVER_URL: "https://env.example.com" }, saved: null, fetchFn });
    expect(fetchFn).toHaveBeenCalledWith("https://flag.example.com/api/config", expect.anything());
  });
});

describe("requireServerConfig", () => {
  it("throws NoServerConfiguredError pointing at the self-hosting guide", async () => {
    const err = await requireServerConfig({ env: {}, saved: null }).catch((e) => e);
    expect(err).toBeInstanceOf(NoServerConfiguredError);
    expect(err.message).toContain("login --server");
    expect(err.message).toContain("self-hosting.md");
  });
});

describe("fetchServerConfig", () => {
  it("rejects a response without Supabase settings", async () => {
    await expect(fetchServerConfig("https://x.example.com", fakeFetch({ hello: 1 }))).rejects.toThrow("did not return Supabase settings");
  });

  it("reports a non-OK status", async () => {
    await expect(fetchServerConfig("https://x.example.com", fakeFetch({}, 404))).rejects.toThrow("returned 404");
  });

  it("reports an unreachable server", async () => {
    const failing: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
    await expect(fetchServerConfig("https://x.example.com", failing)).rejects.toThrow("Cannot reach the Ophan server");
  });
});

describe("saved server config", () => {
  it("round-trips through the config file and ignores malformed files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ophan-server-"));
    const file = path.join(dir, "config.json");
    expect(readSavedServer(file)).toBeNull();
    saveServer(saved, file);
    expect(readSavedServer(file)).toEqual(saved);
    fs.writeFileSync(file, JSON.stringify({ serverUrl: 1 }));
    expect(readSavedServer(file)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
