import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { isEqual } from "lodash-es";
import { CheckCircleIcon, ChevronRightIcon, Code2Icon, HashIcon, ImageIcon, Link2Icon, LinkIcon, type LucideIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { KgNodePicker } from "@/components/KnowledgeGraph";
import { Button } from "@/components/ui/button";
import { useLinkMemoToNode, useMemoKgNodes } from "@/hooks/useKgQueries";
import { cn } from "@/lib/utils";
import { Memo, Memo_PropertySchema } from "@/types/proto/api/v1/memo_service_pb";
import { type Translations, useTranslate } from "@/utils/i18n";
import { extractHeadings } from "@/utils/markdown-manipulation";
import MemoOutline from "./MemoOutline";

interface Props {
  memo: Memo;
  className?: string;
  onShareImageOpen?: () => void;
}

interface PropertyBadge {
  icon: LucideIcon;
  labelKey: Translations;
}

const SidebarSection = ({ label, count, children }: { label: string; count?: number; children: React.ReactNode }) => (
  <div className="w-full space-y-2">
    <div className="flex items-center gap-1.5">
      <p className="text-xs font-medium text-muted-foreground/50 uppercase tracking-wider">{label}</p>
      {count != null && <span className="text-xs text-muted-foreground/30">({count})</span>}
    </div>
    {children}
  </div>
);

const PROPERTY_BADGE_CLASSES =
  "inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border/60 bg-muted/60 text-xs text-muted-foreground";

const TAG_BADGE_CLASSES =
  "inline-flex items-center gap-1 px-1 rounded-md border border-border/60 bg-muted/60 text-sm text-muted-foreground hover:bg-muted hover:text-foreground/80 transition-colors cursor-pointer";

const SHARE_ACTION_ROW_CLASSES =
  "h-auto min-h-0 w-full justify-between rounded-none px-2 py-1.5 text-xs font-normal leading-tight text-muted-foreground transition-colors hover:bg-muted/40 hover:text-muted-foreground focus-visible:ring-offset-0 gap-1.5";

const MemoDetailSidebar = ({ memo, className, onShareImageOpen }: Props) => {
  const t = useTranslate();
  const property = create(Memo_PropertySchema, memo.property || {});
  const hasUpdated = !isEqual(memo.createTime, memo.updateTime);
  const headings = useMemo(() => extractHeadings(memo.content), [memo.content]);

  const navigate = useNavigate();
  const memoUid = memo.name.split("/").pop() ?? "";
  const { data: kgNodes = [] } = useMemoKgNodes(memoUid);
  const linkMemo = useLinkMemoToNode();
  const [pickerOpen, setPickerOpen] = useState(false);

  const propertyBadges = useMemo(() => {
    const badges: PropertyBadge[] = [];
    if (property.hasLink) badges.push({ icon: LinkIcon, labelKey: "memo.links" });
    if (property.hasTaskList) badges.push({ icon: CheckCircleIcon, labelKey: "memo.to-do" });
    if (property.hasCode) badges.push({ icon: Code2Icon, labelKey: "memo.code" });
    return badges;
  }, [property.hasLink, property.hasTaskList, property.hasCode]);

  return (
    <aside className={cn("relative w-full h-auto max-h-screen overflow-auto flex flex-col gap-5", className)}>
      {headings.length > 0 && (
        <SidebarSection label={t("memo.outline")}>
          <MemoOutline headings={headings} />
        </SidebarSection>
      )}

      {onShareImageOpen && (
        <SidebarSection label={t("memo.share.section-label")}>
          <div className="overflow-hidden rounded-md border border-border/50 bg-muted/20">
            <Button variant="ghost" size="sm" className={SHARE_ACTION_ROW_CLASSES} onClick={onShareImageOpen}>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <ImageIcon className="size-3.5 shrink-0 text-muted-foreground/90" />
                <span className="truncate">{t("memo.share.open-image")}</span>
              </span>
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/35" />
            </Button>
          </div>
        </SidebarSection>
      )}

      <SidebarSection label={t("common.created-at")}>
        <div className="flex flex-col gap-1">
          <p className="text-sm text-foreground/70">{memo.createTime ? timestampDate(memo.createTime).toLocaleString() : "—"}</p>
          {hasUpdated && (
            <p className="text-xs text-muted-foreground">
              {t("common.last-updated-at")}: {memo.updateTime ? timestampDate(memo.updateTime).toLocaleString() : "—"}
            </p>
          )}
        </div>
      </SidebarSection>

      {propertyBadges.length > 0 && (
        <SidebarSection label={t("common.properties")}>
          <div className="flex flex-wrap gap-1.5">
            {propertyBadges.map(({ icon: Icon, labelKey }) => (
              <span key={labelKey} className={PROPERTY_BADGE_CLASSES}>
                <Icon className="w-3.5 h-3.5" />
                {t(labelKey)}
              </span>
            ))}
          </div>
        </SidebarSection>
      )}

      {memo.tags.length > 0 && (
        <SidebarSection label={t("common.tags")} count={memo.tags.length}>
          <div className="flex flex-wrap gap-1.5">
            {memo.tags.map((tag) => (
              <span key={tag} className={TAG_BADGE_CLASSES}>
                <HashIcon className="w-3 h-3 opacity-50" />
                {tag}
              </span>
            ))}
          </div>
        </SidebarSection>
      )}

      {kgNodes.length > 0 && (
        <SidebarSection label={t("kg.memo-sidebar-section")} count={kgNodes.length}>
          <div className="flex flex-wrap gap-1.5">
            {kgNodes.map((node) => (
              <button
                key={node.id}
                type="button"
                onClick={() => navigate(`/knowledge-graph?select=${node.id}`)}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-border/60 bg-muted/60 text-sm text-muted-foreground hover:bg-muted hover:text-foreground/80 transition-colors"
              >
                <Link2Icon className="w-3 h-3 opacity-50" />
                {node.name}
              </button>
            ))}
          </div>
        </SidebarSection>
      )}

      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <PlusIcon className="w-3 h-3" />
        {t("kg.memo-sidebar-link")}
      </button>

      <KgNodePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        excludeNodeIds={kgNodes.map((n) => n.id)}
        onPick={(nodeId) => linkMemo.mutate({ memoUid, nodeId })}
      />

    </aside>
  );
};

export default MemoDetailSidebar;
