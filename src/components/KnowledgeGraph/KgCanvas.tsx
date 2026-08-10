import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  type Connection,
  type NodeMouseHandler,
  type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  useKgEdges,
  useKgNodes,
  useCreateKgEdge,
  useSetKgNodeCollapsed,
  useSetKgNodePosition,
} from "@/hooks/useKgQueries";
import { useDebouncedEffect } from "@/hooks";
import { layoutGraph, toFlowEdges, toFlowNodes } from "./layout";
import KgNodeCard, { type KgNodeData } from "./KgNodeCard";
import KgEdgeWithLabel from "./KgEdgeWithLabel";

interface Props {
  selectedNodeId: number | null;
  onSelectNode: (id: number | null) => void;
  onRequestEditNode: (id: number) => void;
}

const nodeTypes = { kgNode: KgNodeCard };
const edgeTypes = { kgEdge: KgEdgeWithLabel };

function KgCanvasInner({ selectedNodeId, onSelectNode, onRequestEditNode }: Props) {
  const { data: nodes = [] } = useKgNodes();
  const { data: edges = [] } = useKgEdges();
  const setPos = useSetKgNodePosition();
  const setCollapsed = useSetKgNodeCollapsed();
  const createEdge = useCreateKgEdge();

  // 计算每个节点是否有子节点（用于折叠按钮显示）
  const hasChildrenMap = useMemo(() => {
    const map = new Map<number, boolean>();
    nodes.forEach((n) => {
      if (n.parent_id != null) {
        map.set(n.parent_id, true);
      }
    });
    return map;
  }, [nodes]);

  // 过滤掉折叠节点的后代
  const visibleNodes = useMemo(() => {
    const collapsedSet = new Set<number>();
    nodes.forEach((n) => {
      if (n.collapsed) collapsedSet.add(n.id);
    });
    const hiddenSet = new Set<number>();
    const checkHidden = (n: (typeof nodes)[number]): boolean => {
      if (n.parent_id == null) return false;
      if (hiddenSet.has(n.id)) return true;
      const parent = nodes.find((p) => p.id === n.parent_id);
      if (!parent) return false;
      if (collapsedSet.has(parent.id) || checkHidden(parent)) {
        hiddenSet.add(n.id);
        return true;
      }
      return false;
    };
    return nodes.filter((n) => !checkHidden(n));
  }, [nodes]);

  // 布局
  const positions = useMemo(() => {
    return layoutGraph(visibleNodes, edges);
  }, [visibleNodes, edges]);

  const flowNodes = useMemo(() => {
    return toFlowNodes(visibleNodes, positions).map((n) => {
      const data = n.data as KgNodeData;
      return {
        ...n,
        data: { ...data, hasChildren: hasChildrenMap.get(data.id) ?? false },
        selected: selectedNodeId === data.id,
      };
    });
  }, [visibleNodes, positions, hasChildrenMap, selectedNodeId]);

  const flowEdges = useMemo(() => {
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    return toFlowEdges(edges.filter((e) => visibleIds.has(e.source_id) && visibleIds.has(e.target_id)));
  }, [edges, visibleNodes]);

  // 拖拽后保存位置（防抖）
  const [pendingPositions, setPendingPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  useDebouncedEffect(
    () => {
      if (pendingPositions.size === 0) return;
      for (const [id, pos] of pendingPositions) {
        setPos.mutate({ id: Number(id), x: pos.x, y: pos.y });
      }
      setPendingPositions(new Map());
    },
    500,
    [pendingPositions],
  );

  const onNodeDragStop: OnNodeDrag = useCallback((_evt, node) => {
    setPendingPositions((prev) => {
      const next = new Map(prev);
      next.set(node.id, node.position);
      return next;
    });
  }, []);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_evt, node) => {
      onSelectNode(Number(node.id));
    },
    [onSelectNode],
  );

  const onPaneClick = useCallback(() => {
    onSelectNode(null);
  }, [onSelectNode]);

  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (_evt, node) => {
      onRequestEditNode(Number(node.id));
    },
    [onRequestEditNode],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      createEdge.mutate({
        source_id: Number(connection.source),
        target_id: Number(connection.target),
        edge_type: "related",
        label: "",
      });
    },
    [createEdge],
  );

  // 折叠/展开按钮（通过自定义事件让 KgNodeCard 触发折叠）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id: number; collapsed: boolean }>).detail;
      setCollapsed.mutate(detail);
    };
    window.addEventListener("kg-toggle-collapse", handler as EventListener);
    return () => window.removeEventListener("kg-toggle-collapse", handler as EventListener);
  }, [setCollapsed]);

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onNodeDragStop={onNodeDragStop}
      onPaneClick={onPaneClick}
      onConnect={onConnect}
      fitView
      className="bg-muted/10"
    >
      <Background gap={16} size={1} />
      <Controls />
    </ReactFlow>
  );
}

export default function KgCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <KgCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
