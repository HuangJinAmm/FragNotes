//! AI 聊天面板的模块级控制器
//! 允许外部组件(如 MemoActionMenu)打开 AI 面板并发送预设消息
//! AiChatPanel 在挂载时注册 open/send/switchSession 回调，卸载时注销

import type { ContentPart } from "./types";

let openPanelFn: (() => void) | null = null;
let sendFn: ((content: string | ContentPart[]) => void) | null = null;
let switchSessionFn: ((sessionId: number) => void) | null = null;

/** AiChatPanel 调用：注册打开、发送与切换会话回调，返回注销函数 */
export function registerAiChat(
  open: () => void,
  send: (content: string | ContentPart[]) => void,
  switchSession: (sessionId: number) => void,
): () => void {
  openPanelFn = open;
  sendFn = send;
  switchSessionFn = switchSession;
  return () => {
    openPanelFn = null;
    sendFn = null;
    switchSessionFn = null;
  };
}

/** 外部组件调用：打开 AI 面板并发送预设消息 */
export function openAiChatWithPrompt(content: string | ContentPart[]): void {
  openPanelFn?.();
  // 延迟到下一个 tick，确保面板已展开后再发送
  setTimeout(() => {
    sendFn?.(content);
  }, 0);
}

/** 外部组件调用：打开 AI 面板并切换到指定会话（如从记忆溯源跳转） */
export function openAiChatSession(sessionId: number): void {
  openPanelFn?.();
  // 延迟到下一个 tick，确保面板已展开后再切换
  setTimeout(() => {
    switchSessionFn?.(sessionId);
  }, 0);
}
