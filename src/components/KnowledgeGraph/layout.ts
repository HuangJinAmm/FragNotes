import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import { DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH, MEMO_NODE_HEIGHT, MEMO_NODE_WIDTH } from "./constants";

interface KgLayoutNode {
  id: string;
  parent_id: string | null;
  pos_x: number | null;
  pos_y: number | null;
  /** 节点类型：知识节点（默认）或笔记子节点 */
  kind?: "memo" | "more";
}

interface KgLayoutEdge {
  source_id: string;
  target_id: string;
}

/**
 * 用 dagre 计算自动布局；用户手动覆盖坐标（pos_x/pos_y 非空）优先。
 * 笔记子节点（kind=memo/more）不使用手动坐标，始终用 dagre 计算。
 */
export function layoutGraph<T extends KgLayoutNode>(
  nodes: T[],
  edges: KgLayoutEdge[],
  direction: "TB" | "LR" = "TB",
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 50, ranksep: 80, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  nodes.forEach((n) => {
    const isMemo = n.kind === "memo" || n.kind === "more";
    g.setNode(n.id, {
      width: isMemo ? MEMO_NODE_WIDTH : DEFAULT_NODE_WIDTH,
      height: isMemo ? MEMO_NODE_HEIGHT : DEFAULT_NODE_HEIGHT,
    });
  });

  // 父子关系优先作为 dagre 边
  nodes.forEach((n) => {
    if (n.parent_id != null) {
      g.setEdge(n.parent_id, n.id);
    }
  });
  // 其他边加入布局
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  edges.forEach((e) => {
    // 避免重复添加父子边，且确保两端节点都存在
    const sourceNode = nodes.find((n) => n.id === e.source_id);
    if (sourceNode?.parent_id !== e.target_id && nodeIdSet.has(e.source_id) && nodeIdSet.has(e.target_id)) {
      g.setEdge(e.source_id, e.target_id);
    }
  });

  dagre.layout(g);

  const result = new Map<string, { x: number; y: number }>();
  nodes.forEach((n) => {
    const pos = g.node(n.id);
    const isMemo = n.kind === "memo" || n.kind === "more";
    const w = isMemo ? MEMO_NODE_WIDTH : DEFAULT_NODE_WIDTH;
    const h = isMemo ? MEMO_NODE_HEIGHT : DEFAULT_NODE_HEIGHT;
    // 手动覆盖优先（仅知识节点）
    if (!isMemo && n.pos_x != null && n.pos_y != null) {
      result.set(n.id, { x: n.pos_x, y: n.pos_y });
    } else if (pos) {
      // React Flow 用左上角坐标，dagre 返回中心点
      result.set(n.id, {
        x: pos.x - w / 2,
        y: pos.y - h / 2,
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
  positions: Map<string, { x: number; y: number }>,
): Node[] {
  return nodes.map((n) => ({
    id: n.id,
    type: n.kind === "memo" ? "kgMemoNode" : n.kind === "more" ? "kgMoreNode" : "kgNode",
    position: positions.get(n.id) ?? { x: 0, y: 0 },
    data: n as unknown as Record<string, unknown>,
    // 所有节点均可拖拽；笔记子节点的拖拽位置不持久化（在 onNodeDragStop 中跳过）
    draggable: true,
  }));
}

export function toFlowEdges<T extends KgLayoutEdge & { id: string; type: string; label: string }>(
  edges: T[],
): Edge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source_id,
    target: e.target_id,
    type: "kgEdge",
    label: e.label || e.type,
    data: { type: e.type, label: e.label },
  }));
}
