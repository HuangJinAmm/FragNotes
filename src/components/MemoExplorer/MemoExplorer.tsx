import SearchBar from "@/components/SearchBar";
import useCurrentUser from "@/hooks/useCurrentUser";
import { cn } from "@/lib/utils";
import type { StatisticsData } from "@/types/statistics";
import StatisticsView from "../StatisticsView";
import FiltersSection from "./FiltersSection";
import GraphTagsSection from "./GraphTagsSection";
import ShortcutsSection from "./ShortcutsSection";

export type MemoExplorerContext = "home" | "explore" | "archived" | "profile";

export interface MemoExplorerFeatures {
  search?: boolean;
  statistics?: boolean;
  shortcuts?: boolean;
  tags?: boolean;
  /** 知识图谱标签区块 */
  graphTags?: boolean;
}

interface Props {
  className?: string;
  context?: MemoExplorerContext;
  features?: MemoExplorerFeatures;
  statisticsData: StatisticsData;
  tagCount: Record<string, number>;
  /** 保留字段：标签展示区块移除后暂未消费，标签筛选改由 SearchBar 标签模式承担 */
  filteredTagSet?: Set<string>;
}

const getDefaultFeatures = (context: MemoExplorerContext): MemoExplorerFeatures => {
  switch (context) {
    case "explore":
      return {
        search: true,
        statistics: true,
        shortcuts: false, // Global explore doesn't use shortcuts
        tags: true,
        graphTags: true,
      };
    case "archived":
      return {
        search: true,
        statistics: true,
        shortcuts: false, // Archived doesn't typically use shortcuts
        tags: true,
        graphTags: true,
      };
    case "profile":
      return {
        search: true,
        statistics: true,
        shortcuts: false, // Profile view doesn't use shortcuts
        tags: true,
        graphTags: true,
      };
    case "home":
    default:
      return {
        search: true,
        statistics: true,
        shortcuts: true,
        tags: true,
        graphTags: true,
      };
  }
};

const MemoExplorer = (props: Props) => {
  const { className, context = "home", features: featureOverrides = {}, statisticsData, tagCount } = props;
  const currentUser = useCurrentUser();

  // Merge default features with overrides
  const features = {
    ...getDefaultFeatures(context),
    ...featureOverrides,
  };

  return (
    <aside
      className={cn(
        "relative w-full h-full overflow-auto flex flex-col justify-start items-start bg-background text-sidebar-foreground",
        className,
      )}
    >
      {features.search && <SearchBar tagCount={tagCount} />}
      <div className="mt-1 px-1 w-full">
        {features.statistics && <StatisticsView statisticsData={statisticsData} />}
        {features.shortcuts && currentUser && <ShortcutsSection />}
        {features.graphTags && <GraphTagsSection />}
        {features.tags && <FiltersSection />}
      </div>
    </aside>
  );
};

export default MemoExplorer;
