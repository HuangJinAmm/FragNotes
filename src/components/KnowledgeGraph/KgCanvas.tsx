import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
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
import { invoke } from "@tauri-apps/api/core";
import {
  kgKeys,
  useKgEdges,
  useKgNodes,
  useCreateKgEdge,
  useSetKgNodeCollapsed,
  useSetKgNodePosition,
} from "@/hooks/useKgQueries";
import { useDebouncedEffect } from "@/hooks";
import { layoutGraph, toFlowEdges, toFlowNodes } from "./layout";
import KgNodeCard, { type KgNodeData, type KgNodeAction } from "./KgNodeCard";
import KgMemoNodeCard, { type KgMemoNodeData } from "./KgMemoNodeCard";
import KgMoreNodeCard, { type KgMoreNodeData } from "./KgMoreNodeCard";
import KgEdgeWithLabel from "./KgEdgeWithLabel";
import KgMemoPreviewDialog from "./KgMemoPreviewDialog";
import { MEMO_DISPLAY_COUNT } from "./constants";
import type { KgEdge, KgNode } from "@/types/kg";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";

// 模块级常量：避免 data 为 undefined 时 `= []` 每次渲染产生新引用，
// 导致下游 useMemo 链不断重算、useEffect 无限触发 setFlowNodes。
const EMPTY_NODES: KgNode[] = [];
const EMPTY_EDGES: KgEdge[] = [];
const EMPTY_MEMOS: Memo[] = [];

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

const nodeTypes = { kgNode: KgNodeCard, kgMemoNode: KgMemoNodeCard, kgMoreNode: KgMoreNodeCard };
const edgeTypes = { kgEdge: KgEdgeWithLabel };

