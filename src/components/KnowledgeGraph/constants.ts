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

// 常用 lucide 图标预设：value = lucide 图标组件名（与 lucide-react 导出一致）
// 用于节点编辑对话框的图标选择器；用户也可在输入框手动输入其他 lucide 图标名
export const NODE_ICON_PRESETS = [
  { value: "", label: "无" },
  { value: "StarIcon", label: "星标" },
  { value: "BookOpenIcon", label: "书本" },
  { value: "LightbulbIcon", label: "灯泡" },
  { value: "CodeIcon", label: "代码" },
  { value: "BrainIcon", label: "大脑" },
  { value: "DatabaseIcon", label: "数据库" },
  { value: "CpuIcon", label: "CPU" },
  { value: "CloudIcon", label: "云" },
  { value: "RocketIcon", label: "火箭" },
  { value: "FlaskConicalIcon", label: "烧瓶" },
  { value: "LayersIcon", label: "层级" },
  { value: "GitBranchIcon", label: "分支" },
  { value: "WorkflowIcon", label: "流程" },
  { value: "ServerIcon", label: "服务器" },
  { value: "GlobeIcon", label: "地球" },
  { value: "TargetIcon", label: "目标" },
  { value: "HeartIcon", label: "心形" },
  { value: "ZapIcon", label: "闪电" },
  { value: "TagIcon", label: "标签" },
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

// 笔记子节点尺寸（更小）
export const MEMO_NODE_WIDTH = 160;
export const MEMO_NODE_HEIGHT = 48;

// 每个知识节点默认显示的笔记子节点数量
export const MEMO_DISPLAY_COUNT = 5;
