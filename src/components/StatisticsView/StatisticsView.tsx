import dayjs from "dayjs";
import { useCallback, useState } from "react";
import { calculateMaxCount, MonthCalendar } from "@/components/ActivityCalendar";
import { useDateFilterNavigation } from "@/hooks";
import { cn } from "@/lib/utils";
import type { StatisticsData } from "@/types/statistics";
import { CALENDAR_PANEL_ID } from "./constants";
import { MonthNavigator } from "./MonthNavigator";

interface Props {
  statisticsData: StatisticsData;
}

const StatisticsView = (props: Props) => {
  const { statisticsData } = props;
  const { activityStats, timeBasis } = statisticsData;
  const navigateToDateFilter = useDateFilterNavigation();
  const [visibleMonthString, setVisibleMonthString] = useState(dayjs().format("YYYY-MM"));
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);

  const handleToggleCalendar = useCallback(() => setIsCalendarOpen((prev) => !prev), []);

  const handleDateClick = useCallback(
    (date: string) => {
      navigateToDateFilter(date);
      setIsCalendarOpen(false);
    },
    [navigateToDateFilter],
  );

  return (
    <div className="group w-full mt-2 flex flex-col text-muted-foreground animate-fade-in">
      <MonthNavigator
        visibleMonth={visibleMonthString}
        onMonthChange={setVisibleMonthString}
        activityStats={activityStats}
        timeBasis={timeBasis}
        isCalendarOpen={isCalendarOpen}
        onToggleCalendar={handleToggleCalendar}
      />

      <div
        id={CALENDAR_PANEL_ID}
        aria-hidden={!isCalendarOpen}
        inert={!isCalendarOpen}
        className={cn(
          "grid w-full overflow-hidden",
          "transition-[grid-template-rows,opacity] duration-200 ease-out",
          isCalendarOpen ? "grid-rows-[1fr] opacity-100 pb-1" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <MonthCalendar
            month={visibleMonthString}
            data={activityStats}
            maxCount={calculateMaxCount(activityStats)}
            onClick={handleDateClick}
            timeBasis={timeBasis}
          />
        </div>
      </div>
    </div>
  );
};

export default StatisticsView;
