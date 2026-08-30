import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeftIcon, CheckIcon, ChevronRightIcon, FileTextIcon, NetworkIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useScoreCard } from "./hooks";
import { CARD_TYPE_LABELS, type ReviewCard, type SessionStats } from "./types";
import { useTranslate } from "@/utils/i18n";
import { kgKeys, useMemoKgNodes } from "@/hooks/useKgQueries";
import { MemoMarkdownRenderer } from "@/components/MemoContent/MemoMarkdownRenderer";
import { MemoViewContext } from "@/components/MemoView/MemoViewContext";
import { STUB_MEMO_VIEW_CONTEXT } from "@/components/MemoPreview/MemoPreview";
import KgMemoPreviewDialog from "@/components/KnowledgeGraph/KgMemoPreviewDialog";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";

// ==================== 互动卡片解析辅助 ====================

interface ChoiceOption {
  letter: string;
  text: string;
}

/** 从 front 解析选择题选项 */
function parseChoiceOptions(front: string): { question: string; options: ChoiceOption[] } {
  const lines = front.split("\n");
  const optionPattern = /^\s*([A-D])[.、)]\s*(.+)/;
  const options: ChoiceOption[] = [];
  const questionLines: string[] = [];
  for (const line of lines) {
    const match = line.match(optionPattern);
    if (match) {
      options.push({ letter: match[1], text: match[2].trim() });
    } else {
      questionLines.push(line);
    }
  }
  return { question: questionLines.join("\n").trim(), options };
}

/** 从 back 解析正确选项字母 */
function parseChoiceAnswer(back: string): string {
  const match = back.trim().match(/^([A-D])/);
  return match ? match[1] : "";
}

/** 从 back 解析判断题答案 */
function parseJudgeAnswer(back: string): boolean | null {
  const trimmed = back.trim().toLowerCase();
  if (trimmed.startsWith("正确") || trimmed.startsWith("true") || trimmed.startsWith("对")) return true;
  if (trimmed.startsWith("错误") || trimmed.startsWith("false") || trimmed.startsWith("错")) return false;
  return null;
}

// ==================== 组件 ====================

interface Props {
  deckId: number;
  onExit: () => void;
}

const INTERACTIVE_TYPES = ["choice", "judge", "cloze"];

