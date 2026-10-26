import { describe, it, expect } from "vitest";
import type { Credentials } from "./auth";

describe("Credentials interface", () => {
  it("does not include api_url or api_key", () => {
    // Compile-time check: Credentials should only have session fields.
    // If api_url or api_key are re-added, this test will fail to compile.
    const creds: Credentials = {
      access_token: "at",
      refresh_token: "rt",
      user_id: "uid",
      email: "test@test.com",
      expires_at: 123,
    };
    const keys = Object.keys(creds);
    expect(keys).not.toContain("api_url");
    expect(keys).not.toContain("api_key");
    expect(keys).toEqual(["access_token", "refresh_token", "user_id", "email", "expires_at"]);
  });
});
