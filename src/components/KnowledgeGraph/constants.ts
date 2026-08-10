// 颜色调色板：key → tailwind 类名前缀
export const NODE_COLOR_PALETTE = [
  { key: "", label: "默认", dot: "bg-muted-foreground" },
  { key: "blue", label: "蓝", dot: "bg-blue-500" },
  { key: "green", label: "绿", dot: "bg-green-500" },
  { key: "amber", label: "琥珀", dot: "bg-amber-500" },
  { key: "red", label: "红", dot: "bg-red-500" },
  { key: "purple", label: "紫", dot: "bg-purple-500" },
  { key: "cyan", label: "青", dot: "bg-cyan-500" },
  { key: "pink", label: "粉", dot: "bg-pink-500" },
] as const;

// 边类型预设
export const EDGE_TYPES = [
  { value: "related", label: "相关" },
  { value: "contains", label: "包含" },
  { value: "derived", label: "派生" },
] as const;

// 边类型 → 样式
export const EDGE_TYPE_STYLES: Record<string, { stroke: string; dashed: boolean }> = {
  related: { stroke: "#94a3b8", dashed: false },
  contains: { stroke: "#3b82f6", dashed: false },
  derived: { stroke: "#a855f7", dashed: true },
};

export const DEFAULT_NODE_WIDTH = 180;
export const DEFAULT_NODE_HEIGHT = 80;
