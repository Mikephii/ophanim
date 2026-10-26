// Fixture: verifies that import type and { type X } are excluded from imports

import type { FunctionInfo, ImportRef } from "../shared";
import { computeHash } from "../shared";
import { resolve, type ParsedPath } from "path";
import * as fs from "fs";

export function processFile(filePath: string): string {
  return computeHash(fs.readFileSync(filePath));
}
