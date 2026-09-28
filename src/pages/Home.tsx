import { useMemo } from "react";
import { SquarePenIcon } from "lucide-react";
import MemoEditor from "@/components/MemoEditor";
import { deriveDefaultCreateTimeFromFilters } from "@/components/MemoEditor/utils/deriveDefaultCreateTime";
import MemoFilters from "@/components/MemoFilters";
import MemoView from "@/components/MemoView";
import PagedMemoList, { getMemoKey } from "@/components/PagedMemoList";
import { useInstance } from "@/contexts/InstanceContext";
import { type MemoFilter, useMemoFilterContext } from "@/contexts/MemoFilterContext";
import { useNewNoteWindow } from "@/contexts/NewNoteWindowContext";
import { NewMemoProvider } from "@/contexts/NewMemoContext";
import { useMemoFilters, useMemoSorting } from "@/hooks";
import useCurrentUser from "@/hooks/useCurrentUser";
import { cn } from "@/lib/utils";
import { State } from "@/types/proto/api/v1/common_pb";
import { Memo } from "@/types/proto/api/v1/memo_service_pb";
import { useTranslate } from "@/utils/i18n";

const Home = () => {
  const t = useTranslate();
  const user = useCurrentUser();
  const { isInitialized } = useInstance();
  const { filters } = useMemoFilterContext();

  const memoFilter = useMemoFilters({
    creatorName: user?.name,
    includeShortcuts: true,
    includePinned: true,
  });

  const { listSort, orderBy } = useMemoSorting({
    pinnedFirst: true,
    state: State.NORMAL,
  });

  // 编辑器已从页底常驻输入框改为悬浮按钮按需唤起的记笔记窗口,这里仍需根据
  // filters 推导默认创建时间并透传给编辑器(原逻辑在 PagedMemoList 内部)。
  const defaultCreateTime = useMemo(
    () => deriveDefaultCreateTimeFromFilters(filters as MemoFilter[]),
    [filters],
  );

  // 记笔记窗口开关由全局上下文提供:悬浮按钮、Alt+W 快捷键、系统托盘菜单共用同一状态,
  // 关闭时只显示右下角悬浮按钮,打开时挂载编辑器并直接进入聚焦模式。
  const { isOpen: isComposerOpen, open: openComposer, close: closeComposer } = useNewNoteWindow();

  return (
    <NewMemoProvider>
      {/*
        根容器使用视窗高度单位,不依赖父级 min-h-full 链(该链在 MainLayout
        内层 padding 包裹下无法解析为视窗高度,会导致空列表时 flex-1 无空间
        可撑开、底部筛选栏停在中部)。
        扣除 MainLayout 的顶部内边距(pt-2 md:pt-6),使容器底部对齐视窗底部,
        sticky bottom-0 才能正确吸附到视窗底。MainLayout 底部 pb-8 仍保留为
        可滚动余量,sticky 会在滚动时把筛选栏钉在视窗底。
      */}
      <div className="w-full min-h-[calc(100svh-0.5rem)] md:min-h-[calc(100svh-1.5rem)] bg-background text-foreground flex flex-col">
        <div className="flex-1 min-h-0">
          <PagedMemoList
            renderer={(memo: Memo, { compact }) => (
              <MemoView key={getMemoKey(memo)} memo={memo} showVisibility showPinned compact={compact} />
            )}
            listSort={listSort}
            orderBy={orderBy}
            filter={memoFilter}
            enabled={isInitialized}
            // MemoFilters 改由本页面在底部 sticky 筛选栏渲染,避免在此处重复显示。
            showMemoFilters={false}
          />
        </div>
        {/*
          底部筛选栏:关闭筛选条件时整栏不渲染,避免残留一条空边框。
          - bg-background/95 + backdrop-blur:让下方列表内容滚过时半透明可感知
          - border-t:与列表区视觉分隔
          - px-0:外层已在 MainLayout 的 px-4 sm:px-6 内,这里不再叠加横向内边距,
            保持与列表(max-w-2xl mx-auto)水平对齐
        */}
        {filters.length > 0 && (
          <div
            className={cn(
              "sticky bottom-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
              "px-0 pt-2 pb-4 border-t border-border/40",
            )}
          >
            <div className="w-full mx-auto max-w-2xl">
              <MemoFilters />
            </div>
          </div>
        )}

        {/*
          「记笔记」入口:右下角悬浮按钮,替代原先常驻页底的输入框。
          触发方式共三种,均走同一个上下文开关:悬浮按钮、Alt+W 快捷键、
          系统托盘菜单「记笔记」(Rust 侧显示窗口 + emit 事件)。
          - 打开后按需挂载 MemoEditor 并直接以聚焦模式展开为独立记笔记窗口
            (initialFocusMode 直接作为 store 初始状态,无 normal → focus 的跳变)
          - autoFocus:窗口打开即可直接输入
          - 退出聚焦模式(退出按钮/蒙层/插入菜单切换)或保存成功后编辑器 reset
            都会触发 onFocusModeExit,据此卸载编辑器、回落到悬浮按钮
          - onCancel:取消按钮与「未检测到更改」路径同样收起窗口(草稿保留在
            localStorage,下次打开自动恢复)
        */}
        {isComposerOpen ? (
          <MemoEditor
            cacheKey="home-memo-editor"
            placeholder={t("editor.any-thoughts")}
            defaultCreateTime={defaultCreateTime}
            initialFocusMode
            autoFocus
            onFocusModeExit={closeComposer}
            onCancel={closeComposer}
          />
        ) : (
          <button
            type="button"
            onClick={openComposer}
            aria-label={t("editor.new-note")}
            title={`${t("editor.new-note")} (Alt+W)`}
            className={cn(
              "fixed bottom-6 right-6 z-30 flex items-center gap-2 h-12 pl-4 pr-5",
              "rounded-full bg-primary text-primary-foreground shadow-lg shadow-black/15",
              "hover:bg-primary/90 hover:shadow-xl active:scale-95",
              "transition-all duration-200",
            )}
          >
            <SquarePenIcon className="size-5" />
            <span className="text-sm font-medium">{t("editor.new-note")}</span>
          </button>
        )}
      </div>
    </NewMemoProvider>
  );
};

export default Home;
