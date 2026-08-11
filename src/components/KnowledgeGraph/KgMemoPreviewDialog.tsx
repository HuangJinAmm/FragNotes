import { useNavigate } from "react-router-dom";
import { ExternalLinkIcon } from "lucide-react";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

  const memoUid = memo.name.split("/").pop();
  const date = memo.createTime ? timestampDate(memo.createTime).toLocaleString() : "";

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
          <div className="whitespace-pre-wrap break-words text-sm text-foreground">
            {memo.content || t("memo.untitled")}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
