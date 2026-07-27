import { Button } from "@/components/ui/button";
import { ChevronDownIcon, ChevronRightIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Fragment, useState } from "react";
import type { FC } from "react";
import { CARD_STATE_LABELS, CARD_TYPE_LABELS, type ReviewCard } from "./types";
import { useTranslate } from "@/utils/i18n";
import { useUpdateCard } from "./hooks";
import { MemoMarkdownRenderer } from "@/components/MemoContent/MemoMarkdownRenderer";
import { MemoViewContext } from "@/components/MemoView/MemoViewContext";
import { STUB_MEMO_VIEW_CONTEXT } from "@/components/MemoPreview/MemoPreview";
import CardEditDialog from "./CardEditDialog";

interface Props {
  cards: ReviewCard[];
  onRefresh: () => void;
}

const CardTable: FC<Props> = ({ cards, onRefresh }) => {
  const t = useTranslate();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingCard, setEditingCard] = useState<ReviewCard | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const { saving, update } = useUpdateCard();

  const handleDelete = async (cardId: number) => {
    if (!confirm(t("review.confirm-delete-card"))) return;
    await invoke("review_delete_card", { cardId });
    if (expandedId === cardId) setExpandedId(null);
    onRefresh();
  };

  const handleToggleExpand = (cardId: number) => {
    setExpandedId((prev) => (prev === cardId ? null : cardId));
  };

  const handleEditClick = (card: ReviewCard) => {
    setEditingCard(card);
    setEditOpen(true);
  };

  const handleSaved = (_card: ReviewCard) => {
    onRefresh();
  };

  const formatDate = (ts: number) => {
    return new Date(ts * 1000).toLocaleDateString();
  };

  if (cards.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">{t("review.no-cards")}</div>
    );
  }

  return (
    <>
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="w-8 p-2"></th>
              <th className="text-left p-2">{t("review.front")}</th>
              <th className="text-left p-2">{t("review.card-type")}</th>
              <th className="text-left p-2">{t("review.angle")}</th>
              <th className="text-left p-2">{t("review.due")}</th>
              <th className="text-left p-2">{t("review.state")}</th>
              <th className="text-left p-2">{t("review.reps")}</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {cards.map((card) => (
              <Fragment key={card.id}>
                <tr className="border-t border-border hover:bg-muted/40">
                  <td className="p-2 text-center">
                    <button
                      onClick={() => handleToggleExpand(card.id)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={expandedId === card.id ? t("common.collapse") : t("common.expand")}
                    >
                      {expandedId === card.id ? (
                        <ChevronDownIcon className="size-4" />
                      ) : (
                        <ChevronRightIcon className="size-4" />
                      )}
                    </button>
                  </td>
                  <td className="p-2 max-w-xs truncate">{card.front}</td>
                  <td className="p-2">{CARD_TYPE_LABELS[card.card_type] ?? card.card_type}</td>
                  <td className="p-2">{card.angle || "-"}</td>
                  <td className="p-2">{formatDate(card.due)}</td>
                  <td className="p-2">{CARD_STATE_LABELS[card.state] ?? card.state}</td>
                  <td className="p-2">{card.reps}</td>
                  <td className="p-2">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleEditClick(card)}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={t("review.edit-card")}
                        title={t("review.edit-card")}
                      >
                        <PencilIcon className="size-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(card.id)}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={t("common.delete")}
                        title={t("common.delete")}
                      >
                        <Trash2Icon className="size-4" />
                      </button>
                    </div>
                  </td>
                </tr>
                {expandedId === card.id && (
                  <tr className="border-t border-border bg-muted/20">
                    <td colSpan={8} className="p-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <div className="text-xs text-muted-foreground mb-1">
                            {t("review.front")}
                          </div>
                          <div className="rounded-md border border-border bg-background p-3">
                            <MemoViewContext.Provider value={STUB_MEMO_VIEW_CONTEXT}>
                              <MemoMarkdownRenderer
                                content={card.front}
                                resolvedMentionUsernames={new Set()}
                              />
                            </MemoViewContext.Provider>
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground mb-1">
                            {t("review.back")}
                          </div>
                          <div className="rounded-md border border-border bg-background p-3">
                            <MemoViewContext.Provider value={STUB_MEMO_VIEW_CONTEXT}>
                              <MemoMarkdownRenderer
                                content={card.back}
                                resolvedMentionUsernames={new Set()}
                              />
                            </MemoViewContext.Provider>
                          </div>
                        </div>
                      </div>
                      {card.card_type === "cloze" && card.cloze_answer && (
                        <div className="mt-3">
                          <div className="text-xs text-muted-foreground mb-1">
                            {t("review.cloze-answer")}
                          </div>
                          <div className="text-sm font-medium">{card.cloze_answer}</div>
                        </div>
                      )}
                      <div className="mt-3 flex justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEditClick(card)}
                        >
                          <PencilIcon className="size-3.5 mr-1" />
                          {t("review.edit-card")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <CardEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        card={editingCard}
        onSaved={handleSaved}
        onSave={update}
        saving={saving}
      />
    </>
  );
};

export default CardTable;
