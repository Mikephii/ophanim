import { FC, useRef, useEffect, useState, useCallback, useMemo } from "react";
import cytoscape from "cytoscape";
import { useWebviewQuery } from "../use-webview-query";
import { Skeleton } from "../components/ui/skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { IconVectorTriangle } from "@tabler/icons-react";

// ── Types ────────────────────────────────────────────────────────────

type GraphNode = {
  id: string;
  label: string;
  filePath: string;
  communityId: string;
  description: string;
  securityFlags: string[];
  issueCount: number;
};

type GraphEdge = {
  source: string;
  target: string;
  edgeType: string;
  weight: number;
};

type GraphCommunity = {
  communityId: string;
  title: string;
  memberCount: number;
};

type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: GraphCommunity[];
};

// ── Constants ────────────────────────────────────────────────────────

const EDGE_TYPES = [
  "call",
  "import",
  "co_location",
  "jsx_ref",
  "type_ref",
  "transitive_call",
  "co_caller",
] as const;

const EDGE_TYPE_LABELS: Record<string, string> = {
  call: "Call",
  import: "Import",
  co_location: "Co-location",
  jsx_ref: "JSX Ref",
  type_ref: "Type Ref",
  transitive_call: "Transitive",
  co_caller: "Co-caller",
};

/** Force-directed layout, roomy enough that dense communities don't stack labels on each other. */
const LAYOUT = {
  name: "cose",
  nodeRepulsion: () => 60000,
  idealEdgeLength: () => 140,
  nodeOverlap: 40,
  componentSpacing: 120,
  padding: 40,
  gravity: 0.25,
  numIter: 1000,
};

/** Generate visually distinct colors for communities using golden angle */
function communityColors(count: number): string[] {
  const colors: string[] = [];
  const goldenAngle = 137.508;
  for (let i = 0; i < count; i++) {
    const hue = (i * goldenAngle) % 360;
    colors.push(`hsl(${hue}, 65%, 55%)`);
  }
  return colors;
}

/** Edge style based on edge type */
function edgeLineStyle(edgeType: string): "solid" | "dashed" | "dotted" {
  switch (edgeType) {
    case "call":
    case "import":
      return "solid";
    case "co_location":
    case "co_caller":
      return "dashed";
    default:
      return "dotted";
  }
}

// ── Component ────────────────────────────────────────────────────────

