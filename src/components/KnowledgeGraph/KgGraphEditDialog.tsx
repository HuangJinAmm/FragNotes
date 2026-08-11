import { useEffect, useState } from "react";
import { generateUUID } from "@/utils/uuid";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCreateKgGraph, useKgGraphs, useUpdateKgGraph } from "@/hooks/useKgQueries";
import type { UpsertKgGraphRequest } from "@/types/kg";
import { NODE_COLOR_PALETTE } from "./constants";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 传入图谱 id 表示编辑；null/undefined 表示新建 */
  editGraphId?: number | null;
}

export default function KgGraphEditDialog({ open, onOpenChange, editGraphId }: Props) {
  const { data: graphs = [] } = useKgGraphs();
  const createGraph = useCreateKgGraph();
  const updateGraph = useUpdateKgGraph();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("");

  useEffect(() => {
    if (!open) return;
    if (editGraphId != null) {
      const graph = graphs.find((g) => g.id === editGraphId);
      if (graph) {
        setName(graph.name);
        setDescription(graph.description);
        setColor(graph.color);
      }
    } else {
      setName("");
      setDescription("");
      setColor("");
    }
  }, [open, editGraphId, graphs]);

  const handleSave = () => {
    if (!name.trim()) return;
    const editingGraph = editGraphId != null ? graphs.find((g) => g.id === editGraphId) : undefined;
    const req: UpsertKgGraphRequest = {
      uid: editingGraph?.uid ?? generateUUID(),
      name: name.trim(),
      description,
      color,
    };
    if (editGraphId != null) {
      updateGraph.mutate(
        { id: editGraphId, req },
        { onSuccess: () => onOpenChange(false) },
      );
    } else {
      createGraph.mutate(req, {
        onSuccess: () => onOpenChange(false),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editGraphId != null ? "编辑图谱" : "新建图谱"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="kg-graph-name">名称 *</Label>
            <Input id="kg-graph-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="图谱名称" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="kg-graph-desc">描述</Label>
            <Textarea id="kg-graph-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
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
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || createGraph.isPending || updateGraph.isPending}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
