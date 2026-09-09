import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface KgMoreNodeData {
  /** 父知识节点 id（字符串） */
  parentId: string;
  /** 剩余未显示的笔记数量 */
  remaining: number;
  /** 聚焦淡出：父节点不在选中节点的关联集合中 */
  dimmed?: boolean;
  [key: string]: unknown;
}

export default function KgMoreNodeCard({ data }: NodeProps) {
  const moreData = data as KgMoreNodeData;

  return (
    <div
      className={cn(
        "kg-more-node w-[160px] rounded-md border border-dashed border-primary/40 bg-primary/5 px-2.5 py-1.5 text-center shadow-sm transition-[background-color,opacity] hover:bg-primary/10 cursor-pointer",
        moreData.dimmed && "opacity-30",
      )}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !bg-muted-foreground/40" />
      <div className="flex items-center justify-center gap-1 text-xs text-primary">
        <ChevronDownIcon className="h-3 w-3" />
        <span>+{moreData.remaining} 更多笔记</span>
      </div>
    </div>
  );
}
