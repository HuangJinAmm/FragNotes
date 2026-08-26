import { Button } from "@/components/ui/button";
import { ArrowLeftIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import CardTable from "./CardTable";
import DeckStatsView from "./DeckStats";
import { useDeckStats, useGenerateCards, useRegenerateMemoCards, useReviewCards } from "./hooks";
import type { ReviewDeck } from "./types";
import { useTranslate } from "@/utils/i18n";

interface Props {
  deck: ReviewDeck;
  onBack: () => void;
  onStartReview: () => void;
  /** 笔记侧栏「重新生成」跳转带来的 memo uid，进入后自动重生成并清除参数 */
  regenerateMemoUid?: string | null;
  /** 返回按钮文案（有来源上下文时显示「返回图谱」/「返回笔记」） */
  backLabel?: string;
  /** 来源上下文 query（regenerate replace 时保留，避免丢失返回来源） */
  backQuery?: string;
}

const DeckDetail = ({ deck, onBack, onStartReview, regenerateMemoUid, backLabel, backQuery }: Props) => {
  const t = useTranslate();
  const navigate = useNavigate();
  const { stats, refresh: refreshStats } = useDeckStats(deck.id);
  const { cards, refresh: refreshCards } = useReviewCards(deck.id);
  const { generating, progress, result, generate } = useGenerateCards(deck.id);
  const {
    generating: memoRegenerating,
    progress: memoProgress,
    result: memoResult,
    error: memoError,
    regenerate: regenerateMemo,
  } = useRegenerateMemoCards(deck.id);
  const [showProgress, setShowProgress] = useState(false);

  const handleGenerate = async () => {
    setShowProgress(true);
    await generate();
    refreshCards();
    refreshStats();
  };

  // 从笔记侧栏「重新生成」跳转而来：自动触发该笔记的卡片重生成，随后清除 URL 参数（保留来源上下文）
  useEffect(() => {
    if (!regenerateMemoUid) return;
    setShowProgress(true);
    regenerateMemo(regenerateMemoUid);
    navigate(`/review/${deck.id}${backQuery ?? ""}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regenerateMemoUid]);

  // 重生成完成（成功或失败）后刷新卡片列表与统计
  useEffect(() => {
    if (!memoRegenerating && (memoResult || memoError)) {
      refreshCards();
      refreshStats();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoRegenerating, memoResult, memoError]);

  const busy = generating || memoRegenerating;

  return (
    <div className="space-y-4">
      {/* 顶部 */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon className="size-4 mr-1" />
          {backLabel ?? t("common.back")}
        </Button>
      </div>

      {/* Deck 信息 */}
      <div>
        <h1 className="text-2xl font-bold">{deck.name}</h1>
        <div className="flex flex-wrap gap-2 mt-1">
          {deck.tags.map((tag) => (
            <span key={tag} className="text-sm text-muted-foreground">
              #{tag}
            </span>
          ))}
        </div>
      </div>

      {/* 统计 */}
      <DeckStatsView stats={stats} />

      {/* 操作 */}
      <div className="flex gap-2">
        <Button onClick={onStartReview} disabled={stats?.due_count === 0}>
          <PlayIcon className="size-4 mr-1" />
          {t("review.start-review")}
        </Button>
        <Button variant="outline" onClick={handleGenerate} disabled={busy}>
          <RefreshCwIcon className={`size-4 mr-1 ${busy ? "animate-spin" : ""}`} />
          {t("review.generate-cards")}
        </Button>
      </div>

      {/* 生成进度 */}
      {showProgress && busy && (
        <div className="rounded-lg border border-border p-3">
          <div className="text-sm font-medium mb-2">{t("review.generating")}</div>
          <div className="text-xs text-muted-foreground max-h-32 overflow-auto whitespace-pre-wrap">
            {memoRegenerating ? memoProgress : progress}
          </div>
        </div>
      )}
      {(result || memoResult) && !busy && (
        <div className="rounded-lg border border-green-500 p-3">
          <div className="text-sm text-green-600">
            {t("review.generated", { count: (memoResult ?? result)!.count })}
          </div>
        </div>
      )}
      {memoError && !busy && (
        <div className="rounded-lg border border-red-500 p-3">
          <div className="text-sm text-red-600">{memoError}</div>
        </div>
      )}

      {/* 卡片列表 */}
      <div>
        <h2 className="text-lg font-semibold mb-2">{t("review.cards")}</h2>
        <CardTable cards={cards} onRefresh={refreshCards} />
      </div>
    </div>
  );
};

export default DeckDetail;