const CardReview = ({ deckId, onExit }: Props) => {
  const t = useTranslate();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [cards, setCards] = useState<ReviewCard[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [userAnswer, setUserAnswer] = useState("");
  const [isCorrect, setIsCorrect] = useState(false);
  const [disclosureStep, setDisclosureStep] = useState(0);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [finished, setFinished] = useState(false);
  const { scoring, score } = useScoreCard();

  const loadCards = useCallback(async () => {
    const result = await invoke<ReviewCard[]>("review_list_due_cards", {
      deckId,
      limit: 100,
    });
    setCards(result);
    if (result.length === 0) {
      setFinished(true);
    }
  }, [deckId]);

  useEffect(() => {
    loadCards();
  }, [loadCards]);

  const currentCard = cards[currentIndex];

  // 当前卡片对应笔记所属的 KG 节点（翻面后才查询，避免提前泄题）
  const { data: memoNodes = [] } = useMemoKgNodes(
    currentCard && !currentCard.memo_deleted && revealed ? currentCard.memo_uid : null,
  );

  // 「查看原文」弹窗预览（不离开复习页，保留会话进度）
  const [previewMemo, setPreviewMemo] = useState<Memo | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const handleViewSource = async () => {
    if (!currentCard || currentCard.memo_deleted) return;
    try {
      const raw = await invoke<Record<string, unknown> | null>("get_memo", {
        uid: currentCard.memo_uid,
        id: null,
      });
      if (!raw) return;
      setPreviewMemo({ ...(raw as unknown as Memo), name: `memos/${raw.uid}` });
      setPreviewOpen(true);
    } catch (e) {
      console.error("加载笔记失败:", e);
    }
  };

  // 切换卡片时重置状态
  useEffect(() => {
    setRevealed(false);
    setUserAnswer("");
    setIsCorrect(false);
    setDisclosureStep(0);
  }, [currentIndex]);

  const handleScore = async (rating: number) => {
    if (!currentCard || scoring) return;
    const result = await score(currentCard.id, rating, deckId);
    if (result) {
      setSessionStats(result.session_stats);
      // 评分改变了卡片到期状态，图谱节点记忆徽章需刷新（全局 staleTime 30s 内不会自动重取）
      queryClient.invalidateQueries({ queryKey: [...kgKeys.all, "nodeReviewStats"] });
      if (currentIndex + 1 >= cards.length) {
        setFinished(true);
      } else {
        setCurrentIndex(currentIndex + 1);
      }
    }
  };

  const handleRegenerate = async () => {
    if (!currentCard) return;
    await invoke("review_regenerate_card", { cardId: currentCard.id });
  };

  // 解析互动卡片数据
  const cardType = currentCard?.card_type ?? "";
  const isInteractiveType = INTERACTIVE_TYPES.includes(cardType);

  const choiceData = cardType === "choice" ? parseChoiceOptions(currentCard?.front ?? "") : null;
  const choiceCorrect =
    choiceData && choiceData.options.length >= 2 ? parseChoiceAnswer(currentCard?.back ?? "") : "";
  const canChoice = !!(choiceData && choiceData.options.length >= 2 && choiceCorrect);

  const judgeCorrect = cardType === "judge" ? parseJudgeAnswer(currentCard?.back ?? "") : null;
  const canJudge = judgeCorrect !== null;

  const canCloze = cardType === "cloze" && !!currentCard?.cloze_answer;

  const useInteractive =
    isInteractiveType &&
    ((cardType === "choice" && canChoice) ||
      (cardType === "judge" && canJudge) ||
      (cardType === "cloze" && canCloze));

  // 将 back 内容按段落分割，用于渐进式披露
  const backSegments: string[] = currentCard
    ? currentCard.back.split(/\n\n+/).filter((s) => s.trim())
    : [];

  // 翻面时初始化披露进度（单段落直接全显，多段落从 0 开始）
  useEffect(() => {
    if (revealed && !useInteractive) {
      setDisclosureStep(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed, useInteractive, currentIndex]);

  /** 互动答题 */
  const handleAnswer = (answer: string) => {
    if (!currentCard || revealed) return;
    let correct = false;
    if (cardType === "choice") {
      correct = answer === choiceCorrect;
    } else if (cardType === "judge") {
      correct = answer === String(judgeCorrect);
    } else if (cardType === "cloze") {
      correct =
        answer.trim().toLowerCase() === (currentCard.cloze_answer ?? "").trim().toLowerCase();
    }
    setUserAnswer(answer);
    setIsCorrect(correct);
    setRevealed(true);
  };

  /** 直接看答案（算错） */
  const handleShowAnswer = () => {
    if (!currentCard || revealed) return;
    setUserAnswer("");
    setIsCorrect(false);
    setRevealed(true);
  };

  // 键盘快捷键
  useEffect(() => {
    if (finished || !currentCard) return;
    const handler = (e: KeyboardEvent) => {
      if (!revealed) {
        // 非互动类型：空格翻面
        if (!useInteractive && e.key === " ") {
          e.preventDefault();
          setRevealed(true);
        }
      } else {
        if (e.key === "1") handleScore(1);
        else if (e.key === "2") handleScore(2);
        else if (e.key === "3") handleScore(3);
        else if (e.key === "4") handleScore(4);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [revealed, currentCard, finished, useInteractive]);

  if (finished) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-6">
        <div className="text-2xl font-bold">{t("review.session-complete")}</div>
        {sessionStats && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div className="rounded-lg border p-4 text-center">
              <div className="text-2xl font-bold">{sessionStats.reviewed}</div>
              <div className="text-xs text-muted-foreground">{t("review.reviewed")}</div>
            </div>
            <div className="rounded-lg border p-4 text-center">
              <div className="text-2xl font-bold text-red-600">{sessionStats.again}</div>
              <div className="text-xs text-muted-foreground">{t("review.again")}</div>
            </div>
            <div className="rounded-lg border p-4 text-center">
              <div className="text-2xl font-bold text-green-600">
                {(sessionStats.retention_rate * 100).toFixed(0)}%
              </div>
              <div className="text-xs text-muted-foreground">{t("review.retention")}</div>
            </div>
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="outline" onClick={onExit}>
            {t("review.back-to-decks")}
          </Button>
        </div>
      </div>
    );
  }

  if (!currentCard) {
    return <div className="text-center py-8 text-muted-foreground">{t("common.loading")}</div>;
  }

  const renderMarkdown = (content: string) => (
    <MemoViewContext.Provider value={STUB_MEMO_VIEW_CONTEXT}>
      <MemoMarkdownRenderer content={content} resolvedMentionUsernames={new Set()} />
    </MemoViewContext.Provider>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部：返回 + 进度 */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onExit}>
          <ArrowLeftIcon className="size-4 mr-1" />
          {t("common.back")}
        </Button>
        <div className="text-sm text-muted-foreground">
          {currentIndex + 1} / {cards.length}
        </div>
      </div>

      {/* 卡片 */}
      <div
        className={`mx-auto w-full max-w-2xl min-h-[300px] rounded-lg border-2 border-border p-8 flex flex-col ${
          !useInteractive && !revealed ? "cursor-pointer" : ""
        }`}
        onClick={() => !useInteractive && !revealed && setRevealed(true)}
      >
        {/* 类型标签 + 答题结果 */}
        <div className="flex items-center justify-between mb-4">
          <div className="text-xs text-muted-foreground">
            {t("review.card-type")}:{" "}
            {CARD_TYPE_LABELS[currentCard.card_type] ?? currentCard.card_type}
          </div>
          {revealed && useInteractive && (
            <div
              className={`flex items-center gap-1 text-sm font-medium ${
                isCorrect ? "text-green-600" : "text-red-600"
              }`}
            >
              {isCorrect ? <CheckIcon className="size-4" /> : <XIcon className="size-4" />}
              {isCorrect ? t("review.answer-correct") : t("review.answer-incorrect")}
            </div>
          )}
        </div>

        {/* === 翻面模式（basic/reversed/concept/compare 或解析失败的互动类型）=== */}
        {!useInteractive && (
          <>
            {!revealed ? (
              <>
                <div className="w-full text-lg flex-1">{renderMarkdown(currentCard.front)}</div>
                <div className="mt-8 text-sm text-muted-foreground">
                  {t("review.click-to-flip")}
                </div>
              </>
            ) : (
              <>
                <div className="text-xs text-muted-foreground mb-4">{t("review.answer")}</div>
                <div className="w-full text-lg flex-1">
                  {renderMarkdown(
                    backSegments.slice(0, disclosureStep).join("\n\n"),
                  )}
                </div>

                {/* 渐进式披露进度条 */}
                {backSegments.length > 1 && (
                  <div className="mt-4 space-y-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{t("review.disclosure-progress")}</span>
                      <span>{disclosureStep} / {backSegments.length}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* 进度条 */}
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full bg-primary transition-all duration-300"
                          style={{
                            width: `${(disclosureStep / backSegments.length) * 100}%`,
                          }}
                        />
                      </div>
                      {/* 下一部分按钮 */}
                      {disclosureStep < backSegments.length && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setDisclosureStep((s) => Math.min(s + 1, backSegments.length))}
                        >
                          <ChevronRightIcon className="size-3.5 mr-0.5" />
                          {t("review.show-next")}
                        </Button>
                      )}
                      {/* 显示全部按钮 */}
                      {disclosureStep < backSegments.length && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDisclosureStep(backSegments.length)}
                        >
                          {t("review.show-all")}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* === 选择题 === */}
        {useInteractive && cardType === "choice" && choiceData && (
          <div className="flex flex-col gap-4 flex-1">
            <div className="text-lg">{renderMarkdown(choiceData.question)}</div>

            <div className="flex flex-col gap-2">
              {choiceData.options.map((opt) => {
                const isUserChoice = userAnswer === opt.letter;
                const isCorrectChoice = choiceCorrect === opt.letter;
                let style = "border-border hover:bg-muted/40";
                if (revealed) {
                  if (isCorrectChoice) {
                    style = "border-green-500 bg-green-50 dark:bg-green-950/30";
                  } else if (isUserChoice) {
                    style = "border-red-500 bg-red-50 dark:bg-red-950/30";
                  } else {
                    style = "border-border opacity-50";
                  }
                }
                return (
                  <button
                    key={opt.letter}
                    disabled={revealed}
                    onClick={() => handleAnswer(opt.letter)}
                    className={`flex items-center gap-2 rounded-lg border-2 px-4 py-2.5 text-left text-sm transition-colors ${style} ${
                      !revealed ? "cursor-pointer" : "cursor-default"
                    }`}
                  >
                    <span className="font-semibold">{opt.letter}.</span>
                    <span>{opt.text}</span>
                    {revealed && isCorrectChoice && (
                      <CheckIcon className="size-4 ml-auto text-green-600" />
                    )}
                    {revealed && isUserChoice && !isCorrectChoice && (
                      <XIcon className="size-4 ml-auto text-red-600" />
                    )}
                  </button>
                );
              })}
            </div>

            {revealed && (
              <div className="mt-2">
                <div className="text-xs text-muted-foreground mb-1">{t("review.answer")}</div>
                <div className="w-full">{renderMarkdown(currentCard.back)}</div>
              </div>
            )}
          </div>
        )}

        {/* === 判断题 === */}
        {useInteractive && cardType === "judge" && (
          <div className="flex flex-col gap-4 flex-1">
            <div className="text-lg flex-1">{renderMarkdown(currentCard.front)}</div>

            {!revealed && (
              <div className="flex justify-center gap-3 mt-4">
                <Button
                  variant="outline"
                  size="lg"
                  onClick={() => handleAnswer("true")}
                  className="min-w-28"
                >
                  <CheckIcon className="size-4 mr-1 text-green-600" />
                  {t("review.true")}
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  onClick={() => handleAnswer("false")}
                  className="min-w-28"
                >
                  <XIcon className="size-4 mr-1 text-red-600" />
                  {t("review.false")}
                </Button>
              </div>
            )}

            {revealed && (
              <div className="mt-2">
                <div className="text-xs text-muted-foreground mb-1">
                  {t("review.correct-answer")}: {judgeCorrect ? t("review.true") : t("review.false")}
                </div>
                <div className="w-full">{renderMarkdown(currentCard.back)}</div>
              </div>
            )}
          </div>
        )}

        {/* === 填空题 === */}
        {useInteractive && cardType === "cloze" && (
          <div className="flex flex-col gap-4 flex-1">
            <div className="text-lg">
              {renderMarkdown(
                revealed
                  ? currentCard.front.replace(
                      /\{\{[^}]+\}\}/g,
                      `**${currentCard.cloze_answer}**`,
                    )
                  : currentCard.front.replace(/\{\{[^}]+\}\}/g, "____"),
              )}
            </div>

            {!revealed && (
              <div className="flex gap-2 mt-2">
                <Input
                  value={userAnswer}
                  onChange={(e) => setUserAnswer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (userAnswer.trim()) handleAnswer(userAnswer);
                    }
                  }}
                  placeholder={t("review.type-answer")}
                  className="flex-1"
                />
                <Button
                  onClick={() => userAnswer.trim() && handleAnswer(userAnswer)}
                  disabled={!userAnswer.trim()}
                >
                  {t("review.submit")}
                </Button>
                <Button variant="ghost" onClick={handleShowAnswer}>
                  {t("review.show-answer")}
                </Button>
              </div>
            )}

            {revealed && (
              <div className="mt-2 space-y-2">
                {userAnswer && (
                  <div>
                    <span className="text-xs text-muted-foreground">
                      {t("review.your-answer")}:{" "}
                    </span>
                    <span
                      className={`text-sm font-medium ${
                        isCorrect ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      {userAnswer}
                    </span>
                  </div>
                )}
                <div>
                  <div className="text-xs text-muted-foreground mb-1">{t("review.answer")}</div>
                  <div className="w-full">{renderMarkdown(currentCard.back)}</div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 上下文跳转：查看原文 + 所属图谱节点（翻面后显示，避免提前泄题） */}
      {revealed && (
        <div className="mx-auto flex w-full max-w-2xl flex-wrap items-center gap-2">
          {!currentCard.memo_deleted && (
            <button
              type="button"
              onClick={handleViewSource}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
            >
              <FileTextIcon className="size-3" />
              {t("review.view-source")}
            </button>
          )}
          {memoNodes.map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => navigate(`/knowledge-graph/${node.graph_id}?select=${node.id}`)}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
            >
              <NetworkIcon className="size-3" />
              {node.name}
            </button>
          ))}
        </div>
      )}

      {/* 评分按钮 */}
      {revealed && (
        <>
          <div className="flex justify-center gap-2">
            <Button variant="destructive" onClick={() => handleScore(1)} disabled={scoring}>
              {t("review.again")} (1)
            </Button>
            <Button variant="outline" onClick={() => handleScore(2)} disabled={scoring}>
              {t("review.hard")} (2)
            </Button>
            <Button variant="default" onClick={() => handleScore(3)} disabled={scoring}>
              {t("review.good")} (3)
            </Button>
            <Button variant="default" onClick={() => handleScore(4)} disabled={scoring}>
              {t("review.easy")} (4)
            </Button>
          </div>
          <div className="flex justify-center">
            <Button variant="ghost" size="sm" onClick={handleRegenerate}>
              <RotateCcwIcon className="size-4 mr-1" />
              {t("review.regenerate-angle")}
            </Button>
          </div>
        </>
      )}

      {/* 原文预览弹窗（不离开复习页） */}
      <KgMemoPreviewDialog memo={previewMemo} open={previewOpen} onOpenChange={setPreviewOpen} />
    </div>
  );
};

export default CardReview;
