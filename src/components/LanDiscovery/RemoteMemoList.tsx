import type { FC } from "react";
import { useMemo, useState } from "react";
import { PinIcon, PaperclipIcon, CheckSquareIcon, SquareIcon, XIcon, CopyIcon } from "lucide-react";
import dayjs from "dayjs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { MemoMarkdownRenderer } from "@/components/MemoContent/MemoMarkdownRenderer";
import { MemoViewContext } from "@/components/MemoView/MemoViewContext";
import { STUB_MEMO_VIEW_CONTEXT } from "@/components/MemoPreview/MemoPreview";
import type { PeerInfo, RemoteMemoSummary } from "./types";
import { useRemoteProfile, useRemoteMemos, useRemoteMemoContent } from "./hooks";
import { useTranslate } from "@/utils/i18n";
import toast from "react-hot-toast";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  peer: PeerInfo;
  selectedMemoUid: string | null;
  onSelectMemo: (uid: string) => void;
}

const RemoteMemoList: FC<Props> = ({ peer, selectedMemoUid, onSelectMemo }) => {
  const t = useTranslate();
  const { profile, loading: profileLoading } = useRemoteProfile(peer.peer_id);
  const {
    memos,
    total,
    loading,
    error,
    hasMore,
    loadMore,
    tagFilter,
    setTagFilter,
    retry,
  } = useRemoteMemos(peer.peer_id);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());
  const [batching, setBatching] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });

  const toggleSelect = (uid: string) => {
    setSelectedUids((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) {
        next.delete(uid);
      } else {
        next.add(uid);
      }
      return next;
    });
  };

  const selectAll = () => setSelectedUids(new Set(memos.map((m) => m.uid)));
  const clearSelection = () => setSelectedUids(new Set());

  const exitSelectMode = () => {
    setSelectMode(false);
    clearSelection();
  };

  const handleBatchCopy = async () => {
    const uids = Array.from(selectedUids);
    if (uids.length === 0) return;
    if (!confirm(t("lan.memo.batchCopyConfirm", { count: uids.length }))) return;

    setBatching(true);
    setBatchProgress({ done: 0, total: uids.length });
    let success = 0;
    let failed = 0;

    for (let i = 0; i < uids.length; i++) {
      try {
        await invoke("lan_copy_memo_to_local", {
          req: { peer_id: peer.peer_id, uid: uids[i] },
        });
        success++;
      } catch {
        failed++;
      }
      setBatchProgress({ done: i + 1, total: uids.length });
    }

    setBatching(false);
    if (failed === 0) {
      toast.success(t("lan.memo.batchCopySuccess", { count: success }));
    } else {
      toast.error(t("lan.memo.batchCopyPartial", { success, failed }));
    }
    exitSelectMode();
  };

  const allSelected = useMemo(
    () => memos.length > 0 && selectedUids.size === memos.length,
    [memos, selectedUids],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header: peer 信息 + 选择按钮 */}
      <div className="p-4 border-b">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium text-base truncate">{peer.display_name}</div>
            {profileLoading ? (
              <div className="text-xs text-muted-foreground">…</div>
            ) : profile ? (
              <div className="text-xs text-muted-foreground mt-1">
                {t("lan.peer.publicMemos")}: {profile.public_memo_count} · {profile.tags.join(", ")}
              </div>
            ) : null}
          </div>
          {!selectMode ? (
            <Button variant="outline" size="sm" onClick={() => setSelectMode(true)} disabled={memos.length === 0}>
              <CheckSquareIcon className="size-4" />
              {t("lan.memo.select")}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={exitSelectMode} disabled={batching}>
              <XIcon className="size-4" />
              {t("lan.memo.cancel")}
            </Button>
          )}
        </div>
      </div>

      {/* Tag 筛选 */}
      {profile && profile.tags.length > 0 && (
        <div className="px-4 py-2 border-b flex flex-wrap gap-1">
          <button
            onClick={() => setTagFilter(null)}
            className={`px-2 py-0.5 text-xs rounded-full border ${
              tagFilter === null ? "bg-primary text-primary-foreground" : "bg-background"
            }`}
          >
            All
          </button>
          {profile.tags.map((tag) => (
            <button
              key={tag}
              onClick={() => setTagFilter([tag])}
              className={`px-2 py-0.5 text-xs rounded-full border ${
                tagFilter?.includes(tag) ? "bg-primary text-primary-foreground" : "bg-background"
              }`}
            >
              #{tag}
            </button>
          ))}
        </div>
      )}

      {/* 笔记列表 */}
      <div className="flex-1 overflow-auto p-3 space-y-2">
        {error ? (
          <div className="p-4 text-sm text-destructive">
            {t("lan.memo.loadFailed")}: {error}
            <Button variant="ghost" size="sm" onClick={retry} className="ml-2">
              Retry
            </Button>
          </div>
        ) : loading && memos.length === 0 ? (
          <div className="space-y-2">
            <div className="bg-muted/70 rounded-lg animate-pulse h-28 w-full" />
            <div className="bg-muted/70 rounded-lg animate-pulse h-28 w-full" />
          </div>
        ) : memos.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">{t("lan.discovery.empty")}</div>
        ) : (
          <>
            {selectMode && memos.length > 0 && (
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={allSelected ? clearSelection : selectAll} disabled={batching}>
                  {allSelected ? (
                    <>
                      <SquareIcon className="size-4" />
                      {t("lan.memo.cancel")}
                    </>
                  ) : (
                    <>
                      <CheckSquareIcon className="size-4" />
                      {t("lan.memo.selectAll")}
                    </>
                  )}
                </Button>
              </div>
            )}
            {memos.map((memo) => (
              <MemoCard
                key={memo.uid}
                peerId={peer.peer_id}
                memo={memo}
                isSelected={memo.uid === selectedMemoUid}
                selectMode={selectMode}
                checked={selectedUids.has(memo.uid)}
                onToggleSelect={() => toggleSelect(memo.uid)}
                onClick={() => onSelectMemo(memo.uid)}
                disabled={batching}
              />
            ))}
            {hasMore && (
              <div className="pt-1">
                <Button variant="ghost" size="sm" onClick={loadMore} disabled={loading} className="w-full">
                  {loading ? "…" : "Load more"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 批量操作栏 */}
      {selectMode && (
        <div className="p-3 border-t bg-card flex items-center gap-2">
          <span className="text-sm text-muted-foreground flex-1">
            {batching
              ? t("lan.memo.batchCopyProgress", batchProgress)
              : t("lan.memo.selectedCount", { count: selectedUids.size })}
          </span>
          <Button
            size="sm"
            onClick={handleBatchCopy}
            disabled={batching || selectedUids.size === 0}
          >
            <CopyIcon className="size-4" />
            {batching ? t("lan.memo.batchCopying") : t("lan.memo.batchCopy")}
          </Button>
        </div>
      )}

      {/* Footer 统计（非选择模式） */}
      {!selectMode && (
        <div className="p-2 border-t text-xs text-muted-foreground text-center">
          {memos.length} / {total}
        </div>
      )}
    </div>
  );
};

const MemoCard: FC<{
  peerId: string;
  memo: RemoteMemoSummary;
  isSelected: boolean;
  selectMode: boolean;
  checked: boolean;
  onToggleSelect: () => void;
  onClick: () => void;
  disabled: boolean;
}> = ({ peerId, memo, isSelected, selectMode, checked, onToggleSelect, onClick, disabled }) => {
  const { content, loading } = useRemoteMemoContent(peerId, memo.uid);

  const handleCardClick = () => {
    if (disabled) return;
    if (selectMode) {
      onToggleSelect();
    } else {
      onClick();
    }
  };

  return (
    <div
      onClick={handleCardClick}
      className={`group relative p-3 rounded-lg border bg-card transition-all ${
        disabled ? "opacity-60 pointer-events-none" : "cursor-pointer hover:shadow-sm"
      } ${
        selectMode && checked
          ? "border-primary ring-1 ring-primary/30 bg-accent"
          : isSelected
            ? "border-primary bg-accent"
            : "border-border hover:bg-accent/50"
      }`}
    >
      <div className="flex items-start gap-2">
        {selectMode && (
          <Checkbox
            checked={checked}
            onCheckedChange={onToggleSelect}
            className="mt-1"
            disabled={disabled}
          />
        )}
        {memo.pinned && !selectMode && <PinIcon className="size-4 text-primary shrink-0 mt-0.5" />}
        <div className="flex-1 min-w-0">
          {loading ? (
            <div className="bg-muted/70 rounded animate-pulse h-12 w-full" />
          ) : content ? (
            <div className="text-sm overflow-hidden max-h-32 [&_.prose]:max-w-none [&_.prose]:text-sm">
              <MemoViewContext.Provider value={STUB_MEMO_VIEW_CONTEXT}>
                <MemoMarkdownRenderer content={content} resolvedMentionUsernames={new Set()} compact />
              </MemoViewContext.Provider>
            </div>
          ) : (
            <div className="text-sm line-clamp-3 text-muted-foreground">{memo.snippet}</div>
          )}
          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
            <span>{dayjs.unix(memo.created_ts).format("YYYY-MM-DD")}</span>
            {memo.tags.length > 0 && <span>· {memo.tags.map((t) => `#${t}`).join(" ")}</span>}
            {memo.has_attachments && <PaperclipIcon className="size-3" />}
          </div>
        </div>
      </div>
    </div>
  );
};

export default RemoteMemoList;
