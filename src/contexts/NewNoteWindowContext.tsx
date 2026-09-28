import { listen } from "@tauri-apps/api/event";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Routes } from "@/router";

/**
 * 后端唤起记笔记窗口的事件名（系统托盘菜单「记笔记」）。
 * 必须与 src-tauri/src/tray.rs 中的 EVENT_OPEN_NEW_NOTE 保持一致。
 */
export const OPEN_NEW_NOTE_EVENT = "open-new-memo";

/**
 * 唤起记笔记窗口的快捷键：Alt+W。
 * 按物理键位（event.code）判断：macOS 上 Option+W 会产出特殊字符，
 * 用 event.key 匹配会失效。
 */
const OPEN_NEW_NOTE_SHORTCUT_CODE = "KeyW";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface NewNoteWindowContextValue {
  /** 记笔记窗口是否打开（首页据此按需挂载聚焦模式编辑器） */
  isOpen: boolean;
  /** 打开记笔记窗口；非首页时先切回首页 */
  open: () => void;
  close: () => void;
}

// 默认 no-op：让未包裹 Provider 的渲染（测试、独立预览）不报错。
const NewNoteWindowContext = createContext<NewNoteWindowContextValue>({
  isOpen: false,
  open: () => {},
  close: () => {},
});

/**
 * 记笔记窗口的全局开关：系统托盘菜单「记笔记」事件与 Alt+W 快捷键共用同一入口。
 * 窗口本体渲染在首页（Home），因此从其他页面唤起时会先切回首页。
 */
export function NewNoteWindowProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);

  // 用 ref 读取最新路由：避免路由每次变化都重建事件/键盘监听。
  const pathnameRef = useRef(location.pathname);
  useEffect(() => {
    pathnameRef.current = location.pathname;
  }, [location.pathname]);

  const open = useCallback(() => {
    const pathname = pathnameRef.current;
    if (pathname !== Routes.HOME) {
      // 工作空间选择页是首次启动的引导流程（此时没有可写入的工作空间），不打断它。
      if (pathname === Routes.WORKSPACE_PICKER) {
        return;
      }
      navigate(Routes.HOME);
    }
    setIsOpen(true);
  }, [navigate]);

  const close = useCallback(() => setIsOpen(false), []);

  // 系统托盘「记笔记」：Rust 侧已先显示窗口，这里只负责打开记笔记窗口。
  useEffect(() => {
    if (!isTauri) return;
    const unlistenPromise = listen(OPEN_NEW_NOTE_EVENT, () => open());
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [open]);

  // Alt+W 快捷键（应用窗口聚焦时生效）
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.code !== OPEN_NEW_NOTE_SHORTCUT_CODE) return;
      event.preventDefault();
      open();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  const value = useMemo(() => ({ isOpen, open, close }), [isOpen, open, close]);

  return <NewNoteWindowContext.Provider value={value}>{children}</NewNoteWindowContext.Provider>;
}

export function useNewNoteWindow() {
  return useContext(NewNoteWindowContext);
}
