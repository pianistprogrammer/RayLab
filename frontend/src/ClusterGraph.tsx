import { Maximize2, Move, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import type { RayNode } from "./types";

const GRAPH_WIDTH = 1100;
const GRAPH_HEIGHT = 560;
const GRAPH_CENTER = { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
const GRAPH_MIN_ZOOM = 0.45;
const GRAPH_MAX_ZOOM = 2.4;

type GraphPosition = { x: number; y: number };
type GraphViewport = GraphPosition & { k: number };
type GraphNodeKind = "coordinator" | "worker";
type GraphStatusClass = "alive" | "warning" | "down";
export type GraphNodeModel = GraphPosition & {
  id: string;
  kind: GraphNodeKind;
  label: string;
  detail: string;
  metric: string;
  tooltip: string;
  statusClass: GraphStatusClass;
  radius: number;
};
type GraphDragState =
  | { type: "pan"; pointerId: number; startX: number; startY: number; panX: number; panY: number }
  | { type: "node"; pointerId: number; id: string; offsetX: number; offsetY: number };

interface ClusterGraphProps {
  nodes: RayNode[];
  fallbackCoordinatorAddress: string;
  coordinatorRunning: boolean;
}

export function ClusterGraph({ nodes, fallbackCoordinatorAddress, coordinatorRunning }: ClusterGraphProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragState = useRef<GraphDragState | null>(null);
  const [positions, setPositions] = useState<Record<string, GraphPosition>>({});
  const [viewport, setViewport] = useState<GraphViewport>({ x: 0, y: 0, k: 1 });
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  const layoutNodes = useMemo(
    () => buildGraphNodes(nodes, fallbackCoordinatorAddress, coordinatorRunning),
    [coordinatorRunning, fallbackCoordinatorAddress, nodes],
  );

  useEffect(() => {
    setPositions((current) => {
      const next = { ...current };
      const activeIds = new Set(layoutNodes.map((node) => node.id));
      let changed = false;
      for (const node of layoutNodes) {
        if (!next[node.id]) {
          next[node.id] = { x: node.x, y: node.y };
          changed = true;
        }
      }
      for (const id of Object.keys(next)) {
        if (!activeIds.has(id)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [layoutNodes]);

  const graphNodes = layoutNodes.map((node) => ({ ...node, ...(positions[node.id] ?? { x: node.x, y: node.y }) }));
  const coordinator = graphNodes.find((node) => node.kind === "coordinator") ?? graphNodes[0];
  const workers = graphNodes.filter((node) => node.kind === "worker");

  function zoomAt(point: GraphPosition, factor: number) {
    setViewport((current) => {
      const nextScale = clamp(current.k * factor, GRAPH_MIN_ZOOM, GRAPH_MAX_ZOOM);
      const graphPoint = screenToGraph(point, current);
      return {
        k: nextScale,
        x: point.x - graphPoint.x * nextScale,
        y: point.y - graphPoint.y * nextScale,
      };
    });
  }

  function resetGraph() {
    setPositions(Object.fromEntries(layoutNodes.map((node) => [node.id, { x: node.x, y: node.y }])));
    setViewport({ x: 0, y: 0, k: 1 });
  }

  function onWheel(event: ReactWheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const svg = svgRef.current;
    if (svg) zoomAt(svgPoint(svg, event), event.deltaY > 0 ? 0.88 : 1.12);
  }

  function startPan(event: ReactPointerEvent<SVGRectElement>) {
    if (event.button !== 0 || !svgRef.current) return;
    const point = svgPoint(svgRef.current, event);
    dragState.current = { type: "pan", pointerId: event.pointerId, startX: point.x, startY: point.y, panX: viewport.x, panY: viewport.y };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startNodeDrag(event: ReactPointerEvent<SVGGElement>, node: GraphNodeModel) {
    if (event.button !== 0 || !svgRef.current) return;
    event.stopPropagation();
    const point = screenToGraph(svgPoint(svgRef.current, event), viewport);
    dragState.current = { type: "node", pointerId: event.pointerId, id: node.id, offsetX: point.x - node.x, offsetY: point.y - node.y };
    setDraggingId(node.id);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const state = dragState.current;
    const svg = svgRef.current;
    if (!state || !svg || state.pointerId !== event.pointerId) return;
    const point = svgPoint(svg, event);
    if (state.type === "pan") {
      setViewport((current) => ({ ...current, x: state.panX + point.x - state.startX, y: state.panY + point.y - state.startY }));
      return;
    }
    const graphPoint = screenToGraph(point, viewport);
    setPositions((current) => ({
      ...current,
      [state.id]: { x: graphPoint.x - state.offsetX, y: graphPoint.y - state.offsetY },
    }));
  }

  function stopDrag(event: ReactPointerEvent<SVGSVGElement>) {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    dragState.current = null;
    setDraggingId(null);
    setIsPanning(false);
  }

  return (
    <div className="cluster-graph-shell">
      <div className="graph-toolbar" aria-label="Graph controls">
        <button type="button" className="icon-button subtle" title="Zoom in" aria-label="Zoom in" onClick={() => zoomAt(GRAPH_CENTER, 1.18)}><ZoomIn size={17} /></button>
        <button type="button" className="icon-button subtle" title="Zoom out" aria-label="Zoom out" onClick={() => zoomAt(GRAPH_CENTER, 0.84)}><ZoomOut size={17} /></button>
        <button type="button" className="icon-button subtle" title="Reset graph" aria-label="Reset graph" onClick={resetGraph}><Maximize2 size={17} /></button>
      </div>
      <svg
        ref={svgRef}
        className={`cluster-graph${isPanning ? " panning" : ""}`}
        viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
        role="img"
        aria-label="Ray cluster topology graph"
        onWheel={onWheel}
        onPointerMove={onPointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        <defs>
          <radialGradient id="graphCoordinatorFill" cx="36%" cy="28%" r="76%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="62%" stopColor="#dbe8ff" />
            <stop offset="100%" stopColor="#8eb2ef" />
          </radialGradient>
          <radialGradient id="graphWorkerFill" cx="36%" cy="28%" r="76%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="64%" stopColor="#e8eef8" />
            <stop offset="100%" stopColor="#b8c8df" />
          </radialGradient>
          <radialGradient id="graphDownFill" cx="36%" cy="28%" r="76%">
            <stop offset="0%" stopColor="#fff8f8" />
            <stop offset="64%" stopColor="#f5dfe2" />
            <stop offset="100%" stopColor="#db9aa3" />
          </radialGradient>
          {(["alive", "warning", "down"] as const).map((statusClass) => (
            <marker key={statusClass} id={`graphArrow-${statusClass}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L8,4 L0,8 z" className={`graph-arrow ${statusClass}`} />
            </marker>
          ))}
        </defs>
        <rect className="graph-hit-zone" width={GRAPH_WIDTH} height={GRAPH_HEIGHT} onPointerDown={startPan} />
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.k})`}>
          <g className="graph-links">
            {workers.map((node) => {
              const start = circleEdge(coordinator, node, coordinator.radius + 4);
              const end = circleEdge(node, coordinator, node.radius + 8);
              return <line className={`graph-link ${node.statusClass}`} key={`link-${node.id}`} x1={start.x} y1={start.y} x2={end.x} y2={end.y} markerEnd={`url(#graphArrow-${node.statusClass})`} />;
            })}
          </g>
          <g className="graph-node-layer">
            {graphNodes.map((node) => (
              <g
                className={`graph-node graph-node-${node.kind} ${node.statusClass}${draggingId === node.id ? " dragging" : ""}`}
                key={node.id}
                transform={`translate(${node.x} ${node.y})`}
                onPointerDown={(event) => startNodeDrag(event, node)}
                tabIndex={0}
              >
                <title>{node.tooltip}</title>
                <circle className="graph-node-halo" r={node.radius + 11} />
                <circle className="graph-node-body" r={node.radius} />
                <circle className="graph-status-dot" cx={node.radius * 0.62} cy={-node.radius * 0.57} r="7" />
                <text y="-13" textAnchor="middle" className="graph-node-role">{node.kind === "coordinator" ? "COORDINATOR" : "WORKER"}</text>
                <text y="6" textAnchor="middle" className="graph-node-title">{truncateMiddle(node.label, node.kind === "coordinator" ? 22 : 18)}</text>
                <text y="25" textAnchor="middle" className="graph-node-subtitle">{truncateMiddle(node.detail, 20)}</text>
                <text y="42" textAnchor="middle" className="graph-node-metric">{node.metric}</text>
              </g>
            ))}
          </g>
        </g>
      </svg>
      <div className="graph-scale"><Move size={14} />Drag to pan · scroll to zoom · {Math.round(viewport.k * 100)}%</div>
      <div className="graph-legend"><span><i className="coordinator" />Coordinator</span><span><i className="alive" />Alive</span><span><i className="warning" />Unknown</span><span><i className="down" />Down</span></div>
      {nodes.length === 0 && <div className="graph-empty">No State API nodes reported yet. Start or connect to the cluster to populate the topology.</div>}
    </div>
  );
}

export function buildGraphNodes(nodes: RayNode[], fallbackCoordinatorAddress: string, coordinatorRunning: boolean): GraphNodeModel[] {
  const head = nodes.find((node) => node.is_head);
  const result: GraphNodeModel[] = [toCoordinatorNode(head, fallbackCoordinatorAddress, coordinatorRunning)];
  const workers = head ? nodes.filter((node) => node.id !== head.id) : nodes;
  const seenIds = new Map<string, number>();

  workers.forEach((node, index) => {
    const ringSize = 8;
    const ring = Math.floor(index / ringSize);
    const positionInRing = index % ringSize;
    const workersInRing = Math.min(ringSize, workers.length - ring * ringSize);
    const angle = -Math.PI / 2 + (positionInRing / Math.max(1, workersInRing)) * Math.PI * 2 + ring * 0.34;
    const radiusX = 265 + ring * 126;
    const radiusY = 165 + ring * 88;
    const id = uniqueGraphId(`worker:${node.id || node.address || node.name || "unknown"}`, seenIds);
    result.push({
      id,
      kind: "worker",
      label: node.name || node.address || node.id || "Worker",
      detail: node.address || node.status || "Unknown address",
      metric: `${node.cpus.toFixed(1)} CPU · ${node.gpus.toFixed(1)} GPU`,
      tooltip: nodeTooltip("Worker", node),
      statusClass: graphStatusClass(node.status),
      radius: 58,
      x: clamp(GRAPH_CENTER.x + Math.cos(angle) * radiusX, 86, GRAPH_WIDTH - 86),
      y: clamp(GRAPH_CENTER.y + Math.sin(angle) * radiusY, 86, GRAPH_HEIGHT - 86),
    });
  });

  return result;
}

function toCoordinatorNode(head: RayNode | undefined, fallbackAddress: string, coordinatorRunning: boolean): GraphNodeModel {
  const status = head?.status || (coordinatorRunning ? "ALIVE" : "UNKNOWN");
  return {
    id: head ? `coordinator:${head.id}` : "coordinator:fallback",
    kind: "coordinator",
    label: head?.name || "Coordinator",
    detail: head?.address || fallbackAddress || "Not connected",
    metric: head ? `${head.cpus.toFixed(1)} CPU · ${head.gpus.toFixed(1)} GPU` : "Head node",
    tooltip: head ? nodeTooltip("Coordinator", head) : `Coordinator\n${fallbackAddress || "Not connected"}\n${status}`,
    statusClass: graphStatusClass(status),
    radius: 68,
    ...GRAPH_CENTER,
  };
}

function nodeTooltip(role: string, node: RayNode) {
  return `${role}\n${node.name || node.id}\n${node.address || "Unknown address"}\n${node.status}\n${node.cpus.toFixed(1)} CPU · ${node.gpus.toFixed(1)} GPU · ${node.memory_gb.toFixed(1)} GB RAM`;
}

function uniqueGraphId(base: string, seenIds: Map<string, number>) {
  const normalized = base.toLowerCase();
  const count = seenIds.get(normalized) ?? 0;
  seenIds.set(normalized, count + 1);
  return count === 0 ? normalized : `${normalized}:${count + 1}`;
}

function graphStatusClass(status: string): GraphStatusClass {
  const normalized = status.toLowerCase();
  if (normalized.includes("dead") || normalized.includes("fail") || normalized.includes("lost")) return "down";
  if (normalized.includes("alive") || normalized.includes("running")) return "alive";
  return "warning";
}

function svgPoint(svg: SVGSVGElement, event: { clientX: number; clientY: number }): GraphPosition {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const matrix = svg.getScreenCTM();
  if (matrix) {
    const transformed = point.matrixTransform(matrix.inverse());
    return { x: transformed.x, y: transformed.y };
  }
  const rect = svg.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * GRAPH_WIDTH,
    y: ((event.clientY - rect.top) / rect.height) * GRAPH_HEIGHT,
  };
}

function screenToGraph(point: GraphPosition, viewport: GraphViewport): GraphPosition {
  return { x: (point.x - viewport.x) / viewport.k, y: (point.y - viewport.y) / viewport.k };
}

function circleEdge(from: GraphNodeModel, toward: GraphNodeModel, radius: number): GraphPosition {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: from.x + (dx / length) * radius, y: from.y + (dy / length) * radius };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function truncateMiddle(value: string, max: number) {
  if (value.length <= max) return value;
  const keep = Math.max(4, Math.floor((max - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}
