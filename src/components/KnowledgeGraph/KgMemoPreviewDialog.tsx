import { useNavigate } from "react-router-dom";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MemoMarkdownRenderer } from "@/components/MemoContent/MemoMarkdownRenderer";
import { MemoViewContext } from "@/components/MemoView/MemoViewContext";
import { STUB_MEMO_VIEW_CONTEXT } from "@/components/MemoPreview/MemoPreview";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";
import { useTranslate } from "@/utils/i18n";

interface Props {
  memo: Memo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function KgMemoPreviewDialog({ memo, open, onOpenChange }: Props) {
  const t = useTranslate() as (key: string, params?: Record<string, unknown>) => string;
  const navigate = useNavigate();

  if (!memo) return null;

  const memoUid = memo.name?.split("/").pop();
  // 后端返回 created_ts（秒级数字），优先使用；否则回退到 proto createTime
  const rawTs = (memo as unknown as { created_ts?: number }).created_ts;
  const date = rawTs
    ? new Date(rawTs * 1000).toLocaleString()
    : memo.createTime
      ? new Date(Number(memo.createTime.seconds) * 1000).toLocaleString()
      : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2 pr-8">
            <span className="text-sm text-muted-foreground">{date}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate(`/memos/${memoUid}`)}
            >
              <ExternalLinkIcon className="mr-1.5 h-3.5 w-3.5" />
              {t("kg.open-memo-detail")}
            </Button>
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto">
          {memo.content ? (
            <MemoViewContext.Provider value={STUB_MEMO_VIEW_CONTEXT}>
              <MemoMarkdownRenderer
                content={memo.content}
                resolvedMentionUsernames={new Set()}
                memoName={memo.name}
              />
            </MemoViewContext.Provider>
          ) : (
            <div className="text-sm text-muted-foreground">{t("memo.untitled")}</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
