import { describe, it, expect } from "vitest";
import * as path from "path";
import { TypeScriptParser } from "./typescript";

const parser = new TypeScriptParser();
const fixturesDir = path.join(__dirname, "__fixtures__");

describe("TypeScriptParser", () => {
  describe("name extraction", () => {
    it("extracts name from const arrow function declarations", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "arrow-functions.ts")
      );
      const names = functions.map((f) => f.name);

      expect(names).toContain("greet");
      expect(names).toContain("add");
      expect(names).toContain("handler");
    });

    it("skips unnamed default export arrows", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "arrow-functions.ts")
      );
      const names = functions.map((f) => f.name);

      // The default export `(x: number) => x * 2` has no variable declaration parent
      // so it should not appear in the extracted functions
      const unnamed = functions.filter(
        (f) => f.name === null || f.name === undefined
      );
      expect(unnamed).toHaveLength(0);
    });

    it("skips callback arrows without variable declaration parent", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "arrow-functions.ts")
      );
      const names = functions.map((f) => f.name);

      // The `(n) => n * 2` inside .map() should not appear
      // (its parent is a CallExpression argument, not a VariableDeclaration)
      expect(names).not.toContain("n");
    });
  });

  describe("entity type detection", () => {
    it('class methods get entityType "method"', () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "class-methods.ts")
      );

      const getUser = functions.find((f) => f.name === "getUser");
      const createUser = functions.find((f) => f.name === "createUser");

      expect(getUser?.entityType).toBe("method");
      expect(createUser?.entityType).toBe("method");
    });

    it('standalone functions get entityType "function"', () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "class-methods.ts")
      );

      const standalone = functions.find((f) => f.name === "standalone");
      expect(standalone?.entityType).toBe("function");
    });
  });

  describe("language detection", () => {
    it(".ts files get language typescript", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "class-methods.ts")
      );
      for (const fn of functions) {
        expect(fn.language).toBe("typescript");
      }
    });
  });

  describe("call extraction", () => {
    it("extracts direct function calls but not method calls", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "call-extraction.ts")
      );
      const handler = functions.find((f) => f.name === "handler");
      expect(handler).toBeDefined();
      expect(handler!.calls).toContain("validate");
      expect(handler!.calls).toContain("initDb");
      // Method calls should NOT be extracted
      expect(handler!.calls).not.toContain("prepare");
      expect(handler!.calls).not.toContain("log");
      expect(handler!.calls).not.toContain("json");
      expect(handler!.calls).not.toContain("map");
    });
  });

  describe("JSX ref extraction", () => {
    it("extracts JSX component references as jsxRefs (not calls)", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "jsx-components.tsx")
      );
      const loginForm = functions.find((f) => f.name === "LoginForm");
      expect(loginForm).toBeDefined();
      expect(loginForm!.jsxRefs).toContain("Button");
      expect(loginForm!.jsxRefs).toContain("Card");
      // JSX refs should NOT be in calls
      expect(loginForm!.calls).not.toContain("Button");
      expect(loginForm!.calls).not.toContain("Card");
      // HTML elements should NOT be extracted
      expect(loginForm!.jsxRefs).not.toContain("div");
    });

    it("keeps direct function calls in calls (not jsxRefs)", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "jsx-components.tsx")
      );
      const loginForm = functions.find((f) => f.name === "LoginForm");
      expect(loginForm!.calls).toContain("validate");
      // validate is a function call, not a JSX ref
      expect(loginForm!.jsxRefs).not.toContain("validate");
    });

    it("captures JSX references in nested components", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "jsx-components.tsx")
      );
      const settingsPage = functions.find((f) => f.name === "SettingsPage");
      expect(settingsPage).toBeDefined();
      expect(settingsPage!.jsxRefs).toContain("LoginForm");
      // HTML elements should not be captured
      expect(settingsPage!.jsxRefs).not.toContain("section");
      expect(settingsPage!.jsxRefs).not.toContain("h1");
    });
  });

  describe("import extraction", () => {
    it("excludes import type declarations from imports", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "type-imports.ts")
      );
      const processFile = functions.find((f) => f.name === "processFile");
      expect(processFile).toBeDefined();

      // "import type { FunctionInfo, ImportRef } from ..." should be completely excluded
      const sharedTypeImport = processFile!.imports!.find(
        (i) => i.module === "../shared" && i.names.includes("FunctionInfo")
      );
      expect(sharedTypeImport).toBeUndefined();
    });

    it("excludes individual type specifiers from named imports", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "type-imports.ts")
      );
      const processFile = functions.find((f) => f.name === "processFile");
      expect(processFile).toBeDefined();

      // "import { resolve, type ParsedPath } from 'path'" should include resolve but not ParsedPath
      const pathImport = processFile!.imports!.find(
        (i) => i.module === "path"
      );
      expect(pathImport).toBeDefined();
      expect(pathImport!.names).toContain("resolve");
      expect(pathImport!.names).not.toContain("ParsedPath");
    });

    it("keeps runtime imports in the imports list", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "type-imports.ts")
      );
      const processFile = functions.find((f) => f.name === "processFile");
      expect(processFile).toBeDefined();

      // computeHash should be in the shared import
      const sharedRuntimeImport = processFile!.imports!.find(
        (i) => i.module === "../shared" && i.names.includes("computeHash")
      );
      expect(sharedRuntimeImport).toBeDefined();

      // fs namespace import should be present
      const fsImport = processFile!.imports!.find((i) => i.module === "fs");
      expect(fsImport).toBeDefined();
      expect(fsImport!.names).toContain("fs");
    });
  });

  describe("typed const arrow components", () => {
    it("extracts calls from const arrow function with FC type annotation", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "typed-arrow-component.tsx")
      );
      const header = functions.find((f) => f.name === "Header");
      expect(header).toBeDefined();
      // getViewTitle(route) is a direct function call inside the component body
      expect(header!.calls).toContain("getViewTitle");
    });

    it("extracts JSX refs from typed const arrow components", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "typed-arrow-component.tsx")
      );
      const header = functions.find((f) => f.name === "Header");
      expect(header).toBeDefined();
      expect(header!.jsxRefs).toContain("Logo");
    });

    it("extracts runtime import names (excludes type imports)", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "typed-arrow-component.tsx")
      );
      const header = functions.find((f) => f.name === "Header");
      expect(header).toBeDefined();
      const navImport = header!.imports!.find((i) => i.module === "../navigation");
      expect(navImport).toBeDefined();
      // getViewTitle is a runtime import, Route is type-only
      expect(navImport!.names).toContain("getViewTitle");
      expect(navImport!.names).not.toContain("Route");
    });
  });

  describe("edge cases", () => {
    it("file with no functions returns empty array", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "no-functions.ts")
      );
      expect(functions).toEqual([]);
    });

    it("all extracted functions have contentHash set", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "arrow-functions.ts")
      );
      for (const fn of functions) {
        expect(fn.contentHash).toBeDefined();
        expect(fn.contentHash.length).toBe(64); // SHA256 hex
      }
    });

    it("same source code produces same hash (deterministic)", () => {
      const fns1 = parser.extractFunctions(
        path.join(fixturesDir, "class-methods.ts")
      );
      const fns2 = parser.extractFunctions(
        path.join(fixturesDir, "class-methods.ts")
      );

      expect(fns1.map((f) => f.contentHash)).toEqual(
        fns2.map((f) => f.contentHash)
      );
    });
  });
});
