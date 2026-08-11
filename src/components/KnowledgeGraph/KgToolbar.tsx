import { PlusIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useKgNodes, useSetKgNodePosition } from "@/hooks/useKgQueries";
import { useTranslate } from "@/utils/i18n";
import KgGraphSwitcher from "./KgGraphSwitcher";

interface Props {
  graphId: number | null;
  onCreateNode: () => void;
  onSelectGraph: (id: number) => void;
}

export default function KgToolbar({ graphId, onCreateNode, onSelectGraph }: Props) {
  const t = useTranslate() as (key: string, params?: Record<string, unknown>) => string;
  const { data: nodes = [] } = useKgNodes(graphId ?? undefined);
  const setPos = useSetKgNodePosition();

  const handleResetLayout = () => {
    nodes.forEach((n) => {
      if (n.pos_x != null || n.pos_y != null) {
        setPos.mutate({ id: n.id, x: null, y: null });
      }
    });
  };

  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      <KgGraphSwitcher currentGraphId={graphId} onSelect={onSelectGraph} />
      <Button size="sm" onClick={onCreateNode} disabled={graphId == null}>
        <PlusIcon className="mr-1 h-4 w-4" />
        {t("kg.new-node")}
      </Button>
      <Button size="sm" variant="ghost" onClick={handleResetLayout} disabled={graphId == null}>
        <RotateCcwIcon className="mr-1 h-4 w-4" />
        {t("kg.reset-layout")}
      </Button>
    </div>
  );
}
