import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { SearchHighlightProvider } from "./components/MemoContent/SearchHighlightContext";
import { useInstance } from "./contexts/InstanceContext";
import { MemoFilterProvider } from "./contexts/MemoFilterContext";
import { useUserLocale } from "./hooks/useUserLocale";
import { useUserTheme } from "./hooks/useUserTheme";
import ToolConfirmDialog from "@/components/AiChat/ToolConfirmDialog";
import { Routes } from "@/router";

const App = () => {
  const { generalSetting: instanceGeneralSetting } = useInstance();
  const navigate = useNavigate();

  // 响应式应用用户偏好
  useUserLocale();
  useUserTheme();

  // 注入实例自定义样式（本地为空，不会执行）
  useEffect(() => {
    if (instanceGeneralSetting.additionalStyle) {
      const styleEl = document.createElement("style");
      styleEl.innerHTML = instanceGeneralSetting.additionalStyle;
      styleEl.setAttribute("type", "text/css");
      document.body.insertAdjacentElement("beforeend", styleEl);
    }
  }, [instanceGeneralSetting.additionalStyle]);

  // 注入实例自定义脚本（本地为空，不会执行）
  useEffect(() => {
    if (instanceGeneralSetting.additionalScript) {
      const scriptEl = document.createElement("script");
      scriptEl.innerHTML = instanceGeneralSetting.additionalScript;
      document.head.appendChild(scriptEl);
    }
  }, [instanceGeneralSetting.additionalScript]);

  // 动态更新元数据（本地为空，不会执行）
  useEffect(() => {
    if (!instanceGeneralSetting.customProfile) {
      return;
    }

    document.title = instanceGeneralSetting.customProfile.title;
    const link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
    link.href = instanceGeneralSetting.customProfile.logoUrl || "/logo2.png";
  }, [instanceGeneralSetting.customProfile]);

  // 监听后端 show_workspace_picker 事件，导航到工作空间选择页
  useEffect(() => {
    const unlistenPromise = listen("show_workspace_picker", () => {
      navigate(Routes.WORKSPACE_PICKER);
    });
    return () => {
      void unlistenPromise.then((fn) => fn());
    };
  }, [navigate]);

  return (
    <MemoFilterProvider>
      <SearchHighlightProvider>
        <Outlet />
      </SearchHighlightProvider>
      <ToolConfirmDialog />
    </MemoFilterProvider>
  );
};

export default App;
