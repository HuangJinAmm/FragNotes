import { useEffect, useState, type ComponentType } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  BookOpenCheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  GraduationCapIcon,
  HashIcon,
  PencilIcon,
  PlusIcon,
  Share2Icon,
  CopyIcon,
  Trash2Icon,
  icons as lucideIcons,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { NODE_COLOR_PALETTE } from "./constants";

/** 节点关联牌组的卡片记忆总览（掌握情况） */
export interface KgNodeDeckStat {
  deckId: number;
  deckName: string;
  dueCount: number;
  newCount: number;
  total: number;
  learned: number;
  retentionRate: number;
  lastReviewedTs: number | null;
}
import type { KgNodeReviewStats } from "@/types/kg";

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
  /** 是否处于"连接到"模式（节点作为源，等待选择目标） */
  connectMode?: boolean;
  /** 标签关联牌组的卡片记忆总览（标签与牌组标签有交集时） */
  deckStats?: KgNodeDeckStat[];
  /** 节点记忆状态（关联笔记的复习卡片聚合），无数据时为 undefined */
  reviewStats?: KgNodeReviewStats;
  [key: string]: unknown;
}

export type KgNodeAction =
  | "edit"
  | "add-child"
  | "connect"
  | "toggle-collapse"
  | "duplicate"
  | "delete"
  | "view-memos"
  | "review-topic";

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

interface QuickAction {
  action: KgNodeAction;
  icon: typeof PencilIcon;
  label: string;
  danger?: boolean;
  /** 仅在特定条件下显示 */
  visible?: boolean;
}

