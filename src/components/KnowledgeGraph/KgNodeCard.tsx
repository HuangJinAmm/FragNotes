import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ChevronDownIcon, ChevronRightIcon, HashIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { NODE_COLOR_PALETTE } from "./constants";

export interface KgNodeData {
  id: number;
  name: string;
  description: string;
  color: string;
  icon: string;
  parent_id: number | null;
  collapsed: boolean;
  tags: string[];
  hasChildren?: boolean;
  [key: string]: unknown;
}

// 用完整类名字符串避免 Tailwind purge
const colorClassMap: Record<string, string> = {
  "": "border-border bg-card",
  blue: "border-blue-500/50 bg-blue-500/5",
  green: "border-green-500/50 bg-green-500/5",
  amber: "border-amber-500/50 bg-amber-500/5",
  red: "border-red-500/50 bg-red-500/5",
  purple: "border-purple-500/50 bg-purple-500/5",
  cyan: "border-cyan-500/50 bg-cyan-500/5",
  pink: "border-pink-500/50 bg-pink-500/5",
};

// 确保所有 palette 颜色都映射（防止漏掉）
NODE_COLOR_PALETTE.forEach((c) => {
  if (!(c.key in colorClassMap) && c.key !== "") {
    colorClassMap[c.key] = "border-border bg-card";
  }
});

export default function KgNodeCard({ data, selected }: NodeProps) {
  const nodeData = data as KgNodeData;
  const colorClass = colorClassMap[nodeData.color] ?? colorClassMap[""];

  return (
    <div
      className={cn(
        "relative w-[180px] rounded-lg border-2 px-3 py-2 shadow-sm transition-colors",
        colorClass,
        selected ? "ring-2 ring-primary" : "",
      )}
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-muted-foreground/50" />

      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{nodeData.name}</span>
          </div>
          {nodeData.description && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{nodeData.description}</p>
          )}
        </div>
      </div>

      {nodeData.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-0.5">
          {nodeData.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="inline-flex items-center gap-0.5 rounded bg-muted/60 px-1 text-[10px] text-muted-foreground">
              <HashIcon className="h-2 w-2" />
              {tag}
            </span>
          ))}
          {nodeData.tags.length > 3 && (
            <span className="text-[10px] text-muted-foreground">+{nodeData.tags.length - 3}</span>
          )}
        </div>
      )}

      {nodeData.hasChildren && (
        <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background border border-border px-1 text-xs">
          {nodeData.collapsed ? <ChevronRightIcon className="h-3 w-3" /> : <ChevronDownIcon className="h-3 w-3" />}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-muted-foreground/50" />
    </div>
  );
}
