import { useEffect, useState } from "react";
import { generateUUID } from "@/utils/uuid";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCreateKgNode, useKgNodes, useSetKgNodeTags, useUpdateKgNode } from "@/hooks/useKgQueries";
import type { KgNode, UpsertKgNodeRequest } from "@/types/kg";
import { NODE_COLOR_PALETTE, NODE_ICON_PRESETS } from "./constants";
import KgTagEditor from "./KgTagEditor";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 传入节点 id 表示编辑；null/undefined 表示新建 */
  editNodeId?: number | null;
  defaultParentId?: number | null;
  graphId: number;
}

export default function KgNodeEditDialog({ open, onOpenChange, editNodeId, defaultParentId, graphId }: Props) {
  const { data: nodes = [] } = useKgNodes();
  const createNode = useCreateKgNode();
  const updateNode = useUpdateKgNode();
  const setTags = useSetKgNodeTags();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("");
  const [icon, setIcon] = useState("");
  const [parentId, setParentId] = useState<number | null>(null);
  const [tags, setTagsState] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    if (editNodeId != null) {
      const node = nodes.find((n) => n.id === editNodeId);
      if (node) {
        setName(node.name);
        setDescription(node.description);
        setColor(node.color);
        setIcon(node.icon);
        setParentId(node.parent_id);
        setTagsState(node.tags);
      }
    } else {
      setName("");
      setDescription("");
      setColor("");
      setIcon("");
      setParentId(defaultParentId ?? null);
      setTagsState([]);
    }
  }, [open, editNodeId, nodes, defaultParentId]);

  const handleSave = () => {
    if (!name.trim()) return;
    const editingNode = editNodeId != null ? nodes.find((n) => n.id === editNodeId) : undefined;
    const req: UpsertKgNodeRequest = {
      uid: editingNode?.uid ?? generateUUID(),
      graph_id: editingNode?.graph_id ?? graphId,
      name: name.trim(),
      description,
      color,
      icon,
      parent_id: parentId,
      pos_x: editingNode?.pos_x ?? null,
      pos_y: editingNode?.pos_y ?? null,
      collapsed: editingNode?.collapsed ?? false,
    };
    if (editNodeId != null) {
      updateNode.mutate(
        { id: editNodeId, req },
        {
          onSuccess: () => {
            setTags.mutate({ id: editNodeId, tags });
            onOpenChange(false);
          },
        },
      );
    } else {
      createNode.mutate(req, {
        onSuccess: (node: KgNode) => {
          setTags.mutate({ id: node.id, tags });
          onOpenChange(false);
        },
      });
    }
  };

  // 可选父节点：排除自身
  const candidateParents = nodes.filter((n) => n.id !== editNodeId && n.graph_id === graphId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editNodeId != null ? "编辑节点" : "新建节点"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="kg-node-name">名称 *</Label>
            <Input id="kg-node-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="节点名称" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="kg-node-desc">描述</Label>
            <Textarea id="kg-node-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="space-y-1">
            <Label>颜色</Label>
            <div className="flex flex-wrap gap-1.5">
              {NODE_COLOR_PALETTE.map((c) => (
                <button
                  key={c.key || "default"}
                  type="button"
                  onClick={() => setColor(c.key)}
                  className={`h-6 w-6 rounded-full ${c.dot} ${color === c.key ? "ring-2 ring-primary ring-offset-2" : ""}`}
                  title={c.label}
                />
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="kg-node-icon">图标（lucide 图标名，可空）</Label>
            <div className="flex gap-1.5">
              <Input
                id="kg-node-icon"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="如 StarIcon"
                className="flex-1"
              />
              <select
                aria-label="选择图标"
                value={NODE_ICON_PRESETS.some((p) => p.value === icon) ? icon : "__custom__"}
                onChange={(e) => {
                  if (e.target.value !== "__custom__") setIcon(e.target.value);
                }}
                className="w-28 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
              >
                <option value="__custom__">{icon && !NODE_ICON_PRESETS.some((p) => p.value === icon) ? icon : "选择…"}</option>
                {NODE_ICON_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="kg-node-parent">父节点</Label>
            <select
              id="kg-node-parent"
              value={parentId ?? ""}
              onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}
              className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            >
              <option value="">（无）</option>
              {candidateParents.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>标签</Label>
            <KgTagEditor tags={tags} onChange={setTagsState} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || createNode.isPending || updateNode.isPending}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