export const GraphView: FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [visibleEdgeTypes, setVisibleEdgeTypes] = useState<Set<string>>(
    () => new Set(EDGE_TYPES),
  );
  const [colorByCommunity, setColorByCommunity] = useState(true);

  const { data, isLoading, error, refetch } = useWebviewQuery<GraphData>("getGraphData");

  // Build community → color mapping
  const communityColorMap = useMemo(() => {
    if (!data) return new Map<string, string>();
    const ids = [...new Set(data.nodes.map((n) => n.communityId).filter(Boolean))].sort();
    const colors = communityColors(ids.length);
    const map = new Map<string, string>();
    ids.forEach((id, i) => map.set(id, colors[i]));
    return map;
  }, [data]);

  // Node color resolver
  const getNodeColor = useCallback(
    (node: GraphNode): string => {
      if (node.issueCount > 0) return "#ef4444"; // red for security issues
      if (!colorByCommunity || !node.communityId) return "#6b7280"; // gray default
      return communityColorMap.get(node.communityId) ?? "#6b7280";
    },
    [colorByCommunity, communityColorMap],
  );

  // Edge type counts for toggle labels
  const edgeTypeCounts = useMemo(() => {
    if (!data) return new Map<string, number>();
    const counts = new Map<string, number>();
    for (const e of data.edges) {
      counts.set(e.edgeType, (counts.get(e.edgeType) ?? 0) + 1);
    }
    return counts;
  }, [data]);

  // Build Cytoscape elements
  const elements = useMemo(() => {
    if (!data) return [];

    const nodeElements: cytoscape.ElementDefinition[] = data.nodes.map((n) => ({
      group: "nodes" as const,
      data: {
        id: n.id,
        label: n.label,
        filePath: n.filePath,
        communityId: n.communityId,
        description: n.description,
        issueCount: n.issueCount,
        securityFlags: n.securityFlags,
        nodeColor: getNodeColor(n),
      },
    }));

    const edgeElements: cytoscape.ElementDefinition[] = data.edges
      .filter((e) => visibleEdgeTypes.has(e.edgeType))
      .map((e, i) => ({
        group: "edges" as const,
        data: {
          id: `e${i}`,
          source: e.source,
          target: e.target,
          edgeType: e.edgeType,
          weight: e.weight,
          lineStyle: edgeLineStyle(e.edgeType),
        },
      }));

    return [...nodeElements, ...edgeElements];
  }, [data, visibleEdgeTypes, getNodeColor]);

  // Initialize / update Cytoscape
  useEffect(() => {
    if (!containerRef.current || elements.length === 0) return;

    // Destroy previous instance if it exists
    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }

    // Cytoscape draws on a canvas, which can't resolve CSS variables: read the theme colors here.
    const themeColor = (name: string, fallback: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
      getComputedStyle(document.body).getPropertyValue(name).trim() ||
      fallback;
    const labelColor = themeColor("--vscode-editor-foreground", "#d4d4d4");
    const labelOutline = themeColor("--vscode-editor-background", "#1e1e1e");

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "background-color": "data(nodeColor)",
            width: 20,
            height: 20,
            "font-size": "10px",
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 4,
            color: labelColor,
            "text-outline-width": 2,
            "text-outline-color": labelOutline,
            "min-zoomed-font-size": 8,
          },
        },
        {
          selector: "node:selected",
          style: {
            "border-width": 3,
            "border-color": "#3b82f6",
            width: 28,
            height: 28,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1,
            "line-color": "#555",
            "line-style": "data(lineStyle)" as cytoscape.Css.LineStyle,
            "curve-style": "bezier",
            opacity: 0.5,
            "target-arrow-shape": "triangle",
            "target-arrow-color": "#555",
            "arrow-scale": 0.6,
          },
        },
        {
          selector: "edge[edgeType = 'call'], edge[edgeType = 'import']",
          style: {
            width: 2,
            opacity: 0.7,
            "line-color": "#7c9cbf",
            "target-arrow-color": "#7c9cbf",
          },
        },
      ],
      layout: { ...LAYOUT, animate: false } as cytoscape.LayoutOptions,
      minZoom: 0.2,
      // Small graphs would otherwise be fitted at a huge zoom with giant labels
      maxZoom: 2,
    });

    // Click handler for nodes
    cy.on("tap", "node", (evt) => {
      const nodeData = evt.target.data();
      setSelectedNode({
        id: nodeData.id,
        label: nodeData.label,
        filePath: nodeData.filePath,
        communityId: nodeData.communityId,
        description: nodeData.description,
        securityFlags: nodeData.securityFlags ?? [],
        issueCount: nodeData.issueCount ?? 0,
      });
    });

    // Click on background to deselect
    cy.on("tap", (evt) => {
      if (evt.target === cy) {
        setSelectedNode(null);
      }
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [elements]);

  // Toggle edge type visibility
  const toggleEdgeType = useCallback((edgeType: string) => {
    setVisibleEdgeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(edgeType)) {
        next.delete(edgeType);
      } else {
        next.add(edgeType);
      }
      return next;
    });
  }, []);

  // Re-layout
  const handleRelayout = useCallback(() => {
    if (!cyRef.current) return;
    cyRef.current
      .layout({ ...LAYOUT, animate: true, animationDuration: 500 } as cytoscape.LayoutOptions)
      .run();
  }, []);

  // Fit to viewport
  const handleFit = useCallback(() => {
    cyRef.current?.fit(undefined, 30);
  }, []);

  // Loading
  if (isLoading && !data) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  // Error
  if (error && !data) {
    return <ErrorState message={error} onRetry={refetch} />;
  }

  // Empty
  if (!data) {
    return (
      <EmptyState
        icon={<IconVectorTriangle className="size-10" />}
        title="No graph data available"
        description="Run ophan watch to analyze your codebase and build the function graph."
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Controls bar */}
      <div className="p-2 border-b border-border space-y-2">
        {/* Edge type filters */}
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mr-1">
            Edges
          </span>
          {EDGE_TYPES.map((et) => {
            const count = edgeTypeCounts.get(et) ?? 0;
            return (
              <button
                key={et}
                onClick={() => toggleEdgeType(et)}
                className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                  visibleEdgeTypes.has(et)
                    ? "bg-primary/20 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {EDGE_TYPE_LABELS[et] ?? et}{count > 0 ? ` (${count})` : ""}
              </button>
            );
          })}
        </div>

        {/* Actions */}
        <div className="flex gap-2 items-center">
          <button
            onClick={() => setColorByCommunity((prev) => !prev)}
            className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
              colorByCommunity
                ? "bg-primary/20 text-primary"
                : "bg-muted text-muted-foreground"
            }`}
          >
            Color by community
          </button>
          <button
            onClick={handleRelayout}
            className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
          >
            Re-layout
          </button>
          <button
            onClick={handleFit}
            className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
          >
            Fit
          </button>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {data.nodes.length} nodes, {data.edges.filter((e) => visibleEdgeTypes.has(e.edgeType)).length} edges
          </span>
        </div>
      </div>

      {/* Graph canvas */}
      <div ref={containerRef} className="flex-1 min-h-[400px]" />

      {/* Node detail panel */}
      {selectedNode && (
        <div className="p-3 border-t border-border space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{selectedNode.label}</span>
            {selectedNode.issueCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/20 text-destructive">
                {selectedNode.issueCount} issue{selectedNode.issueCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground truncate">
            {selectedNode.filePath}
          </p>
          {selectedNode.description && (
            <p className="text-[11px] text-foreground/80 line-clamp-2">
              {selectedNode.description}
            </p>
          )}
          {selectedNode.communityId && (
            <p className="text-[10px] text-muted-foreground">
              Community: {communityColorMap.has(selectedNode.communityId)
                ? data.communities.find((c) => c.communityId === selectedNode.communityId)?.title ?? selectedNode.communityId
                : selectedNode.communityId}
            </p>
          )}
          {selectedNode.securityFlags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {selectedNode.securityFlags.map((flag) => (
                <span
                  key={flag}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/10 text-destructive"
                >
                  {flag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Community legend */}
      {colorByCommunity && data.communities.length > 0 && (
        <div className="p-2 border-t border-border">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Communities
          </span>
          <div className="flex flex-wrap gap-2 mt-1">
            {data.communities.map((c) => (
              <div key={c.communityId} className="flex items-center gap-1">
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: communityColorMap.get(c.communityId) ?? "#6b7280" }}
                />
                <span className="text-[10px] text-muted-foreground">
                  {c.title} ({c.memberCount})
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
