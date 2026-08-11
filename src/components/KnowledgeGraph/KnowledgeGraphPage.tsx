import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import {
  useCreateKgEdge,
  useCreateKgNode,
  useDeleteKgNode,
  useKgNodes,
  useSetKgNodeTags,
} from "@/hooks/useKgQueries";
import { generateUUID } from "@/utils/uuid";
import type { KgNodeAction } from "./KgNodeCard";
import KgCanvas from "./KgCanvas";
import KgNodeDetailPanel from "./KgNodeDetailPanel";
import KgNodeEditDialog from "./KgNodeEditDialog";
import KgToolbar from "./KgToolbar";

export default function KnowledgeGraphPage() {
  const [searchParams] = useSearchParams();
  const initialSelect = searchParams.get("select");
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(
    initialSelect ? Number(initialSelect) : null,
  );
  const [editNodeId, setEditNodeId] = useState<number | null>(null);
  const [createParentId, setCreateParentId] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // "连接到"模式：源节点 id；null 表示非连接模式
  const [connectSourceId, setConnectSourceId] = useState<number | null>(null);

  const { data: nodes = [] } = useKgNodes();
  const createNode = useCreateKgNode();
  const createEdge = useCreateKgEdge();
  const deleteNode = useDeleteKgNode();
  const setTags = useSetKgNodeTags();

  const handleCreateNode = () => {
    setEditNodeId(null);
    setCreateParentId(null);
    setDialogOpen(true);
  };

  const handleEditNode = (id: number) => {
    setEditNodeId(id);
    setCreateParentId(null);
    setDialogOpen(true);
  };

  const handleAddChild = (parentId: number) => {
    setEditNodeId(null);
    setCreateParentId(parentId);
    setDialogOpen(true);
  };

  const handleDuplicate = useCallback(
    (id: number) => {
      const src = nodes.find((n) => n.id === id);
      if (!src) return;
      createNode.mutate(
        {
          uid: generateUUID(),
          graph_id: src.graph_id,
          name: `${src.name} (副本)`,
          description: src.description,
          color: src.color,
          icon: src.icon,
          parent_id: src.parent_id,
          pos_x: null,
          pos_y: null,
          collapsed: false,
        },
        {
          onSuccess: (newNode) => {
            if (src.tags.length > 0) {
              setTags.mutate({ id: newNode.id, tags: [...src.tags] });
            }
            toast.success(`已复制节点: ${src.name}`);
          },
          onError: () => toast.error("复制节点失败"),
        },
      );
    },
    [nodes, createNode, setTags],
  );

  const handleDelete = useCallback(
    (id: number) => {
      const node = nodes.find((n) => n.id === id);
      if (!node) return;
      // 二次确认
      const ok = window.confirm(`确定删除节点「${node.name}」吗？相关连线也会被移除。`);
      if (!ok) return;
      deleteNode.mutate(id, {
        onSuccess: () => {
          if (selectedNodeId === id) setSelectedNodeId(null);
          if (connectSourceId === id) setConnectSourceId(null);
          toast.success(`已删除节点: ${node.name}`);
        },
        onError: () => toast.error("删除节点失败"),
      });
    },
    [nodes, deleteNode, selectedNodeId, connectSourceId],
  );

  /**
   * 连接模式状态机：
   * - 当前非连接模式 + 任意 id → 进入连接模式（设源）
   * - 当前连接模式 + 同 id 或 -1 → 取消连接模式
   * - 当前连接模式 + 不同 id → 创建边并退出连接模式
   */
  const handleConnect = useCallback(
    (id: number) => {
      if (connectSourceId == null) {
        if (id === -1) return;
        setConnectSourceId(id);
        toast("已进入连接模式，点击目标节点完成连接", { icon: "🔗" });
        return;
      }
      if (id === -1 || id === connectSourceId) {
        setConnectSourceId(null);
        toast("已取消连接模式");
        return;
      }
      createEdge.mutate(
        {
          source_id: connectSourceId,
          target_id: id,
          edge_type: "related",
          label: "",
        },
        {
          onSuccess: () => {
            toast.success("已创建连接");
          },
          onError: () => toast.error("创建连接失败"),
        },
      );
      setConnectSourceId(null);
    },
    [connectSourceId, createEdge],
  );

  const handleNodeAction = useCallback(
    (action: KgNodeAction, nodeId: number) => {
      switch (action) {
        case "add-child":
          handleAddChild(nodeId);
          break;
        case "connect":
          handleConnect(nodeId);
          break;
        case "duplicate":
          handleDuplicate(nodeId);
          break;
        case "delete":
          handleDelete(nodeId);
          break;
        default:
          // edit / toggle-collapse 在 KgCanvas 内部处理
          break;
      }
    },
    [handleConnect, handleDuplicate, handleDelete],
  );

  // Esc 取消连接模式
  useEffect(() => {
    if (connectSourceId == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConnectSourceId(null);
        toast("已取消连接模式");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [connectSourceId]);

  // 连接模式提示横幅
  const connectBanner = connectSourceId != null
    ? (() => {
        const src = nodes.find((n) => n.id === connectSourceId);
        return src ? `连接模式：从「${src.name}」→ 点击目标节点（Esc 或点空白取消）` : null;
      })()
    : null;

  return (
    <div className="flex h-svh w-full flex-col">
      <KgToolbar onCreateNode={handleCreateNode} />
      {connectBanner && (
        <div className="border-b border-primary/30 bg-primary/10 px-3 py-1.5 text-xs text-primary">
          {connectBanner}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <KgCanvas
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onRequestEditNode={handleEditNode}
            onNodeAction={handleNodeAction}
            connectSourceId={connectSourceId}
          />
        </div>
        <div className="w-[300px] shrink-0 border-l border-border bg-background">
          <KgNodeDetailPanel nodeId={selectedNodeId} onEditNode={handleEditNode} />
        </div>
      </div>
      <KgNodeEditDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editNodeId={editNodeId}
        defaultParentId={createParentId}
      />
    </div>
  );
}