function KgCanvasInner({
  graphId,
  selectedNodeId,
  onSelectNode,
  onRequestEditNode,
  onNodeAction,
  connectSourceId = null,
}: Props) {
  const { data: nodes = EMPTY_NODES } = useKgNodes(graphId);
  const { data: edges = EMPTY_EDGES } = useKgEdges();
  const setPos = useSetKgNodePosition();
  const setCollapsed = useSetKgNodeCollapsed();
  const createEdge = useCreateKgEdge();

  // 每个节点的笔记显示数量（分页），key = nodeId
  const [memoDisplayCounts, setMemoDisplayCounts] = useState<Map<number, number>>(new Map());
  // 选中的笔记（用于预览弹窗）
  const [previewMemo, setPreviewMemo] = useState<Memo | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  // 批量查询所有有标签节点的匹配笔记
  const nodesWithTags = useMemo(() => nodes.filter((n) => n.tags.length > 0), [nodes]);
  const memoQueries = useQueries({
    queries: nodesWithTags.map((node) => ({
      queryKey: kgKeys.nodeMemos(node.id),
      queryFn: () => invoke<Memo[]>("kg_list_node_memos", { nodeId: node.id }),
    })),
  });

  // 节点 id → 匹配笔记列表
  const nodeMemosMap = useMemo(() => {
    const map = new Map<number, Memo[]>();
    nodesWithTags.forEach((node, i) => {
      const data = memoQueries[i].data;
      map.set(node.id, data ?? EMPTY_MEMOS);
    });
    return map;
    // memoQueries 的 data 变化时重算；用长度+状态作为依赖避免引用抖动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesWithTags, memoQueries.map((q) => q.data).join()]);

  // 计算每个节点是否有子节点（知识子节点或笔记子节点，用于折叠按钮显示）
  const hasChildrenMap = useMemo(() => {
    const map = new Map<number, boolean>();
    nodes.forEach((n) => {
      if (n.parent_id != null) {
        map.set(n.parent_id, true);
      }
    });
    // 有匹配笔记的节点也算有子节点
    nodeMemosMap.forEach((memos, nodeId) => {
      if (memos.length > 0) {
        map.set(nodeId, true);
      }
    });
    return map;
  }, [nodes, nodeMemosMap]);

  // 过滤掉折叠节点的后代（仅知识节点）
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

  // 构建布局用的节点列表（知识节点 + 笔记虚拟节点 + 更多虚拟节点）
  const layoutNodes = useMemo(() => {
    const result: Array<{
      id: string;
      parent_id: string | null;
      pos_x: number | null;
      pos_y: number | null;
      kind?: "memo" | "more";
      [key: string]: unknown;
    }> = [];

    // 知识节点：保留完整原始数据（KgNode 的所有字段），供 KgNodeCard 使用
    visibleNodes.forEach((n) => {
      result.push({
        ...n,
        id: String(n.id),
        parent_id: n.parent_id != null ? String(n.parent_id) : null,
        pos_x: n.pos_x,
        pos_y: n.pos_y,
      });
    });

    // 笔记虚拟节点 + 更多虚拟节点
    const collapsedSet = new Set(visibleNodes.filter((n) => n.collapsed).map((n) => n.id));
    visibleNodes.forEach((n) => {
      if (collapsedSet.has(n.id)) return; // 折叠的节点不显示笔记子节点
      const memos = nodeMemosMap.get(n.id);
      if (!memos || memos.length === 0) return;

      const displayCount = memoDisplayCounts.get(n.id) ?? MEMO_DISPLAY_COUNT;
      const visibleMemos = memos.slice(0, displayCount);

      visibleMemos.forEach((memo) => {
        if (!memo?.name) return;
        result.push({
          id: `memo:${memo.name}`,
          parent_id: String(n.id),
          pos_x: null,
          pos_y: null,
          kind: "memo" as const,
        });
      });

      // 如果还有更多笔记，添加"+更多"节点
      if (memos.length > displayCount) {
        result.push({
          id: `more:${n.id}`,
          parent_id: String(n.id),
          pos_x: null,
          pos_y: null,
          kind: "more" as const,
        });
      }
    });

    return result;
  }, [visibleNodes, nodeMemosMap, memoDisplayCounts]);

  // 布局
  const positions = useMemo(() => {
    return layoutGraph(layoutNodes, edges.map((e) => ({ source_id: String(e.source_id), target_id: String(e.target_id) })));
  }, [layoutNodes, edges]);

  // 用 useNodesState 让 React Flow 实时管理拖拽位置
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>([]);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // 缓存上次同步时的后端 position key
  const prevBackendPosKeysRef = useRef<Map<string, string>>(new Map());

  // 后端数据变化时智能同步到 flowNodes
  useEffect(() => {
    const computed = toFlowNodes(layoutNodes, positions);
    const newBackendPosKeys = new Map<string, string>();
    visibleNodes.forEach((vn) => {
      newBackendPosKeys.set(
        String(vn.id),
        `${vn.pos_x ?? "null"}:${vn.pos_y ?? "null"}`,
      );
    });

    setFlowNodes((prev) => {
      const prevMap = new Map(prev.map((n) => [n.id, n]));
      const next = computed.map((n) => {
        // 知识节点
        if (!n.id.startsWith("memo:") && !n.id.startsWith("more:")) {
          const data = n.data as KgNodeData;
          const numericId = Number(data.id);
          const existing = prevMap.get(n.id);
          const backendPosKey = newBackendPosKeys.get(n.id);
          const prevBackendPosKey = prevBackendPosKeysRef.current.get(n.id);
          const backendPosChanged = backendPosKey !== prevBackendPosKey;
          const position = !existing || backendPosChanged ? n.position : existing.position;
          return {
            ...n,
            data: {
              ...data,
              id: numericId,
              hasChildren: hasChildrenMap.get(numericId) ?? false,
              connectMode: connectSourceId === numericId,
            },
            position,
            selected: selectedNodeId === numericId,
          };
        }
        // 笔记虚拟节点
        if (n.id.startsWith("memo:")) {
          const memoUid = n.id.slice(5);
          const memo = findMemo(nodeMemosMap, memoUid);
          const memoData: KgMemoNodeData = {
            memoUid,
            content: memo?.content ?? "",
            parentId: (n.data as { parent_id: string }).parent_id,
          };
          return {
            ...n,
            data: memoData as unknown as Record<string, unknown>,
            selected: false,
          };
        }
        // 更多虚拟节点
        const parentId = n.id.slice(5);
        const parentNodeId = Number(parentId);
        const memos = nodeMemosMap.get(parentNodeId) ?? [];
        const displayCount = memoDisplayCounts.get(parentNodeId) ?? MEMO_DISPLAY_COUNT;
        const moreData: KgMoreNodeData = {
          parentId,
          remaining: memos.length - displayCount,
        };
        return {
          ...n,
          data: moreData as unknown as Record<string, unknown>,
          selected: false,
        };
      });
      return next;
    });

    prevBackendPosKeysRef.current = newBackendPosKeys;
  }, [layoutNodes, positions, hasChildrenMap, selectedNodeId, connectSourceId, setFlowNodes, nodeMemosMap, memoDisplayCounts]);

  // 同步 edges（仅知识节点之间的边）
  useEffect(() => {
    const visibleIds = new Set(visibleNodes.map((n) => String(n.id)));
    setFlowEdges(
      toFlowEdges(
        edges
          .filter((e) => visibleIds.has(String(e.source_id)) && visibleIds.has(String(e.target_id)))
          .map((e) => ({ ...e, id: String(e.id), source_id: String(e.source_id), target_id: String(e.target_id) })),
      ),
    );
  }, [edges, visibleNodes, setFlowEdges]);

  // 拖拽后保存位置（防抖）
  const [pendingPositions, setPendingPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  useDebouncedEffect(
    () => {
      if (pendingPositions.size === 0) return;
      for (const [id, pos] of pendingPositions) {
        // 仅知识节点保存位置
        if (id.startsWith("memo:") || id.startsWith("more:")) continue;
        setPos.mutate(
          { id: Number(id), x: pos.x, y: pos.y },
          {
            onSuccess: () => {
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
    // 笔记虚拟节点不保存位置
    if (node.id.startsWith("memo:") || node.id.startsWith("more:")) return;
    setPendingPositions((prev) => {
      const next = new Map(prev);
      next.set(node.id, node.position);
      return next;
    });
  }, []);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_evt, node) => {
      // 笔记节点点击 → 弹窗预览
      if (node.id.startsWith("memo:")) {
        const memoUid = node.id.slice(5);
        const memo = findMemo(nodeMemosMap, memoUid);
        if (memo) {
          setPreviewMemo(memo);
          setPreviewOpen(true);
        }
        return;
      }
      // 更多节点点击 → 加载更多
      if (node.id.startsWith("more:")) {
        const parentId = Number(node.id.slice(5));
        setMemoDisplayCounts((prev) => {
          const next = new Map(prev);
          const current = next.get(parentId) ?? MEMO_DISPLAY_COUNT;
          next.set(parentId, current + MEMO_DISPLAY_COUNT);
          return next;
        });
        return;
      }
      // 知识节点
      const id = Number(node.id);
      if (connectSourceId != null && connectSourceId !== id) {
        onNodeAction?.("connect", id);
        return;
      }
      onSelectNode(id);
    },
    [onSelectNode, connectSourceId, onNodeAction, nodeMemosMap],
  );

  const onPaneClick = useCallback(() => {
    if (connectSourceId != null) {
      onNodeAction?.("connect", -1);
      return;
    }
    onSelectNode(null);
  }, [onSelectNode, connectSourceId, onNodeAction]);

  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (_evt, node) => {
      // 笔记节点和更多节点不触发编辑
      if (node.id.startsWith("memo:") || node.id.startsWith("more:")) return;
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

  // 监听节点快捷操作事件
  useEffect(() => {
    const actionHandler = (e: Event) => {
      const detail = (e as CustomEvent<{ action: KgNodeAction; id: number }>).detail;
      if (detail.action === "edit") {
        onRequestEditNode(detail.id);
      } else if (detail.action === "toggle-collapse") {
        const node = nodes.find((n) => n.id === detail.id);
        if (node) {
          setCollapsed.mutate({ id: detail.id, collapsed: !node.collapsed });
        }
      } else {
        onNodeAction?.(detail.action, detail.id);
      }
    };
    window.addEventListener("kg-node-action", actionHandler as EventListener);
    return () => window.removeEventListener("kg-node-action", actionHandler as EventListener);
  }, [onRequestEditNode, onNodeAction, nodes, setCollapsed]);

  return (
    <>
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
      <KgMemoPreviewDialog memo={previewMemo} open={previewOpen} onOpenChange={setPreviewOpen} />
    </>
  );
}

/** 从 nodeMemosMap 中查找指定 uid 的笔记 */
function findMemo(nodeMemosMap: Map<number, Memo[]>, memoUid: string): Memo | undefined {
  for (const memos of nodeMemosMap.values()) {
    const found = memos.find((m) => m?.name?.split("/").pop() === memoUid);
    if (found) return found;
  }
  return undefined;
}

export default function KgCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <KgCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
