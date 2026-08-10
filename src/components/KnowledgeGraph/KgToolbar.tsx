import { PlusIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useKgNodes, useSetKgNodePosition } from "@/hooks/useKgQueries";
import { useTranslate } from "@/utils/i18n";

interface Props {
  onCreateNode: () => void;
}

export default function KgToolbar({ onCreateNode }: Props) {
  // useTranslate 返回的 t 是基于 en.json 的严格类型化函数；kg.* 键在 Task 12 才添加，
  // 这里放宽为接受任意 string，运行时未命中会显示 key 本身，Task 12 添加后正常显示。
  const t = useTranslate() as (key: string, params?: Record<string, unknown>) => string;
  const { data: nodes = [] } = useKgNodes();
  const setPos = useSetKgNodePosition();

  const handleResetLayout = () => {
    // 清空所有节点的 pos_x/pos_y，触发重新自动布局
    nodes.forEach((n) => {
      if (n.pos_x != null || n.pos_y != null) {
        setPos.mutate({ id: n.id, x: null, y: null });
      }
    });
  };

  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      <Button size="sm" onClick={onCreateNode}>
        <PlusIcon className="mr-1 h-4 w-4" />
        {t("kg.new-node")}
      </Button>
      <Button size="sm" variant="ghost" onClick={handleResetLayout}>
        <RotateCcwIcon className="mr-1 h-4 w-4" />
        {t("kg.reset-layout")}
      </Button>
    </div>
  );
}
