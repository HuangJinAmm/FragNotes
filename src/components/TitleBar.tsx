import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeftIcon, ArrowRightIcon, CopyIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { useInstance } from "@/contexts/InstanceContext";
import { cn } from "@/lib/utils";
import { useTranslate } from "@/utils/i18n";

// 仅在 Tauri 桌面环境显示窗口控制按钮（浏览器 / Android 不显示）
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const isAndroid = typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
const isTauriDesktop = isTauri && !isAndroid;
const appWindow = isTauriDesktop ? getCurrentWindow() : null;

interface Props {
  className?: string;
}

const TitleBar = (props: Props) => {
  const t = useTranslate();
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const { generalSetting: instanceGeneralSetting } = useInstance();

  const title = instanceGeneralSetting.customProfile?.title || "破碎星球";
  const logoUrl = instanceGeneralSetting.customProfile?.logoUrl || "/logo2.png";

  // 跟踪窗口最大化状态，切换最大化/还原图标
  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    if (!appWindow) return;
    let unlisten: (() => void) | undefined;
    const update = () => {
      appWindow.isMaximized().then(setIsMaximized).catch(() => {});
    };
    update();
    appWindow
      .onResized(update)
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  // 维护导航历史栈，驱动上一页/下一页按钮的可用状态
  const historyRef = useRef<{ stack: string[]; index: number }>({ stack: [], index: -1 });
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  useEffect(() => {
    const current = `${location.pathname}${location.search}`;
    const history = historyRef.current;
    if (history.index === -1) {
      // 初始化
      history.stack = [current];
      history.index = 0;
    } else if (navigationType === "REPLACE") {
      history.stack[history.index] = current;
    } else if (history.index > 0 && history.stack[history.index - 1] === current) {
      // 后退
      history.index -= 1;
    } else if (history.index < history.stack.length - 1 && history.stack[history.index + 1] === current) {
      // 前进
      history.index += 1;
    } else if (history.stack[history.index] !== current) {
      // 新的导航记录
      history.stack = [...history.stack.slice(0, history.index + 1), current];
      history.index = history.stack.length - 1;
    }
    setCanGoBack(history.index > 0);
    setCanGoForward(history.index < history.stack.length - 1);
  }, [location, navigationType]);

  const navButtonClass =
    "w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent transition-colors";

  return (
    <header
      data-tauri-drag-region="deep"
      className={cn(
        "fixed top-0 left-0 right-0 z-[100] h-10 flex flex-row justify-between items-stretch select-none",
        "border-b border-border bg-background",
        props.className,
      )}
    >
      {/* 左侧：应用 logo、名称与上一页/下一页导航按钮 */}
      <div className="flex flex-row justify-start items-center gap-1 pl-3 pr-2 min-w-0 shrink-0">
        <img src={logoUrl} alt="" draggable={false} className="size-5 shrink-0 rounded" />
        <span className="text-sm font-medium text-foreground truncate mr-1">{title}</span>
        <div className="flex flex-row items-center gap-0.5">
          <button
            type="button"
            disabled={!canGoBack}
            onClick={() => navigate(-1)}
            aria-label={t("titlebar.go-back")}
            title={t("titlebar.go-back")}
            className={navButtonClass}
          >
            <ArrowLeftIcon className="size-4" />
          </button>
          <button
            type="button"
            disabled={!canGoForward}
            onClick={() => navigate(1)}
            aria-label={t("titlebar.go-forward")}
            title={t("titlebar.go-forward")}
            className={navButtonClass}
          >
            <ArrowRightIcon className="size-4" />
          </button>
        </div>
      </div>

      {/* 右侧：窗口控制按钮 */}
      {isTauriDesktop && (
        <div className="flex flex-row items-stretch shrink-0">
          <button
            type="button"
            onClick={() => appWindow?.minimize().catch(() => {})}
            aria-label={t("titlebar.minimize")}
            title={t("titlebar.minimize")}
            className="w-11 h-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <MinusIcon className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => appWindow?.toggleMaximize().catch(() => {})}
            aria-label={isMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
            title={isMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
            className="w-11 h-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            {isMaximized ? <CopyIcon className="size-3.5" /> : <SquareIcon className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => appWindow?.close().catch(() => {})}
            aria-label={t("titlebar.close")}
            title={t("titlebar.close")}
            className="w-11 h-full flex items-center justify-center text-muted-foreground hover:text-white hover:bg-destructive transition-colors"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      )}
    </header>
  );
};

export default TitleBar;