export default function KgNodeCard({ data, selected, dragging }: NodeProps) {
  const nodeData = data as KgNodeData;
  const colorClass = colorClassMap[nodeData.color] ?? colorClassMap[""];
  const [showSuccess, setShowSuccess] = useState(false);

  // 监听位置保存成功事件（id 匹配本节点时闪烁绿点）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id: number }>).detail;
      if (detail.id === nodeData.id) {
        setShowSuccess(true);
        window.setTimeout(() => setShowSuccess(false), 1200);
      }
    };
    window.addEventListener("kg-position-saved", handler as EventListener);
    return () => window.removeEventListener("kg-position-saved", handler as EventListener);
  }, [nodeData.id]);

  const dispatchAction = (action: KgNodeAction) => {
    window.dispatchEvent(
      new CustomEvent("kg-node-action", {
        detail: { action, id: nodeData.id },
      }),
    );
  };

  const quickActions: QuickAction[] = [
    { action: "edit", icon: PencilIcon, label: "编辑" },
    { action: "add-child", icon: PlusIcon, label: "添加子节点" },
    { action: "connect", icon: Share2Icon, label: "连接到" },
    { action: "duplicate", icon: CopyIcon, label: "复制" },
    {
      action: "review-topic",
      icon: GraduationCapIcon,
      label: "复习此主题",
      visible: nodeData.tags.length > 0,
    },
    {
      action: "view-memos",
      icon: ExternalLinkIcon,
      label: "查看标签笔记",
      visible: nodeData.tags.length > 0,
    },
    {
      action: "toggle-collapse",
      icon: nodeData.collapsed ? ChevronRightIcon : ChevronDownIcon,
      label: nodeData.collapsed ? "展开" : "折叠",
      visible: nodeData.hasChildren,
    },
    { action: "delete", icon: Trash2Icon, label: "删除", danger: true },
  ];

  return (
    <div
      className={cn(
        "group/kg relative w-[180px] rounded-lg border-2 px-3 py-2 shadow-sm kg-node-enter",
        // 拖拽时禁用过渡以提升流畅度，启用 GPU 合成层；非拖拽时保留过渡 + hover 轻反馈
        dragging
          ? "transition-none will-change-transform cursor-grabbing shadow-2xl"
          : "transition-[box-shadow,transform] duration-150 ease-out hover:shadow-md",
        colorClass,
        selected ? "ring-2 ring-primary scale-[1.03]" : "",
        nodeData.connectMode ? "kg-connect-mode ring-2 ring-primary" : "",
      )}
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-muted-foreground/50" />

      {/* 位置保存成功闪烁绿点 */}
      {showSuccess && (
        <span className="kg-success-pulse absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-green-500 ring-2 ring-background" />
      )}

      {/* 选中时显示快捷工具条 */}
      {selected && !dragging && (
        <div className="absolute -top-9 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-md">
          {quickActions
            .filter((a) => a.visible !== false)
            .map((a) => {
              const Icon = a.icon;
              return (
                <button
                  key={a.action}
                  type="button"
                  title={a.label}
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded transition-colors",
                    a.danger
                      ? "text-muted-foreground hover:bg-red-500/15 hover:text-red-600"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    dispatchAction(a.action);
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              );
            })}
        </div>
      )}

      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {(() => {
              // 动态渲染 lucide 图标：nodeData.icon 为图标组件名（如 "StarIcon"）
              // lucide-react 的 icons 导出 key 不带 "Icon" 后缀（如 "Star"），需去掉后缀匹配
              const iconKey = nodeData.icon ? nodeData.icon.replace(/Icon$/, "") : "";
              const IconComp = iconKey ? (lucideIcons as Record<string, ComponentType<{ className?: string }>>)[iconKey] : null;
              if (IconComp) {
                return <IconComp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
              }
              return null;
            })()}
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
            <span
              key={tag}
              className="inline-flex items-center gap-0.5 rounded bg-muted/60 px-1 text-[10px] text-muted-foreground"
            >
              <HashIcon className="h-2 w-2" />
              {tag}
            </span>
          ))}
          {nodeData.tags.length > 3 && (
            <span className="text-[10px] text-muted-foreground">+{nodeData.tags.length - 3}</span>
          )}
        </div>
      )}

      {/* 关联牌组的卡片记忆总览（掌握情况） */}
      {nodeData.deckStats && nodeData.deckStats.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {nodeData.deckStats.map((ds) => {
            const progress = ds.total > 0 ? Math.round((ds.learned / ds.total) * 100) : 0;
            const mastery =
              ds.lastReviewedTs == null ? "—" : `${Math.round(ds.retentionRate * 100)}%`;
            return (
              <div
                key={ds.deckId}
                className="rounded bg-muted/50 px-1.5 py-1"
                title={`牌组「${ds.deckName}」记忆总览：已学 ${ds.learned}/${ds.total}，今日到期 ${ds.dueCount}，新卡 ${ds.newCount}，掌握率 ${mastery}`}
              >
                <div className="flex items-center justify-between gap-1 text-[10px] leading-tight">
                  <span className="flex min-w-0 items-center gap-0.5 text-muted-foreground">
                    <BookOpenCheckIcon className="h-2.5 w-2.5 shrink-0" />
                    <span className="truncate">{ds.deckName}</span>
                  </span>
                  <span className="shrink-0 font-medium text-green-600">{mastery}</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-green-500/80 transition-[width] duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[9px] leading-tight text-muted-foreground">
                  <span>
                    已学 {ds.learned}/{ds.total}
                  </span>
                  {ds.dueCount > 0 && <span className="text-orange-600">到期 {ds.dueCount}</span>}
                  {ds.newCount > 0 && <span className="text-blue-600">新 {ds.newCount}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 记忆状态徽章：复习卡片聚合（有卡片才显示） */}
      {nodeData.reviewStats && nodeData.reviewStats.total_cards > 0 && (
        <div className="mt-1.5">
          {nodeData.reviewStats.due_count > 0 ? (
            <span
              className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
              title={`共 ${nodeData.reviewStats.total_cards} 张卡片，平均稳定性 ${nodeData.reviewStats.avg_stability.toFixed(1)} 天`}
            >
              <GraduationCapIcon className="h-2.5 w-2.5" />
              {nodeData.reviewStats.due_count} 张到期
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-0.5 rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-600 dark:text-green-400"
              title={`共 ${nodeData.reviewStats.total_cards} 张卡片，平均稳定性 ${nodeData.reviewStats.avg_stability.toFixed(1)} 天`}
            >
              <GraduationCapIcon className="h-2.5 w-2.5" />
              已巩固
            </span>
          )}
        </div>
      )}

      {/* 折叠/展开按钮（hover 时 chevron 旋转） */}
      {nodeData.hasChildren && (
        <button
          type="button"
          className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-border bg-background px-1 text-xs transition-all duration-150 hover:bg-accent hover:scale-110"
          onClick={(e) => {
            e.stopPropagation();
            dispatchAction("toggle-collapse");
          }}
          onMouseDown={(e) => e.stopPropagation()}
          title={nodeData.collapsed ? "展开" : "折叠"}
        >
          <span className="inline-flex transition-transform duration-200 group-hover/kg:rotate-90">
            {nodeData.collapsed ? (
              <ChevronRightIcon className="h-3 w-3" />
            ) : (
              <ChevronDownIcon className="h-3 w-3" />
            )}
          </span>
        </button>
      )}

      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-muted-foreground/50" />
    </div>
  );
}
