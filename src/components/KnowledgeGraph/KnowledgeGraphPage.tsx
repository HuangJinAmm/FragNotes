import { useState } from "react";
import { useSearchParams } from "react-router-dom";
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
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleCreateNode = () => {
    setEditNodeId(null);
    setDialogOpen(true);
  };

  const handleEditNode = (id: number) => {
    setEditNodeId(id);
    setDialogOpen(true);
  };

  return (
    <div className="flex h-full flex-col">
      <KgToolbar onCreateNode={handleCreateNode} />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <KgCanvas
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onRequestEditNode={handleEditNode}
          />
        </div>
        <div className="w-[300px] shrink-0 border-l border-border bg-background">
          <KgNodeDetailPanel nodeId={selectedNodeId} onEditNode={handleEditNode} />
        </div>
      </div>
      <KgNodeEditDialog open={dialogOpen} onOpenChange={setDialogOpen} editNodeId={editNodeId} />
    </div>
  );
}
