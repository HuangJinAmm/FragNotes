import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useKgNodes } from "@/hooks/useKgQueries";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (nodeId: number) => void;
  /** 排除已关联的节点 id */
  excludeNodeIds?: number[];
}

export default function KgNodePicker({ open, onOpenChange, onPick, excludeNodeIds = [] }: Props) {
  const { data: nodes = [] } = useKgNodes();
  const [search, setSearch] = useState("");

  const filtered = nodes
    .filter((n) => !excludeNodeIds.includes(n.id))
    .filter((n) => n.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[60vh] max-w-md">
        <DialogHeader>
          <DialogTitle>选择节点</DialogTitle>
        </DialogHeader>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索节点..." />
        <div className="max-h-[40vh] overflow-auto">
          {filtered.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">无匹配节点</p>
          ) : (
            filtered.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => {
                  onPick(n.id);
                  onOpenChange(false);
                }}
                className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                {n.name}
                {n.tags.length > 0 && (
                  <span className="ml-2 text-xs text-muted-foreground">#{n.tags.join(" #")}</span>
                )}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
