import { describe, it, expect } from "vitest";
import { JavaScriptModuleResolver } from "./javascript";
import {
  registerModuleResolver,
  getModuleResolver,
  getModuleResolverForFile,
} from "./index";
import type { ModuleResolver } from "../graph";

describe("JavaScriptModuleResolver", () => {
  const resolver = new JavaScriptModuleResolver();

  it("has correct language and extensions", () => {
    expect(resolver.language).toBe("typescript");
    expect(resolver.extensions).toContain(".ts");
    expect(resolver.extensions).toContain(".tsx");
    expect(resolver.extensions).toContain(".js");
    expect(resolver.extensions).toContain(".jsx");
  });

  describe("relative imports", () => {
    it("resolves ./sibling with .ts extension", () => {
      const fileToHashes = new Map<string, Set<string>>();
      fileToHashes.set("/src/utils.ts", new Set(["hash1"]));

      const result = resolver.resolveModuleToFile(
        "./utils",
        "/src/index.ts",
        fileToHashes,
      );
      expect(result).toBe("/src/utils.ts");
    });

    it("resolves ./sibling with .tsx extension", () => {
      const fileToHashes = new Map<string, Set<string>>();
      fileToHashes.set("/src/Component.tsx", new Set(["hash1"]));

      const result = resolver.resolveModuleToFile(
        "./Component",
        "/src/index.ts",
        fileToHashes,
      );
      expect(result).toBe("/src/Component.tsx");
    });

    it("resolves ../parent imports", () => {
      const fileToHashes = new Map<string, Set<string>>();
      fileToHashes.set("/src/helpers.ts", new Set(["hash1"]));

      const result = resolver.resolveModuleToFile(
        "../helpers",
        "/src/sub/index.ts",
        fileToHashes,
      );
      expect(result).toBe("/src/helpers.ts");
    });

    it("resolves directory imports to index files", () => {
      const fileToHashes = new Map<string, Set<string>>();
      fileToHashes.set("/src/components/index.ts", new Set(["hash1"]));

      const result = resolver.resolveModuleToFile(
        "./components",
        "/src/index.ts",
        fileToHashes,
      );
      expect(result).toBe("/src/components/index.ts");
    });

    it("resolves exact file path without extension probing", () => {
      const fileToHashes = new Map<string, Set<string>>();
      fileToHashes.set("/src/data.json", new Set(["hash1"]));

      // Won't match because .json isn't in the probe list
      const result = resolver.resolveModuleToFile(
        "./data.json",
        "/src/index.ts",
        fileToHashes,
      );
      expect(result).toBe("/src/data.json");
    });

    it("returns undefined for unresolvable relative imports", () => {
      const fileToHashes = new Map<string, Set<string>>();
      const result = resolver.resolveModuleToFile(
        "./nonexistent",
        "/src/index.ts",
        fileToHashes,
      );
      expect(result).toBeUndefined();
    });
  });

  describe("workspace package imports", () => {
    const workspaceResolver: ModuleResolver = {
      workspacePackages: new Map([
        [
          "@ophan/core",
          {
            dir: "/packages/core",
            exports: { ".": "./src/index.ts", "./schemas": "./src/schemas.ts" },
          },
        ],
      ]),
      pathAliases: new Map(),
    };

    it("resolves package root import via exports map", () => {
      const fileToHashes = new Map<string, Set<string>>();
      fileToHashes.set("/packages/core/src/index.ts", new Set(["hash1"]));

      const result = resolver.resolveModuleToFile(
        "@ophan/core",
        "/packages/cli/src/index.ts",
        fileToHashes,
        workspaceResolver,
      );
      expect(result).toBe("/packages/core/src/index.ts");
    });

    it("resolves subpath import via exports map", () => {
      const fileToHashes = new Map<string, Set<string>>();
      fileToHashes.set("/packages/core/src/schemas.ts", new Set(["hash1"]));

      const result = resolver.resolveModuleToFile(
        "@ophan/core/schemas",
        "/packages/cli/src/index.ts",
        fileToHashes,
        workspaceResolver,
      );
      expect(result).toBe("/packages/core/src/schemas.ts");
    });

    it("falls back to src/index for package root when no exports match", () => {
      const noExportsResolver: ModuleResolver = {
        workspacePackages: new Map([
          ["@ophan/utils", { dir: "/packages/utils", exports: {} }],
        ]),
        pathAliases: new Map(),
      };
      const fileToHashes = new Map<string, Set<string>>();
      fileToHashes.set("/packages/utils/src/index.ts", new Set(["hash1"]));

      const result = resolver.resolveModuleToFile(
        "@ophan/utils",
        "/packages/cli/src/index.ts",
        fileToHashes,
        noExportsResolver,
      );
      expect(result).toBe("/packages/utils/src/index.ts");
    });

    it("returns undefined for non-workspace bare imports", () => {
      const fileToHashes = new Map<string, Set<string>>();
      const result = resolver.resolveModuleToFile(
        "lodash",
        "/src/index.ts",
        fileToHashes,
        workspaceResolver,
      );
      expect(result).toBeUndefined();
    });
  });

  describe("path alias imports", () => {
    const aliasResolver: ModuleResolver = {
      workspacePackages: new Map(),
      pathAliases: new Map([
        [
          "/src",
          {
            baseUrl: "/src",
            paths: { "@/*": ["./components/*", "./lib/*"] },
          },
        ],
      ]),
    };

    it("resolves wildcard path aliases", () => {
      const fileToHashes = new Map<string, Set<string>>();
      fileToHashes.set("/src/components/Button.tsx", new Set(["hash1"]));

      const result = resolver.resolveModuleToFile(
        "@/Button",
        "/src/pages/home.tsx",
        fileToHashes,
        aliasResolver,
      );
      expect(result).toBe("/src/components/Button.tsx");
    });

    it("tries all alias targets in order", () => {
      const fileToHashes = new Map<string, Set<string>>();
      // Not in components, but in lib
      fileToHashes.set("/src/lib/utils.ts", new Set(["hash1"]));

      const result = resolver.resolveModuleToFile(
        "@/utils",
        "/src/pages/home.tsx",
        fileToHashes,
        aliasResolver,
      );
      expect(result).toBe("/src/lib/utils.ts");
    });

    it("only applies aliases when importer is within the alias scope", () => {
      const fileToHashes = new Map<string, Set<string>>();
      fileToHashes.set("/src/components/Button.tsx", new Set(["hash1"]));

      // Importer is outside /src, so alias should not apply
      const result = resolver.resolveModuleToFile(
        "@/Button",
        "/other/file.ts",
        fileToHashes,
        aliasResolver,
      );
      expect(result).toBeUndefined();
    });
  });

  it("returns undefined without resolver for non-relative imports", () => {
    const fileToHashes = new Map<string, Set<string>>();
    const result = resolver.resolveModuleToFile(
      "@ophan/core",
      "/src/index.ts",
      fileToHashes,
    );
    expect(result).toBeUndefined();
  });
});

