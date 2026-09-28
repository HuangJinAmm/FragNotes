import type { MemoTimeBasis } from "@/contexts/ViewContext";

export interface StatisticsViewProps {
  className?: string;
}

export interface MonthNavigatorProps {
  visibleMonth: string;
  onMonthChange: (month: string) => void;
  activityStats: Record<string, number>;
  timeBasis: MemoTimeBasis;
  /** 日历筛选面板是否展开 */
  isCalendarOpen: boolean;
  /** 切换日历筛选面板展开/收起 */
  onToggleCalendar: () => void;
}

export interface StatisticsData {
  activityStats: Record<string, number>;
  timeBasis: MemoTimeBasis;
}
