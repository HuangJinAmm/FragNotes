import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type OnNodeDrag,
  useEdgesState,
  useNodesState,
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
import KgNodeCard, { type KgNodeData, type KgNodeAction } from "./KgNodeCard";
import KgEdgeWithLabel from "./KgEdgeWithLabel";

interface Props {
  graphId: number;
  selectedNodeId: number | null;
  onSelectNode: (id: number | null) => void;
  onRequestEditNode: (id: number) => void;
  /** 处理节点快捷操作（除 edit/toggle-collapse 外，由父组件统一处理） */
  onNodeAction?: (action: KgNodeAction, nodeId: number) => void;
  /** 当前处于"连接到"模式的源节点 id；为 null 表示非连接模式 */
  connectSourceId?: number | null;
}

const nodeTypes = { kgNode: KgNodeCard };
const edgeTypes = { kgEdge: KgEdgeWithLabel };

function KgCanvasInner({
  graphId,
  selectedNodeId,
  onSelectNode,
  onRequestEditNode,
  onNodeAction,
  connectSourceId = null,
}: Props) {
  const { data: nodes = [] } = useKgNodes(graphId);
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

  // 用 useNodesState 让 React Flow 实时管理拖拽位置（核心：拖拽时 onNodesChange 实时更新 state）
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>([]);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // 缓存上次同步时的后端 position key，用于判断后端 position 是否变化（区分"用户拖拽"与"后端重置/同步"）
  const prevBackendPosKeysRef = useRef<Map<string, string>>(new Map());

  // 后端数据变化时智能同步到 flowNodes：
  // - 新节点：用 dagre 计算的位置
  // - 已有节点且后端 position 未变：保留现有 position（可能是用户拖拽中的，避免覆盖）
  // - 已有节点但后端 position 变了（重置布局/拖拽保存完成/多端同步）：用计算的新位置
  useEffect(() => {
    const computed = toFlowNodes(visibleNodes, positions);
    const newBackendPosKeys = new Map<string, string>();
    // 构建后端 position key
    visibleNodes.forEach((vn) => {
      newBackendPosKeys.set(
        String(vn.id),
        `${vn.pos_x ?? "null"}:${vn.pos_y ?? "null"}`,
      );
    });

    setFlowNodes((prev) => {
      const prevMap = new Map(prev.map((n) => [n.id, n]));
      const next = computed.map((n) => {
        const data = n.data as KgNodeData;
        const existing = prevMap.get(n.id);
        const backendPosKey = newBackendPosKeys.get(n.id);
        const prevBackendPosKey = prevBackendPosKeysRef.current.get(n.id);
        const backendPosChanged = backendPosKey !== prevBackendPosKey;
        // 后端 position 变了或节点是新的 → 用计算位置；否则保留现有（用户拖拽中）
        const position = !existing || backendPosChanged ? n.position : existing.position;
        return {
          ...n,
          data: {
            ...data,
            hasChildren: hasChildrenMap.get(data.id) ?? false,
            connectMode: connectSourceId === data.id,
          },
          position,
          selected: selectedNodeId === data.id,
        };
      });
      return next;
    });

    prevBackendPosKeysRef.current = newBackendPosKeys;
  }, [visibleNodes, positions, hasChildrenMap, selectedNodeId, connectSourceId, setFlowNodes]);

  // 同步 edges
  useEffect(() => {
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    setFlowEdges(
      toFlowEdges(edges.filter((e) => visibleIds.has(e.source_id) && visibleIds.has(e.target_id))),
    );
  }, [edges, visibleNodes, setFlowEdges]);

  // 拖拽后保存位置（防抖）
  const [pendingPositions, setPendingPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  useDebouncedEffect(
    () => {
      if (pendingPositions.size === 0) return;
      for (const [id, pos] of pendingPositions) {
        setPos.mutate(
          { id: Number(id), x: pos.x, y: pos.y },
          {
            onSuccess: () => {
              // 通知对应节点闪烁绿点
              window.dispatchEvent(
                new CustomEvent("kg-position-saved", { detail: { id: Number(id) } }),
              );
            },
          },
        );
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
      const id = Number(node.id);
      // 连接模式下：点击非源节点 → 创建边
      if (connectSourceId != null && connectSourceId !== id) {
        onNodeAction?.("connect", id);
        return;
      }
      onSelectNode(id);
    },
    [onSelectNode, connectSourceId, onNodeAction],
  );

  const onPaneClick = useCallback(() => {
    // 连接模式下点击空白 → 取消连接模式
    if (connectSourceId != null) {
      onNodeAction?.("connect", -1);
      return;
    }
    onSelectNode(null);
  }, [onSelectNode, connectSourceId, onNodeAction]);

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

  // 监听节点快捷操作事件（kg-node-action）
  useEffect(() => {
    const actionHandler = (e: Event) => {
      const detail = (e as CustomEvent<{ action: KgNodeAction; id: number }>).detail;
      if (detail.action === "edit") {
        onRequestEditNode(detail.id);
      } else if (detail.action === "toggle-collapse") {
        // 折叠在 Canvas 内部处理（需要查找当前 collapsed 状态）
        const node = nodes.find((n) => n.id === detail.id);
        if (node) {
          setCollapsed.mutate({ id: detail.id, collapsed: !node.collapsed });
        }
      } else {
        // add-child / connect / duplicate / delete 交给父组件
        onNodeAction?.(detail.action, detail.id);
      }
    };
    window.addEventListener("kg-node-action", actionHandler as EventListener);
    return () => window.removeEventListener("kg-node-action", actionHandler as EventListener);
  }, [onRequestEditNode, onNodeAction, nodes, setCollapsed]);

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onNodeDragStop={onNodeDragStop}
      onPaneClick={onPaneClick}
      onConnect={onConnect}
      fitView
      className={connectSourceId != null ? "bg-muted/10 cursor-crosshair" : "bg-muted/10"}
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
