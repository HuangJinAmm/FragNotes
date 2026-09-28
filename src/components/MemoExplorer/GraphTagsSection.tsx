import { CheckIcon, ChevronRightIcon, GalleryHorizontalEndIcon, MoreVerticalIcon } from "lucide-react";
import { useMemo } from "react";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useLocalStorage } from "@/hooks";
import { useKgGraphs, useKgNodes } from "@/hooks/useKgQueries";
import { cn } from "@/lib/utils";
import { useTranslate } from "@/utils/i18n";
import GraphTagTree from "./GraphTagTree";

/**
 * 左侧面板的「图谱标签」区块：
 * 聚合当前图谱所有节点的 tags，按图谱节点树（parent_id）分层展示，
 * 点击标签写入 tagSearch 筛选，与 TagsSection 的行为保持一致。
 */
const GraphTagsSection = () => {
  const t = useTranslate();
  // 区块展开状态与树自动展开，沿用标签区块的偏好 key
  const [isExpanded, setIsExpanded] = useLocalStorage<boolean>("graph-tags-expanded", true);
  const [autoExpand, setAutoExpand] = useLocalStorage<boolean>("tag-tree-auto-expand", false);
  // 用户在面板内选择的图谱（记忆）；图谱页最后打开的图谱作为默认值
  const [pickedGraphId, setPickedGraphId] = useLocalStorage<number | null>("graph-tags-graph-id", null);
  const [lastGraphId] = useLocalStorage<number | null>("kg-last-graph-id", null);

  const { data: graphs = [] } = useKgGraphs();

  const graphId = useMemo(() => {
    if (pickedGraphId != null && graphs.some((g) => g.id === pickedGraphId)) return pickedGraphId;
    if (lastGraphId != null && graphs.some((g) => g.id === lastGraphId)) return lastGraphId;
    return graphs[0]?.id ?? null;
  }, [graphs, pickedGraphId, lastGraphId]);

  const graphName = useMemo(() => graphs.find((g) => g.id === graphId)?.name ?? "", [graphs, graphId]);

  // 区块收起时不请求节点数据，避免每次进入备忘录页都产生多余调用
  const { data: nodes, isLoading } = useKgNodes(graphId ?? undefined, { enabled: isExpanded && graphId != null });

  // 去重后的标签数量（同一标签出现在多个节点时只计一次）
  const totalTagCount = useMemo(() => {
    const uniqueTags = new Set<string>();
    for (const node of nodes ?? []) {
      for (const rawTag of node.tags) {
        const tag = rawTag.trim();
        if (tag) uniqueTags.add(tag);
      }
    }
    return uniqueTags.size;
  }, [nodes]);

  // 没有任何图谱时整个区块不渲染
  if (graphs.length === 0) {
    return null;
  }

  return (
    <div className="w-full flex flex-col justify-start items-start mt-3 px-1 h-auto shrink-0 flex-nowrap">
      <div className="flex flex-row justify-between items-center w-full gap-1 mb-1 text-sm leading-6 text-muted-foreground select-none">
        <button
          type="button"
          onClick={() => setIsExpanded((prev) => !prev)}
          aria-expanded={isExpanded}
          title={graphName}
          className="flex min-w-0 items-center gap-1 transition-colors hover:text-foreground"
        >
          <ChevronRightIcon className={cn("w-4 h-4 shrink-0 transition-transform", isExpanded && "rotate-90")} />
          <span className="truncate">{t("kg.tags-section")}</span>
          {totalTagCount > 0 && <span className="opacity-60 text-xs shrink-0">({totalTagCount})</span>}
        </button>

        <Popover>
          <PopoverTrigger>
            <MoreVerticalIcon className="w-4 h-auto shrink-0 text-muted-foreground cursor-pointer hover:text-foreground" />
          </PopoverTrigger>
          <PopoverContent align="end" alignOffset={-12} className="min-w-40">
            {graphs.length > 1 && (
              <>
                <div className="px-1.5 pt-1 pb-0.5 text-xs text-muted-foreground">{t("kg.tags-select-graph")}</div>
                <div className="max-h-60 overflow-auto">
                  {graphs.map((graph) => (
                    <button
                      key={graph.id}
                      type="button"
                      onClick={() => setPickedGraphId(graph.id)}
                      className={cn(
                        "w-full flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm transition-colors hover:bg-accent",
                        graph.id === graphId ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{graph.name}</span>
                      {graph.id === graphId && <CheckIcon className="w-3.5 h-3.5 shrink-0 text-primary" />}
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="w-auto flex flex-row justify-between items-center gap-2 p-1">
              <span className="text-sm shrink-0">{t("common.auto-expand")}</span>
              <Switch checked={!!autoExpand} onCheckedChange={(checked) => setAutoExpand(checked)} />
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {isExpanded && (
        <>
          {graphs.length > 1 && graphName && (
            <div className="w-full flex items-center gap-1 mb-0.5 text-xs text-muted-foreground/70">
              <GalleryHorizontalEndIcon className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{graphName}</span>
            </div>
          )}

          {isLoading ? (
            <div className="w-full py-1 text-xs text-muted-foreground/70">{t("common.loading")}</div>
          ) : totalTagCount === 0 ? (
            <div className="w-full py-1 text-sm text-muted-foreground italic">{t("kg.tags-empty")}</div>
          ) : (
            <GraphTagTree nodes={nodes ?? []} expandAll={!!autoExpand} />
          )}
        </>
      )}
    </div>
  );
};

export default GraphTagsSection;
