import { Handle, Position, type NodeProps } from "@xyflow/react";
import { FileTextIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface KgMemoNodeData {
  memoUid: string;
  content: string;
  /** 父知识节点 id（字符串） */
  parentId: string;
  /** 聚焦淡出：父节点不在选中节点的关联集合中 */
  dimmed?: boolean;
  [key: string]: unknown;
}

export default function KgMemoNodeCard({ data, selected }: NodeProps) {
  const memoData = data as KgMemoNodeData;
  const preview = memoData.content?.trim() || "（无内容）";

  return (
    <div
      className={cn(
        "kg-memo-node w-[160px] rounded-md border border-dashed border-border bg-muted/30 px-2.5 py-1.5 shadow-sm transition-[background-color,opacity] hover:bg-muted/50",
        selected && "ring-1 ring-primary",
        memoData.dimmed && "opacity-30",
      )}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !bg-muted-foreground/40" />
      <div className="flex items-center gap-1.5">
        <FileTextIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
        <p className="line-clamp-1 text-xs text-muted-foreground">{preview}</p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !bg-muted-foreground/40" />
    </div>
  );
}
