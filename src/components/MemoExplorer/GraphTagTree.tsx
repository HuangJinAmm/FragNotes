import { ChevronRightIcon, HashIcon, icons as lucideIcons } from "lucide-react";
import { type ComponentType, useCallback, useEffect, useMemo, useState } from "react";
import { NODE_COLOR_PALETTE } from "@/components/KnowledgeGraph/constants";
import { type MemoFilter, useMemoFilterContext } from "@/contexts/MemoFilterContext";
import { cn } from "@/lib/utils";
import type { KgNode } from "@/types/kg";

/**
 * 图谱标签树：层级来自图谱节点树（KgNode.parent_id）。
 * 每个节点为一级条目（点击仅展开/收起），节点下方依次列出它的标签（点击写入 tagSearch 筛选）与子节点。
 */
interface Props {
  nodes: KgNode[];
  /** 自动展开所有节点层级 */
  expandAll: boolean;
}

interface NodeTreeItem {
  node: KgNode;
  children: NodeTreeItem[];
}

/** 按 parent_id 构建节点树；无效父子关系与成环的节点会提升为根，避免节点丢失 */
const buildNodeTree = (nodes: KgNode[]): NodeTreeItem[] => {
  const itemById = new Map<number, NodeTreeItem>();
  for (const node of nodes) {
    itemById.set(node.id, { node, children: [] });
  }

  const sorted = [...nodes].sort((a, b) => a.created_ts - b.created_ts || a.id - b.id);
  const roots: NodeTreeItem[] = [];

  for (const node of sorted) {
    const item = itemById.get(node.id)!;
    // 沿 parent_id 上溯，出现环或父节点缺失时该节点作为根
    let parentItem: NodeTreeItem | undefined;
    if (node.parent_id != null) {
      const seen = new Set<number>([node.id]);
      let cursor: KgNode | undefined = node;
      while (cursor?.parent_id != null) {
        const next = itemById.get(cursor.parent_id);
        if (!next || seen.has(next.node.id)) {
          parentItem = undefined;
          break;
        }
        seen.add(next.node.id);
        parentItem = next;
        cursor = next.node;
      }
    }

    if (parentItem) {
      parentItem.children.push(item);
    } else {
      roots.push(item);
    }
  }

  return roots;
};

interface GraphTagRowProps {
  tag: string;
}

const GraphTagRow = ({ tag }: GraphTagRowProps) => {
  const { getFiltersByFactor, addFilter, removeFilter } = useMemoFilterContext();
  const isActive = getFiltersByFactor("tagSearch").some((filter: MemoFilter) => filter.value === tag);

  const handleClick = useCallback(() => {
    if (isActive) {
      removeFilter((f: MemoFilter) => f.factor === "tagSearch" && f.value === tag);
    } else {
      addFilter({ factor: "tagSearch", value: tag });
    }
  }, [isActive, tag, addFilter, removeFilter]);

  return (
    <div className="relative flex flex-row justify-between items-center w-full leading-6 py-0 mt-px text-sm select-none shrink-0">
      <div
        className={cn(
          "flex flex-row justify-start items-center truncate shrink leading-5 mr-1 cursor-pointer transition-colors",
          isActive ? "text-primary" : "text-muted-foreground",
        )}
        onClick={handleClick}
      >
        <HashIcon className="w-4 h-auto shrink-0 mr-1" />
        <span className={cn("truncate hover:opacity-80", isActive ? "font-medium" : "")}>{tag}</span>
      </div>
    </div>
  );
};

interface TreeNodeProps {
  item: NodeTreeItem;
  expandAll: boolean;
}

const GraphTagTreeNode = ({ item, expandAll }: TreeNodeProps) => {
  const { node, children } = item;
  const [expanded, setExpanded] = useState(expandAll);
  const hasChildren = children.length > 0 || node.tags.length > 0;

  useEffect(() => {
    setExpanded(expandAll);
  }, [expandAll]);

  const colorDot = NODE_COLOR_PALETTE.find((color) => color.key === node.color)?.dot;
  const IconComponent = useMemo(() => {
    if (!node.icon) return null;
    const iconKey = node.icon.replace(/Icon$/, "");
    return (lucideIcons as Record<string, ComponentType<{ className?: string }>>)[iconKey] ?? null;
  }, [node.icon]);

  const handleToggle = useCallback(() => setExpanded((current) => !current), []);

  return (
    <>
      <div
        className={cn(
          "relative flex flex-row justify-between items-center w-full leading-6 py-0 mt-px text-sm select-none shrink-0",
          hasChildren && "cursor-pointer",
        )}
        onClick={hasChildren ? handleToggle : undefined}
      >
        <div className="flex flex-row justify-start items-center min-w-0 mr-1">
          <span className="flex flex-row justify-center items-center w-4 h-4 shrink-0">
            {hasChildren && (
              <ChevronRightIcon
                className={cn("w-3.5 h-3.5 text-muted-foreground transition-transform", expanded && "rotate-90")}
              />
            )}
          </span>
          {colorDot && <span className={cn("w-2 h-2 mr-1 rounded-full shrink-0", colorDot)} />}
          {IconComponent && <IconComponent className="w-3.5 h-3.5 mr-1 shrink-0 text-muted-foreground" />}
          <span className={cn("truncate text-foreground/90", hasChildren && "hover:opacity-80")}>{node.name}</span>
          {node.tags.length > 0 && <span className="ml-1 shrink-0 text-xs opacity-60">({node.tags.length})</span>}
        </div>
      </div>

      {hasChildren && (
        <div
          className={cn(
            "w-[calc(100%-0.5rem)] flex flex-col justify-start items-start h-auto ml-2 pl-2 border-l-2 border-l-border",
            !expanded && "hidden",
          )}
        >
          {node.tags.map((tag) => (
            <GraphTagRow key={tag} tag={tag} />
          ))}
          {children.map((child) => (
            <GraphTagTreeNode key={child.node.id} item={child} expandAll={expandAll} />
          ))}
        </div>
      )}
    </>
  );
};

const GraphTagTree = ({ nodes, expandAll }: Props) => {
  const roots = useMemo(() => buildNodeTree(nodes), [nodes]);

  return (
    <div className="flex flex-col justify-start items-start relative w-full h-auto flex-nowrap gap-1 mt-1">
      {roots.map((item) => (
        <GraphTagTreeNode key={item.node.id} item={item} expandAll={expandAll} />
      ))}
    </div>
  );
};

export default GraphTagTree;
