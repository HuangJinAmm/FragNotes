import { HashIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDeleteKgNode, useKgNodes } from "@/hooks/useKgQueries";
import { useTranslate } from "@/utils/i18n";
import KgMemoListPanel from "./KgMemoListPanel";

interface Props {
  nodeId: number | null;
  onEditNode: (id: number) => void;
}

export default function KgNodeDetailPanel({ nodeId, onEditNode }: Props) {
  const t = useTranslate() as (key: string, params?: Record<string, unknown>) => string;
  const { data: nodes = [] } = useKgNodes();
  const deleteNode = useDeleteKgNode();

  const node = nodeId != null ? nodes.find((n) => n.id === nodeId) : undefined;

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {t("kg.select-node-prompt")}
      </div>
    );
  }

  const handleDelete = () => {
    if (!confirm(t("kg.delete-confirm", { name: node.name }))) return;
    deleteNode.mutate(node.id);
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-foreground">{node.name}</h3>
          {node.description && <p className="mt-1 text-sm text-muted-foreground">{node.description}</p>}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="icon" variant="ghost" onClick={() => onEditNode(node.id)} title={t("common.edit")}>
            <PencilIcon className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={handleDelete} title={t("common.delete")}>
            <Trash2Icon className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      {node.tags.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t("common.tags")}</p>
          <div className="flex flex-wrap gap-1">
            {node.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              >
                <HashIcon className="h-3 w-3" />
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-border pt-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("kg.related-memos")}</p>
        <KgMemoListPanel nodeId={node.id} />
      </div>
    </div>
  );
}
