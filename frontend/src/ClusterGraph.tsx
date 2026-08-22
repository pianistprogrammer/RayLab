import { Maximize2, Move, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import type { RayNode } from "./types";

const GRAPH_WIDTH = 1100;
const GRAPH_HEIGHT = 560;
const GRAPH_CENTER = { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
const GRAPH_MIN_ZOOM = 0.45;
const GRAPH_MAX_ZOOM = 2.4;

const COORDINATOR_RADIUS = 32;
const WORKER_RADIUS = 22;

const SIM_REPULSION = 24000;
const SIM_SPRING = 0.04;
const SIM_LINK_DISTANCE = 185;
const SIM_GRAVITY = 0.03;
const SIM_DAMPING = 0.82;
const SIM_ALPHA_DECAY = 0.981;
const SIM_MIN_ALPHA = 0.008;

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
type SimNodeState = { x: number; y: number; vx: number; vy: number };
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
  const simRef = useRef<Record<string, SimNodeState>>({});
  const alphaRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const [positions, setPositions] = useState<Record<string, GraphPosition>>({});
  const [viewport, setViewport] = useState<GraphViewport>({ x: 0, y: 0, k: 1 });
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  const layoutNodes = useMemo(
    () => buildGraphNodes(nodes, fallbackCoordinatorAddress, coordinatorRunning),
    [coordinatorRunning, fallbackCoordinatorAddress, nodes],
  );

  function reheat(amount: number) {
    alphaRef.current = Math.max(alphaRef.current, amount);
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(tick);
  }

  function tick() {
    simulate(layoutNodes, simRef.current, alphaRef.current, dragState.current?.type === "node" ? dragState.current.id : null);
    setPositions(Object.fromEntries(Object.entries(simRef.current).map(([id, state]) => [id, { x: state.x, y: state.y }])));
    alphaRef.current *= SIM_ALPHA_DECAY;
    if (alphaRef.current <= SIM_MIN_ALPHA) {
      alphaRef.current = 0;
      rafRef.current = null;
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  useEffect(() => {
    const sim = simRef.current;
    let changed = false;
    for (const node of layoutNodes) {
      if (!sim[node.id]) {
        sim[node.id] = { x: node.x, y: node.y, vx: 0, vy: 0 };
        changed = true;
      }
    }
    for (const id of Object.keys(sim)) {
      if (!layoutNodes.some((node) => node.id === id)) {
        delete sim[id];
        changed = true;
      }
    }
    if (changed) setPositions(Object.fromEntries(Object.entries(sim).map(([id, state]) => [id, { x: state.x, y: state.y }])));
    reheat(changed ? 0.7 : 0.3);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
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
    const next = Object.fromEntries(layoutNodes.map((node) => [node.id, { x: node.x, y: node.y, vx: 0, vy: 0 }]));
    simRef.current = next;
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
    const sim = simRef.current[state.id];
    if (sim) {
      sim.x = graphPoint.x - state.offsetX;
      sim.y = graphPoint.y - state.offsetY;
      sim.vx = 0;
      sim.vy = 0;
    }
    setPositions((current) => ({
      ...current,
      [state.id]: { x: graphPoint.x - state.offsetX, y: graphPoint.y - state.offsetY },
    }));
    reheat(0.25);
  }

  function stopDrag(event: ReactPointerEvent<SVGSVGElement>) {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    dragState.current = null;
    setDraggingId(null);
    setIsPanning(false);
    if (state.type === "node") reheat(0.4);
  }

  return (
    <div className="cluster-graph-shell">
      <div className="graph-toolbar" aria-label="Graph controls">
        <button type="button" className="icon-button subtle" title="Zoom in" aria-label="Zoom in" onClick={() => zoomAt(GRAPH_CENTER, 1.18)}><ZoomIn size={17} /></button>
        <button type="button" className="icon-button subtle" title="Zoom out" aria-label="Zoom out" onClick={() => zoomAt(GRAPH_CENTER, 0.84)}><ZoomOut size={17} /></button>
        <button type="button" className="icon-button subtle" title="Reset layout" aria-label="Reset layout" onClick={resetGraph}><Maximize2 size={17} /></button>
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
        </defs>
        <rect className="graph-hit-zone" width={GRAPH_WIDTH} height={GRAPH_HEIGHT} onPointerDown={startPan} />
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.k})`}>
          <g className="graph-links">
            {workers.map((node) => {
              const start = circleEdge(coordinator, node, coordinator.radius + 2);
              const end = circleEdge(node, coordinator, node.radius + 3);
              return <line className={`graph-link ${node.statusClass}`} key={`link-${node.id}`} x1={start.x} y1={start.y} x2={end.x} y2={end.y} />;
            })}
          </g>
          <g className="graph-node-layer">
            {graphNodes.map((node) => {
              const isHovered = hoveredId === node.id || draggingId === node.id;
              return (
                <g
                  className={`graph-node graph-node-${node.kind} ${node.statusClass}${isHovered ? " hovered" : ""}${draggingId === node.id ? " dragging" : ""}`}
                  key={node.id}
                  transform={`translate(${node.x} ${node.y})`}
                  onPointerDown={(event) => startNodeDrag(event, node)}
                  onPointerEnter={() => setHoveredId(node.id)}
                  onPointerLeave={() => setHoveredId((current) => (current === node.id ? null : current))}
                  onFocus={() => setHoveredId(node.id)}
                  onBlur={() => setHoveredId((current) => (current === node.id ? null : current))}
                  tabIndex={0}
                >
                  <title>{node.tooltip}</title>
                  <circle className="graph-node-halo" r={node.radius + 9} />
                  <circle className="graph-node-body" r={node.radius} />
                  <circle className="graph-status-dot" cx={node.radius * 0.72} cy={-node.radius * 0.72} r="5" />
                  {node.kind === "coordinator" && <text y="1" textAnchor="middle" className="graph-node-glyph">H</text>}
                  <text y={node.radius + 14} textAnchor="middle" className="graph-node-caption">{truncateMiddle(node.label, 24)}</text>
                  {isHovered && (
                    <>
                      <text y={node.radius + 27} textAnchor="middle" className="graph-node-caption-sub">{truncateMiddle(node.detail, 26)}</text>
                      <text y={node.radius + 39} textAnchor="middle" className="graph-node-caption-metric">{node.metric}</text>
                    </>
                  )}
                </g>
              );
            })}
          </g>
        </g>
      </svg>
      <div className="graph-scale"><Move size={14} />Drag to pan · scroll to zoom · {Math.round(viewport.k * 100)}%</div>
      <div className="graph-legend"><span><i className="coordinator" />Head</span><span><i className="alive" />Alive</span><span><i className="warning" />Unknown</span><span><i className="down" />Down</span></div>
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
    const radiusX = 230 + ring * 120;
    const radiusY = 145 + ring * 82;
    const id = uniqueGraphId(`worker:${node.id || node.address || node.name || "unknown"}`, seenIds);
    result.push({
      id,
      kind: "worker",
      label: node.name || node.address || node.id || "Worker",
      detail: node.address || node.status || "Unknown address",
      metric: `${node.cpus.toFixed(1)} CPU · ${node.gpus.toFixed(1)} GPU`,
      tooltip: nodeTooltip("Worker", node),
      statusClass: graphStatusClass(node.status),
      radius: WORKER_RADIUS,
      x: clamp(GRAPH_CENTER.x + Math.cos(angle) * radiusX, 60, GRAPH_WIDTH - 60),
      y: clamp(GRAPH_CENTER.y + Math.sin(angle) * radiusY, 60, GRAPH_HEIGHT - 60),
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
    radius: COORDINATOR_RADIUS,
    ...GRAPH_CENTER,
  };
}

function simulate(
  layoutNodes: GraphNodeModel[],
  sim: Record<string, SimNodeState>,
  alpha: number,
  pinnedId: string | null,
) {
  const ids = layoutNodes.filter((node) => sim[node.id]).map((node) => node.id);
  for (let i = 0; i < ids.length; i++) {
    const a = sim[ids[i]];
    for (let j = i + 1; j < ids.length; j++) {
      const b = sim[ids[j]];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        dx = Math.random() - 0.5;
        dy = Math.random() - 0.5;
        d2 = 1;
      }
      const force = (SIM_REPULSION / d2) * alpha;
      const fx = (dx / Math.sqrt(d2)) * force;
      const fy = (dy / Math.sqrt(d2)) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }
  const coordinator = layoutNodes.find((node) => node.kind === "coordinator");
  for (const node of layoutNodes) {
    if (!coordinator || node.kind === "coordinator" || !sim[node.id] || !sim[coordinator.id]) continue;
    const a = sim[node.id];
    const b = sim[coordinator.id];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.hypot(dx, dy) || 1;
    const force = (distance - SIM_LINK_DISTANCE) * SIM_SPRING * alpha;
    a.vx += (dx / distance) * force;
    a.vy += (dy / distance) * force;
    b.vx -= (dx / distance) * force;
    b.vy -= (dy / distance) * force;
  }
  for (const id of ids) {
    const state = sim[id];
    state.vx += (GRAPH_CENTER.x - state.x) * SIM_GRAVITY * alpha;
    state.vy += (GRAPH_CENTER.y - state.y) * SIM_GRAVITY * alpha;
    if (id === pinnedId) {
      state.vx = 0;
      state.vy = 0;
      continue;
    }
    state.vx *= SIM_DAMPING;
    state.vy *= SIM_DAMPING;
    state.x = clamp(state.x + state.vx, 46, GRAPH_WIDTH - 46);
    state.y = clamp(state.y + state.vy, 40, GRAPH_HEIGHT - 40);
  }
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
