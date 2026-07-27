import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EyeIcon, PencilIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { MemoMarkdownRenderer } from "@/components/MemoContent/MemoMarkdownRenderer";
import { MemoViewContext } from "@/components/MemoView/MemoViewContext";
import { STUB_MEMO_VIEW_CONTEXT } from "@/components/MemoPreview/MemoPreview";
import { useTranslate } from "@/utils/i18n";
import type { ReviewCard } from "./types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  card: ReviewCard | null;
  onSaved: (card: ReviewCard) => void;
  onSave: (params: {
    cardId: number;
    front: string;
    back: string;
    clozeAnswer: string | null;
    angle: string;
  }) => Promise<ReviewCard | null>;
  saving: boolean;
}

type Mode = "edit" | "preview";

const CardEditDialog = ({ open, onOpenChange, card, onSaved, onSave, saving }: Props) => {
  const t = useTranslate();
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [clozeAnswer, setClozeAnswer] = useState("");
  const [angle, setAngle] = useState("");
  const [mode, setMode] = useState<Mode>("edit");

  // 同步 initial 数据
  useEffect(() => {
    if (open && card) {
      setFront(card.front);
      setBack(card.back);
      setClozeAnswer(card.cloze_answer ?? "");
      setAngle(card.angle ?? "");
      setMode("edit");
    }
  }, [open, card]);

  const isCloze = card?.card_type === "cloze";

  const handleSubmit = async () => {
    if (!card || !front.trim()) return;
    const result = await onSave({
      cardId: card.id,
      front,
      back,
      clozeAnswer: isCloze ? clozeAnswer || null : null,
      angle,
    });
    if (result) {
      onSaved(result);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("review.edit-card")}</DialogTitle>
        </DialogHeader>

        {/* 模式切换 */}
        <div className="flex items-center gap-1 border-b border-border">
          <button
            type="button"
            onClick={() => setMode("edit")}
            className={`flex items-center gap-1 px-3 py-1.5 text-sm border-b-2 -mb-px transition-colors ${
              mode === "edit"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <PencilIcon className="size-3.5" />
            {t("review.edit-mode")}
          </button>
          <button
            type="button"
            onClick={() => setMode("preview")}
            className={`flex items-center gap-1 px-3 py-1.5 text-sm border-b-2 -mb-px transition-colors ${
              mode === "preview"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <EyeIcon className="size-3.5" />
            {t("review.preview-mode")}
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto py-2">
          {mode === "edit" ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>{t("review.angle")}</Label>
                <Input
                  value={angle}
                  onChange={(e) => setAngle(e.target.value)}
                  placeholder={t("review.angle-placeholder")}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("review.front")}</Label>
                <Textarea
                  value={front}
                  onChange={(e) => setFront(e.target.value)}
                  rows={4}
                  placeholder={t("review.markdown-supported")}
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-2">
                <Label>{t("review.back")}</Label>
                <Textarea
                  value={back}
                  onChange={(e) => setBack(e.target.value)}
                  rows={6}
                  placeholder={t("review.markdown-supported")}
                  className="font-mono text-sm"
                />
              </div>
              {isCloze && (
                <div className="space-y-2">
                  <Label>{t("review.cloze-answer")}</Label>
                  <Input
                    value={clozeAnswer}
                    onChange={(e) => setClozeAnswer(e.target.value)}
                    placeholder={t("review.cloze-answer-placeholder")}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {angle && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">{t("review.angle")}</div>
                  <div className="text-sm">{angle}</div>
                </div>
              )}
              <div>
                <div className="text-xs text-muted-foreground mb-1">{t("review.front")}</div>
                <div className="rounded-md border border-border p-3">
                  <MemoViewContext.Provider value={STUB_MEMO_VIEW_CONTEXT}>
                    <MemoMarkdownRenderer
                      content={front}
                      resolvedMentionUsernames={new Set()}
                    />
                  </MemoViewContext.Provider>
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">{t("review.back")}</div>
                <div className="rounded-md border border-border p-3">
                  <MemoViewContext.Provider value={STUB_MEMO_VIEW_CONTEXT}>
                    <MemoMarkdownRenderer
                      content={back}
                      resolvedMentionUsernames={new Set()}
                    />
                  </MemoViewContext.Provider>
                </div>
              </div>
              {isCloze && clozeAnswer && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">
                    {t("review.cloze-answer")}
                  </div>
                  <div className="text-sm font-medium">{clozeAnswer}</div>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={saving || !front.trim()}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default CardEditDialog;
