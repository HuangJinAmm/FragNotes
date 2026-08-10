import { timestampDate } from "@bufbuild/protobuf/wkt";
import dayjs from "dayjs";
import { countBy } from "lodash-es";
import { useMemo } from "react";
import type { MemoExplorerContext } from "@/components/MemoExplorer";
import { useMemoFilterContext } from "@/contexts/MemoFilterContext";
import { type MemoTimeBasis, useView } from "@/contexts/ViewContext";
import { DEFAULT_LIST_MEMOS_PAGE_SIZE } from "@/helpers/consts";
import useCurrentUser from "@/hooks/useCurrentUser";
import { useMemoFilters } from "@/hooks/useMemoFilters";
import { useMemoSorting } from "@/hooks/useMemoSorting";
import { useInfiniteMemos } from "@/hooks/useMemoQueries";
import { useAllUserStats, useUserStats } from "@/hooks/useUserQueries";
import { State } from "@/types/proto/api/v1/common_pb";
import type { UserStats } from "@/types/proto/api/v1/user_service_pb";
import type { StatisticsData } from "@/types/statistics";

export interface FilteredMemoStats {
  statistics: StatisticsData;
  tags: Record<string, number>;
  /** 当前筛选结果中已加载 memo 出现过的标签集合（无筛选时为空集） */
  filteredTags: Set<string>;
  loading: boolean;
}

export interface UseFilteredMemoStatsOptions {
  userName?: string;
  context?: MemoExplorerContext;
}

const toDateString = (date: Date) => dayjs(date).format("YYYY-MM-DD");

const timestampsForBasis = (stats: UserStats, basis: MemoTimeBasis) => {
  const createdArray = stats.memoCreatedTimestamps ?? [];
  const updatedArray = stats.memoUpdatedTimestamps ?? [];
  const wantUpdated = basis === "update_time";
  const oldServerFallback = wantUpdated && updatedArray.length === 0 && createdArray.length > 0;
  if (oldServerFallback) {
    console.warn("UserStats.memo_updated_timestamps not present; falling back to memo_created_timestamps");
  }
  return wantUpdated && !oldServerFallback ? updatedArray : createdArray;
};

export const useFilteredMemoStats = (options: UseFilteredMemoStatsOptions = {}): FilteredMemoStats => {
  const { userName, context } = options;
  const currentUser = useCurrentUser();
  const { timeBasis } = useView();
  const { hasActiveFilters } = useMemoFilterContext();

  // home/profile: use backend per-user stats (full tag set, not page-limited)
  const { data: userStats, isLoading: isLoadingUserStats } = useUserStats(userName);

  // 当筛选激活时,从 PagedMemoList 已加载的缓存中提取标签集合,用于在标签栏中优先显示。
  // 仅读取缓存(enabled:false),不会触发额外请求;缓存为空时返回空集。
  const isArchivedContext = context === "archived";
  const memoFilter = useMemoFilters({
    creatorName: currentUser?.name,
    includeShortcuts: !isArchivedContext,
    includePinned: true,
  });
  const { orderBy } = useMemoSorting({
    pinnedFirst: true,
    state: isArchivedContext ? State.ARCHIVED : State.NORMAL,
  });
  const { data: filteredMemoData } = useInfiniteMemos(
    {
      state: isArchivedContext ? State.ARCHIVED : State.NORMAL,
      orderBy,
      filter: memoFilter,
      pageSize: DEFAULT_LIST_MEMOS_PAGE_SIZE,
    },
    { enabled: false },
  );
  const filteredTags = useMemo(() => {
    if (!hasActiveFilters || !filteredMemoData) return new Set<string>();
    const tags = new Set<string>();
    for (const page of filteredMemoData.pages) {
      for (const memo of page.memos) {
        for (const tag of memo.tags ?? []) {
          tags.add(tag);
        }
      }
    }
    return tags;
  }, [hasActiveFilters, filteredMemoData]);
  // explore/archived: fetch backend grouped stats and aggregate them locally.
  // ListAllUserStats AND's the request filter with the server's auth filter, so
  // private memos are not included unless explicitly visible to the current user.
  const exploreVisibilityFilter = currentUser != null ? 'visibility in ["PUBLIC", "PROTECTED"]' : 'visibility in ["PUBLIC"]';
  const allUserStatsRequest =
    context === "explore"
      ? { state: State.NORMAL, filter: exploreVisibilityFilter }
      : context === "archived"
        ? { state: State.ARCHIVED }
        : {};
  const shouldFetchAllUserStats = context === "explore" || (context === "archived" && !!currentUser?.name);
  const { data: allUserStats = [], isLoading: isLoadingAllUserStats } = useAllUserStats(allUserStatsRequest, {
    enabled: shouldFetchAllUserStats,
  });

  const data = useMemo(() => {
    const loading = isLoadingUserStats || isLoadingAllUserStats;
    let activityStats: Record<string, number> = {};
    let tagCount: Record<string, number> = {};

    if (context === "explore" || context === "archived") {
      const displayDates: string[] = [];
      for (const stats of allUserStats as UserStats[]) {
        for (const [tag, count] of Object.entries(stats.tagCount ?? {})) {
          tagCount[tag] = (tagCount[tag] ?? 0) + (count as number);
        }
        displayDates.push(
          ...timestampsForBasis(stats, timeBasis)
            .map((ts) => (ts ? timestampDate(ts) : undefined))
            .filter((date): date is Date => date !== undefined)
            .map(toDateString),
        );
      }
      activityStats = countBy(displayDates);
    } else if (userName && userStats) {
      // home/profile: use backend per-user stats.
      const sourceArray = timestampsForBasis(userStats, timeBasis);
      if (sourceArray.length > 0) {
        activityStats = countBy(
          sourceArray
            .map((ts) => (ts ? timestampDate(ts) : undefined))
            .filter((date): date is Date => date !== undefined)
            .map(toDateString),
        );
      }
      if (userStats.tagCount) {
        tagCount = userStats.tagCount;
      }
    }

    return { statistics: { activityStats, timeBasis }, tags: tagCount, filteredTags, loading };
  }, [context, userName, userStats, allUserStats, isLoadingUserStats, isLoadingAllUserStats, timeBasis, filteredTags]);

  return data;
};
