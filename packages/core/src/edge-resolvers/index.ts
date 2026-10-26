export type { EdgeResolver, EdgeResolverContext } from "./types";
export { CallEdgeResolver } from "./call";
export { JsxRefEdgeResolver } from "./jsx-ref";
export { CoLocationEdgeResolver } from "./co-location";
export { ImportEdgeResolver } from "./import";

import type { EdgeResolver } from "./types";
import { CallEdgeResolver } from "./call";
import { JsxRefEdgeResolver } from "./jsx-ref";
import { CoLocationEdgeResolver } from "./co-location";
import { ImportEdgeResolver } from "./import";

const registry: EdgeResolver[] = [];

export function registerEdgeResolver(resolver: EdgeResolver): void {
  registry.push(resolver);
}

export function getEdgeResolvers(): readonly EdgeResolver[] {
  return registry;
}

// Register built-in resolvers
registerEdgeResolver(new CallEdgeResolver());
registerEdgeResolver(new JsxRefEdgeResolver());
registerEdgeResolver(new CoLocationEdgeResolver());
registerEdgeResolver(new ImportEdgeResolver());
