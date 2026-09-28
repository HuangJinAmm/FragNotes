import dayjs from "dayjs";
import { CalendarIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { YearCalendar } from "@/components/ActivityCalendar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { addMonths, formatMonth, getMonthFromDate, getYearFromDate, setYearAndMonth } from "@/lib/calendar-utils";
import { cn } from "@/lib/utils";
import type { MonthNavigatorProps } from "@/types/statistics";
import { CALENDAR_PANEL_ID } from "./constants";

export const MonthNavigator = memo(
  ({ visibleMonth, onMonthChange, activityStats, timeBasis, isCalendarOpen, onToggleCalendar }: MonthNavigatorProps) => {
    const { i18n } = useTranslation();
    const [isOpen, setIsOpen] = useState(false);

    const { currentMonth, currentYear, currentMonthNum } = useMemo(
      () => ({
        currentMonth: dayjs(visibleMonth).toDate(),
        currentYear: getYearFromDate(visibleMonth),
        currentMonthNum: getMonthFromDate(visibleMonth),
      }),
      [visibleMonth],
    );

    const monthLabel = useMemo(
      () => currentMonth.toLocaleString(i18n.language, { year: "numeric", month: "long" }),
      [currentMonth, i18n.language],
    );

    const handlePrevMonth = useCallback(() => onMonthChange(addMonths(visibleMonth, -1)), [visibleMonth, onMonthChange]);
    const handleNextMonth = useCallback(() => onMonthChange(addMonths(visibleMonth, 1)), [visibleMonth, onMonthChange]);

    const handleDateClick = useCallback(
      (date: string) => {
        onMonthChange(formatMonth(date));
        setIsOpen(false);
      },
      [onMonthChange],
    );

    const handleYearChange = useCallback(
      (year: number) => onMonthChange(setYearAndMonth(year, currentMonthNum)),
      [currentMonthNum, onMonthChange],
    );

    return (
      <header className="w-full mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onToggleCalendar}
          aria-expanded={isCalendarOpen}
          aria-controls={CALENDAR_PANEL_ID}
          title={isCalendarOpen ? "Collapse calendar" : "Expand calendar"}
          className={cn(
            "-ml-1 flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-sm font-medium text-foreground select-none",
            "transition-colors hover:bg-accent/60",
          )}
        >
          <ChevronDownIcon
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
              !isCalendarOpen && "-rotate-90",
            )}
          />
          <span className="truncate">{monthLabel}</span>
        </button>

        <nav className="flex items-center shrink-0" aria-label="Month navigation">
          <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Select year" title="Select year">
                <CalendarIcon className="w-4 h-4" />
              </Button>
            </DialogTrigger>
            <DialogContent
              className="p-0 border border-border/20 bg-background md:max-w-6xl w-[min(100vw-24px,1200px)] max-h-[85vh] overflow-y-auto rounded-xl shadow-xl"
              size="2xl"
              showCloseButton={false}
            >
              <DialogTitle className="sr-only">Select Month</DialogTitle>
              <YearCalendar
                selectedYear={currentYear}
                data={activityStats}
                onYearChange={handleYearChange}
                onDateClick={handleDateClick}
                timeBasis={timeBasis}
              />
            </DialogContent>
          </Dialog>

          <Button variant="ghost" size="icon-sm" onClick={handlePrevMonth} aria-label="Previous month">
            <ChevronLeftIcon className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={handleNextMonth} aria-label="Next month">
            <ChevronRightIcon className="w-4 h-4" />
          </Button>
        </nav>
      </header>
    );
  },
);

MonthNavigator.displayName = "MonthNavigator";
