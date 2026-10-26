import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import * as path from "path";
import { PythonParser } from "./python";

const parser = new PythonParser();
const fixturesDir = path.join(__dirname, "__fixtures__");

// Must be synchronous at module level -- describe.skipIf evaluates immediately
let pythonAvailable = false;
try {
  execFileSync("python3", ["--version"], { stdio: "ignore" });
  pythonAvailable = true;
} catch {
  pythonAvailable = false;
}

describe("PythonParser", () => {
  describe.skipIf(!pythonAvailable)("method detection", () => {
    it('class methods get entityType "method"', () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "class-methods.py")
      );

      const getUser = functions.find((f) => f.name === "get_user");
      const createUser = functions.find((f) => f.name === "create_user");

      expect(getUser?.entityType).toBe("method");
      expect(createUser?.entityType).toBe("method");
    });

    it('top-level functions get entityType "function"', () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "class-methods.py")
      );

      const standalone = functions.find((f) => f.name === "standalone");
      expect(standalone?.entityType).toBe("function");
    });
  });

  describe.skipIf(!pythonAvailable)("async function handling", () => {
    it("extracts async def functions", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "simple.py")
      );

      const fetchData = functions.find((f) => f.name === "fetch_data");
      expect(fetchData).toBeDefined();
      expect(fetchData?.language).toBe("python");
    });
  });

  describe.skipIf(!pythonAvailable)("basic extraction", () => {
    it("extracts all functions from simple file", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "simple.py")
      );

      const names = functions.map((f) => f.name);
      expect(names).toContain("greet");
      expect(names).toContain("fetch_data");
      expect(names).toContain("add");
    });

    it("all extracted functions have contentHash set", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "simple.py")
      );

      for (const fn of functions) {
        expect(fn.contentHash).toBeDefined();
        expect(fn.contentHash.length).toBe(64);
      }
    });

    it("all functions have language python", () => {
      const functions = parser.extractFunctions(
        path.join(fixturesDir, "simple.py")
      );

      for (const fn of functions) {
        expect(fn.language).toBe("python");
      }
    });
  });
});
