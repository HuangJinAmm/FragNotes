import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import { DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH } from "./constants";

interface KgLayoutNode {
  id: number;
  parent_id: number | null;
  pos_x: number | null;
  pos_y: number | null;
}

interface KgLayoutEdge {
  source_id: number;
  target_id: number;
}

/**
 * 用 dagre 计算自动布局；用户手动覆盖坐标（pos_x/pos_y 非空）优先
 */
export function layoutGraph<T extends KgLayoutNode>(
  nodes: T[],
  edges: KgLayoutEdge[],
  direction: "TB" | "LR" = "TB",
): Map<number, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 50, ranksep: 80, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  nodes.forEach((n) => {
    g.setNode(String(n.id), { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT });
  });

  // 父子关系优先作为 dagre 边
  nodes.forEach((n) => {
    if (n.parent_id != null) {
      g.setEdge(String(n.parent_id), String(n.id));
    }
  });
  // 其他边加入布局
  edges.forEach((e) => {
    // 避免重复添加父子边
    const sourceNode = nodes.find((n) => n.id === e.source_id);
    if (sourceNode?.parent_id !== e.target_id) {
      g.setEdge(String(e.source_id), String(e.target_id));
    }
  });

  dagre.layout(g);

  const result = new Map<number, { x: number; y: number }>();
  nodes.forEach((n) => {
    const pos = g.node(String(n.id));
    // 手动覆盖优先
    if (n.pos_x != null && n.pos_y != null) {
      result.set(n.id, { x: n.pos_x, y: n.pos_y });
    } else if (pos) {
      // React Flow 用左上角坐标，dagre 返回中心点
      result.set(n.id, {
        x: pos.x - DEFAULT_NODE_WIDTH / 2,
        y: pos.y - DEFAULT_NODE_HEIGHT / 2,
      });
    } else {
      result.set(n.id, { x: 0, y: 0 });
    }
  });
  return result;
}

/** 将后端 KgNode/KgEdge 转为 React Flow 格式 */
export function toFlowNodes<T extends KgLayoutNode>(
  nodes: T[],
  positions: Map<number, { x: number; y: number }>,
): Node[] {
  return nodes.map((n) => ({
    id: String(n.id),
    type: "kgNode",
    position: positions.get(n.id) ?? { x: 0, y: 0 },
    data: n as unknown as Record<string, unknown>,
  }));
}

export function toFlowEdges<T extends KgLayoutEdge & { id: number; type: string; label: string }>(
  edges: T[],
): Edge[] {
  return edges.map((e) => ({
    id: String(e.id),
    source: String(e.source_id),
    target: String(e.target_id),
    type: "kgEdge",
    label: e.label || e.type,
    data: { type: e.type, label: e.label },
  }));
}
