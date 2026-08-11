import { ChevronDownIcon, PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useDeleteKgGraph, useKgGraphs } from "@/hooks/useKgQueries";
import KgGraphEditDialog from "./KgGraphEditDialog";

interface Props {
  currentGraphId: number | null;
  onSelect: (id: number) => void;
}

export default function KgGraphSwitcher({ currentGraphId, onSelect }: Props) {
  const { data: graphs = [] } = useKgGraphs();
  const deleteGraph = useDeleteKgGraph();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editGraphId, setEditGraphId] = useState<number | null>(null);

  const currentGraph = graphs.find((g) => g.id === currentGraphId);

  const handleCreate = () => {
    setEditGraphId(null);
    setEditDialogOpen(true);
    setDropdownOpen(false);
  };

  const handleEdit = (id: number) => {
    setEditGraphId(id);
    setEditDialogOpen(true);
    setDropdownOpen(false);
  };

  const handleDelete = (id: number, name: string) => {
    if (!confirm(`确定删除图谱「${name}」吗？所有节点和关联将被删除。`)) return;
    deleteGraph.mutate(id);
    setDropdownOpen(false);
  };

  return (
    <div className="relative">
      <Button
        size="sm"
        variant="outline"
        onClick={() => setDropdownOpen((v) => !v)}
        className="min-w-[140px] justify-between"
      >
        <span className="truncate">{currentGraph?.name ?? "选择图谱"}</span>
        <ChevronDownIcon className="ml-1 h-4 w-4 shrink-0" />
      </Button>

      {dropdownOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 min-w-[220px] rounded-md border border-border bg-popover shadow-md">
            <div className="max-h-[300px] overflow-auto py-1">
              {graphs.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">暂无图谱</p>
              ) : (
                graphs.map((g) => (
                  <div
                    key={g.id}
                    className={`group flex items-center gap-1 px-2 py-1.5 hover:bg-accent ${g.id === currentGraphId ? "bg-accent/50" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(g.id);
                        setDropdownOpen(false);
                      }}
                      className="min-w-0 flex-1 text-left text-sm"
                    >
                      <span className="truncate">{g.name}</span>
                      {g.description && (
                        <span className="ml-1 text-xs text-muted-foreground">— {g.description}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleEdit(g.id)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                      title="编辑"
                    >
                      <SettingsIcon className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(g.id, g.name)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                      title="删除"
                    >
                      <Trash2Icon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="border-t border-border py-1">
              <button
                type="button"
                onClick={handleCreate}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <PlusIcon className="h-4 w-4" />
                新建图谱
              </button>
            </div>
          </div>
        </>
      )}

      <KgGraphEditDialog open={editDialogOpen} onOpenChange={setEditDialogOpen} editGraphId={editGraphId} />
    </div>
  );
}