describe("Module resolver registry", () => {
  it("resolves TypeScript language", () => {
    const r = getModuleResolver("typescript");
    expect(r).toBeDefined();
    expect(r!.language).toBe("typescript");
  });

  it("resolves JavaScript alias", () => {
    const r = getModuleResolver("javascript");
    expect(r).toBeDefined();
    // Same resolver instance (aliased)
    expect(r).toBe(getModuleResolver("typescript"));
  });

  it("returns undefined for unregistered languages", () => {
    expect(getModuleResolver("go")).toBeUndefined();
    expect(getModuleResolver("rust")).toBeUndefined();
  });

  it("matches .ts files to JavaScript resolver", () => {
    expect(getModuleResolverForFile("/src/app.ts")).toBeDefined();
    expect(getModuleResolverForFile("/src/app.tsx")).toBeDefined();
    expect(getModuleResolverForFile("/src/app.js")).toBeDefined();
    expect(getModuleResolverForFile("/src/app.jsx")).toBeDefined();
  });

  it("returns undefined for unhandled extensions", () => {
    expect(getModuleResolverForFile("/src/app.py")).toBeUndefined();
    expect(getModuleResolverForFile("/src/app.go")).toBeUndefined();
  });

  it("allows registering custom resolvers", () => {
    registerModuleResolver({
      language: "test-lang",
      extensions: [".test"],
      resolveModuleToFile: () => undefined,
    });
    expect(getModuleResolver("test-lang")).toBeDefined();
    expect(getModuleResolverForFile("foo.test")).toBeDefined();
  });
});
