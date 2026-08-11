import { useNavigate } from "react-router-dom";
import { useKgNodeMemos } from "@/hooks/useKgQueries";
import { useTranslate } from "@/utils/i18n";
import { timestampDate } from "@bufbuild/protobuf/wkt";

interface Props {
  nodeId: number;
}

export default function KgMemoListPanel({ nodeId }: Props) {
  const t = useTranslate() as (key: string, params?: Record<string, unknown>) => string;
  const navigate = useNavigate();
  const { data: memos = [], isLoading } = useKgNodeMemos(nodeId);

  if (isLoading) {
    return <div className="text-xs text-muted-foreground">加载中...</div>;
  }

  if (memos.length === 0) {
    return <div className="text-xs text-muted-foreground">{t("kg.no-related-memos")}</div>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      {memos.map((memo) => (
        <button
          key={memo.name}
          type="button"
          onClick={() => memo.name && navigate(`/memos/${memo.name.split("/").pop()}`)}
          className="rounded-md border border-border bg-muted/20 p-2 text-left transition-colors hover:bg-muted/40"
        >
          <p className="line-clamp-2 text-xs text-foreground">{memo.content || t("memo.untitled")}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {memo.createTime ? timestampDate(memo.createTime).toLocaleDateString() : ""}
          </p>
        </button>
      ))}
    </div>
  );
}
