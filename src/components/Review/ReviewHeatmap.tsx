import HeatMap from "@uiw/react-heat-map";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import dayjs from "dayjs";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useReviewTimestamps } from "./hooks";
import { useTranslate } from "@/utils/i18n";

const ReviewHeatmap = () => {
  const t = useTranslate();
  const { timestamps, loading } = useReviewTimestamps();
  const [selectedYear, setSelectedYear] = useState(() => new Date().getFullYear());

  const containerRef = useRef<HTMLDivElement>(null);
  const [heatMapWidth, setHeatMapWidth] = useState(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateWidth = () => {
      const width = el.offsetWidth;
      if (width > 0) setHeatMapWidth(width);
    };

    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const heatMapValue = useMemo(() => {
    if (timestamps.length === 0) return [];
    const counts: Record<string, number> = {};
    for (const ts of timestamps) {
      const key = dayjs.unix(ts).format("YYYY/MM/DD");
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.entries(counts).map(([date, count]) => ({ date, count }));
  }, [timestamps]);

  const startDate = useMemo(() => new Date(`${selectedYear}/01/01`), [selectedYear]);
  const endDate = useMemo(() => new Date(`${selectedYear}/12/31`), [selectedYear]);

  if (loading) {
    return (
      <div className="rounded-xl border border-border/20 bg-muted/5 p-4">
        <div className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</div>
      </div>
    );
  }

  if (timestamps.length === 0) {
    return null;
  }

  const minWidth = 740;
  const effectiveWidth = Math.max(heatMapWidth, minWidth);

  return (
    <div className="rounded-xl border border-border/20 bg-muted/5">
      <div className="px-4 pt-3 pb-1">
        <h3 className="text-sm font-medium text-foreground">{t("review.heatmap-title")}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{t("review.heatmap-description")}</p>
      </div>
      <div className="flex items-center gap-2 px-4 pt-2 pb-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSelectedYear(selectedYear - 1)}
          aria-label="Previous year"
          className="h-7 w-7 p-0"
        >
          <ChevronLeftIcon className="w-4 h-4" />
        </Button>
        <span className="text-lg font-semibold tracking-tight">{selectedYear}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSelectedYear(selectedYear + 1)}
          aria-label="Next year"
          className="h-7 w-7 p-0"
          disabled={selectedYear >= new Date().getFullYear()}
        >
          <ChevronRightIcon className="w-4 h-4" />
        </Button>
        {selectedYear !== new Date().getFullYear() && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedYear(new Date().getFullYear())}
            className="h-7 px-2 text-xs"
          >
            {t("common.today")}
          </Button>
        )}
      </div>
      <div ref={containerRef} className="w-full p-3">
        <div className="w-full overflow-x-auto">
          <div className="flex justify-center min-w-max">
            <HeatMap
              value={heatMapValue}
              width={effectiveWidth}
              startDate={startDate}
              endDate={endDate}
              weekLabels={["", "Mon", "", "Wed", "", "Fri", ""]}
              panelColors={{
                0: "#ebedf0",
                2: "#c6e48b",
                4: "#7bc96f",
                6: "#239a3b",
                8: "#196127",
              }}
              rectProps={{ rx: 2 }}
              legendCellSize={0}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default ReviewHeatmap;
