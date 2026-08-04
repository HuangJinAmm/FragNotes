import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { memoKeys } from "@/hooks/useMemoQueries";
import { userKeys } from "@/hooks/useUserQueries";
import {
  appendMessage as persistAppendMessage,
  clearMessages as persistClearMessages,
  createSession,
  generateDefaultTitle,
  listMessages,
  recordToMessage,
} from "./chatSessionService";
import type {
  ChatMessage,
  ContentPart,
  ToolPayload,
  WireMessage,
} from "./types";

/// 保留的最近"对话轮次"数（user/assistant 文本消息），工具消息不计入此限制
const MAX_TURNS_TO_SEND = 20;

interface UseAiChatOptions {
  providerId: string | null;
}

type QueryClient = ReturnType<typeof useQueryClient>;

/// AI 工具执行后失效相关 React Query 缓存，使笔记列表/详情/统计等界面同步刷新。
/// AI 工具直接操作后端数据库，绕过了 React Query mutation，因此需要手动失效。
function invalidateQueriesForTool(queryClient: QueryClient, toolName: string, result: unknown) {
  switch (toolName) {
    case "create_memo": {
      queryClient.invalidateQueries({ queryKey: memoKeys.lists() });
      queryClient.invalidateQueries({ queryKey: userKeys.stats() });
      break;
    }
    case "update_memo": {
      const uid = (result as { uid?: string } | null)?.uid;
      if (uid) {
        queryClient.invalidateQueries({ queryKey: memoKeys.detail(`memos/${uid}`) });
      }
      queryClient.invalidateQueries({ queryKey: memoKeys.lists() });
      queryClient.invalidateQueries({ queryKey: userKeys.stats() });
      break;
    }
    case "link_memos": {
      const r = result as { from_uid?: string; to_uid?: string } | null;
      if (r?.from_uid) {
        queryClient.invalidateQueries({ queryKey: memoKeys.detail(`memos/${r.from_uid}`) });
      }
      if (r?.to_uid) {
        queryClient.invalidateQueries({ queryKey: memoKeys.detail(`memos/${r.to_uid}`) });
      }
      queryClient.invalidateQueries({ queryKey: memoKeys.lists() });
      break;
    }
    case "load_skill":
      // skill 加载不修改 memo 数据，无需失效缓存
      break;
    default:
      // 用户工具：不直接修改 memo 数据（与 load_skill 同样 no-op）
      // 内置工具名之外的工具调用都走这里
      break;
  }
}

export function useAiChat({ providerId }: UseAiChatOptions) {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentSessionId, setCurrentSessionIdState] = useState<number | null>(null);
  /// ref 同步镜像 currentSessionId，供 useCallback 闭包读取最新值
  const sessionIdRef = useRef<number | null>(null);
  const setCurrentSessionId = useCallback((id: number | null) => {
    sessionIdRef.current = id;
    setCurrentSessionIdState(id);
  }, []);
  const currentRunId = useRef<number | null>(null);
  /// 当前轮次中已发起工具调用的 assistant 消息 id。
  /// 非 null 表示正在处理同一轮次的工具调用：后续 ai:tool 应追加到同一条 assistant，
  /// 而不是再次拆分出新的 tool_calls assistant。
  const toolCallAssistantId = useRef<string | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  /// 待持久化的消息队列：避免流式过程中频繁写库
  /// 流式完成后一次性落库 assistant 最终内容
  const pendingUserMsgRef = useRef<ChatMessage | null>(null);
  const pendingAssistantMsgRef = useRef<ChatMessage | null>(null);

  // 设置事件监听
  useEffect(() => {
    let mounted = true;
    const unlisteners: UnlistenFn[] = [];

    const setup = async () => {
      unlisteners.push(
        await listen<{ run_id: number; text: string }>("ai:chunk", (e) => {
          if (e.payload.run_id !== currentRunId.current) return;
          setMessages((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i].role === "assistant" && next[i].streaming) {
                next[i] = { ...next[i], content: next[i].content + e.payload.text };
                break;
              }
            }
            return next;
          });
        }),
      );

      unlisteners.push(
        await listen<ToolPayload>("ai:tool", (e) => {
          if (e.payload.run_id !== currentRunId.current) return;
          const { name, args, tool_call_id, result } = e.payload;
          setMessages((prev) => {
            const next = [...prev];
            if (toolCallAssistantId.current === null) {
              // 本轮首个工具调用：把当前正在流式输出的 assistant 标记为 tool_calls 发起者
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].role === "assistant" && next[i].streaming) {
                  next[i] = {
                    ...next[i],
                    streaming: false,
                    toolCalls: [{ id: tool_call_id, name, args }],
                  };
                  toolCallAssistantId.current = next[i].id;
                  // 落库该 assistant（已经定稿，content 可能非空）
                  void persistCurrent(next[i]);
                  break;
                }
              }
            } else {
              // 同一轮次的后续工具调用：追加到已有的 tool_calls assistant
              const idx = next.findIndex((m) => m.id === toolCallAssistantId.current);
              if (idx >= 0) {
                const prevCalls = next[idx].toolCalls ?? [];
                next[idx] = {
                  ...next[idx],
                  toolCalls: [...prevCalls, { id: tool_call_id, name, args }],
                };
                // 更新已落库的 assistant 记录（追加 tool_calls）
                void persistCurrent(next[idx], true);
              }
            }
            // 添加 tool 消息（携带结果用于下次请求回传）
            const toolMsg: ChatMessage = {
              id: crypto.randomUUID(),
              role: "tool",
              content: `🔧 ${name}(${JSON.stringify(args)})`,
              isToolCall: true,
              toolCallId: tool_call_id,
              toolResult: result,
              toolName: name,
              toolArgs: args,
            };
            // 插入位置：保持 tool_calls → tool* → assistant(streaming) 的顺序。
            // 同一轮次后续 tool_call 到达时,末尾已有流式 assistant,
            // 直接 push 会把 tool 消息插到 assistant 之后,破坏配对连续性,
            // 导致 OpenAI 报 "insufficient tool messages following tool_calls message"。
            // 因此插入到末尾流式 assistant 之前；若无流式 assistant 则直接 push。
            const lastIdx = next.length - 1;
            const lastMsg = next[lastIdx];
            if (lastMsg && lastMsg.role === "assistant" && lastMsg.streaming) {
              next.splice(lastIdx, 0, toolMsg);
            } else {
              next.push(toolMsg);
            }
            // 落库 tool 消息
            void persistCurrent(toolMsg);
            // 确保末尾有一个流式 assistant 用于接收下一轮的文本
            const last = next[next.length - 1];
            if (!last || last.role !== "assistant" || !last.streaming) {
              const newAssistant: ChatMessage = {
                id: crypto.randomUUID(),
                role: "assistant",
                content: "",
                streaming: true,
              };
              next.push(newAssistant);
              pendingAssistantMsgRef.current = newAssistant;
            }
            return next;
          });
          // 工具执行已修改后端数据，按工具类型失效相关 React Query 缓存以刷新界面
          invalidateQueriesForTool(queryClient, name, result);
        }),
      );

      unlisteners.push(
        await listen<{ run_id: number }>("ai:done", (e) => {
          if (e.payload.run_id !== currentRunId.current) return;
          setMessages((prev) => {
            const next = prev
              .map((m, i) =>
                i === prev.length - 1 && m.role === "assistant"
                  ? { ...m, streaming: false }
                  : m,
              )
              // 丢弃末尾残留的空流式 assistant（工具调用后未产生文本）
              .filter((m, i, arr) => {
                if (i !== arr.length - 1) return true;
                return !(
                  m.role === "assistant" &&
                  !m.streaming &&
                  !m.isError &&
                  (typeof m.content !== "string" || m.content === "") &&
                  !m.toolCalls
                );
              });
            // 落库最终的 assistant 消息
            const finalAssistant = next[next.length - 1];
            if (finalAssistant && finalAssistant.role === "assistant") {
              void persistCurrent(finalAssistant, true);
            }
            return next;
          });
          setIsStreaming(false);
          currentRunId.current = null;
          toolCallAssistantId.current = null;
          pendingUserMsgRef.current = null;
          // 注意：不在此处清除 pendingAssistantMsgRef。
          // setMessages 的 updater 在 React 渲染时才执行（automatic batching），
          // 此处同步清除会导致 updater 中的 persistCurrent 条件不成立，assistant 消息不落库。
          // pendingAssistantMsgRef 由 persistCurrent 内部在落库成功后清除。
        }),
      );

      unlisteners.push(
        await listen<{ run_id: number; message: string }>("ai:error", (e) => {
          if (e.payload.run_id !== currentRunId.current) return;
          toast.error(e.payload.message);
          setMessages((prev) =>
            prev.map((m, i) => {
              if (i === prev.length - 1 && m.role === "assistant") {
                const updated = { ...m, streaming: false, isError: true };
                void persistCurrent(updated, true);
                return updated;
              }
              return m;
            }),
          );
          setIsStreaming(false);
          currentRunId.current = null;
          toolCallAssistantId.current = null;
          pendingUserMsgRef.current = null;
          // 同上：不在此处清除 pendingAssistantMsgRef，由 persistCurrent 内部处理。
        }),
      );

      if (mounted) {
        unlistenersRef.current = unlisteners;
      } else {
        unlisteners.forEach((fn) => fn());
      }
    };

    setup();

    return () => {
      mounted = false;
      unlistenersRef.current.forEach((fn) => fn());
      unlistenersRef.current = [];
    };
  }, [queryClient]);

  /// 把一条消息追加到当前 session 落库。
  /// 若 forceUpdate=true，则尝试更新已落库的同 id 消息（用于流式 assistant 增量更新）。
  /// 由于 ChatMessage 用前端 UUID，与后端 id 不直接对应，这里简化为：
  /// - assistant 流式消息：流式过程中不落库，完成时一次性追加
  /// - 其他消息：直接 append
  const persistCurrent = useCallback(
    async (msg: ChatMessage, isFinalAssistant: boolean = false) => {
      const sid = sessionIdRef.current;
      if (sid === null) return;
      try {
        if (isFinalAssistant && pendingAssistantMsgRef.current?.id === msg.id) {
          // 流式 assistant 已定稿：追加最终内容
          await persistAppendMessage(sid, msg);
          // await 期间 ref 可能已被其他事件（如 ai:tool 创建新 assistant）修改，
          // 仅在 ref 仍指向当前消息时才清除，避免覆盖新值导致后续落库失败
          if (pendingAssistantMsgRef.current?.id === msg.id) {
            pendingAssistantMsgRef.current = null;
          }
        } else if (msg.role === "user") {
          await persistAppendMessage(sid, msg);
        } else if (msg.role === "tool") {
          await persistAppendMessage(sid, msg);
        } else if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
          // 带 tool_calls 的 assistant：仅在首次出现时追加，后续更新靠 tool 消息独立记录
          if (pendingAssistantMsgRef.current?.id === msg.id) {
            await persistAppendMessage(sid, msg);
            // 同上：防止 await 期间 ref 被修改
            if (pendingAssistantMsgRef.current?.id === msg.id) {
              pendingAssistantMsgRef.current = null;
            }
          }
        }
      } catch (e) {
        // 落库失败不阻塞前端展示，仅 console
        console.error("persist message failed:", e);
      }
    },
    [],
  );

  /// 将前端 ChatMessage[] 构造为符合 OpenAI 工具调用协议的 WireMessage[]：
  /// assistant(tool_calls) → tool(result) → tool(result) → assistant(text) 的顺序保留，
  /// 保证 assistant 中每个 tool_call_id 都有对应的 tool 消息响应。
  const buildWireMessages = useCallback((src: ChatMessage[]): WireMessage[] => {
    const result: WireMessage[] = [];
    /// 跟踪已发送的 assistant(tool_calls) 中尚未被 tool 消息响应的 tool_call_id。
    /// 用于：
    /// 1) 判断 tool 消息是否对应前面已发送的 tool_calls（孤立 tool 消息需跳过）
    /// 2) 多个 tool_calls 时,后续 tool 消息不会因 prev 不是 assistant 而被误判为孤立
    const pendingToolCallIds = new Set<string>();
    for (const m of src) {
      if (m.role === "tool") {
        // 仅当对应 tool_call_id 来自前面已发送的 assistant(tool_calls) 时才保留
        if (!m.toolCallId || !pendingToolCallIds.has(m.toolCallId)) {
          continue;
        }
        pendingToolCallIds.delete(m.toolCallId);
        result.push({
          role: "tool",
          content: JSON.stringify(m.toolResult ?? ""),
          tool_call_id: m.toolCallId,
        });
      } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        // 发起工具调用的 assistant：输出 tool_calls，content 留空
        // 把所有 tool_call_id 加入待响应集合，等待后续 tool 消息逐个响应
        for (const tc of m.toolCalls) {
          if (tc.id) pendingToolCallIds.add(tc.id);
        }
        result.push({
          role: "assistant",
          content: typeof m.content === "string" ? m.content : "",
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args ?? {}),
            },
          })),
        });
      } else {
        result.push({
          role: m.role,
          content: m.content,
        });
      }
    }
    return result;
  }, []);

  /// 切换到指定会话：加载历史消息
  const switchToSession = useCallback(async (sessionId: number | null) => {
    if (isStreaming) return;
    if (sessionId === null) {
      setCurrentSessionId(null);
      setMessages([]);
      return;
    }
    try {
      const records = await listMessages(sessionId);
      const restored = records.map(recordToMessage);
      setCurrentSessionId(sessionId);
      setMessages(restored);
    } catch (e) {
      toast.error(String(e));
    }
  }, [isStreaming]);

  /// 新建会话：如果当前 session 无消息则复用，否则创建新会话
  const newChat = useCallback(async (): Promise<number | null> => {
    if (isStreaming) return null;
    // 当前会话为空，直接复用
    if (sessionIdRef.current !== null && messages.length === 0) {
      return sessionIdRef.current;
    }
    try {
      const session = await createSession(generateDefaultTitle(), providerId);
      setCurrentSessionId(session.id);
      setMessages([]);
      return session.id;
    } catch (e) {
      toast.error(String(e));
      return null;
    }
  }, [isStreaming, messages.length, providerId]);

  const send = useCallback(
    async (content: string | ContentPart[]) => {
      if (!providerId) {
        toast.error("请先选择 Provider");
        return;
      }
      if (isStreaming) return;

      // 确保有 session：首次发送自动创建
      let sid = sessionIdRef.current;
      if (sid === null) {
        try {
          const session = await createSession(generateDefaultTitle(), providerId);
          sid = session.id;
          setCurrentSessionId(session.id);
        } catch (e) {
          toast.error(String(e));
          return;
        }
      }

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content,
      };
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        streaming: true,
      };
      pendingUserMsgRef.current = userMsg;
      pendingAssistantMsgRef.current = assistantMsg;

      // 保留最近 MAX_TURNS_TO_SEND 轮文本对话（不计 tool 消息），再构造为 OpenAI 格式
      const withUser = [...messages, userMsg];
      let nonToolCount = 0;
      let startIdx = 0;
      for (let i = withUser.length - 1; i >= 0; i--) {
        if (withUser[i].role !== "tool") {
          nonToolCount++;
          if (nonToolCount > MAX_TURNS_TO_SEND) {
            startIdx = i + 1;
            break;
          }
        }
      }
      // 避免从孤立的 tool 消息开始（会破坏 OpenAI tool_calls → tool 的配对）
      while (startIdx < withUser.length && withUser[startIdx].role === "tool") {
        startIdx++;
      }
      const wireMessages = buildWireMessages(withUser.slice(startIdx));

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);
      toolCallAssistantId.current = null;

      // 落库 user 消息
      void persistAppendMessage(sid!, userMsg).catch((e) =>
        console.error("persist user msg failed:", e),
      );

      try {
        const runId = await invoke<number>("ai_chat", {
          providerId,
          messages: wireMessages,
        });
        currentRunId.current = runId;
      } catch (e) {
        toast.error(String(e));
        setMessages((prev) =>
          prev.map((m, i) => {
            if (i === prev.length - 1 && m.role === "assistant") {
              const updated = { ...m, streaming: false, isError: true };
              void persistAppendMessage(sid!, updated).catch(console.error);
              return updated;
            }
            return m;
          }),
        );
        setIsStreaming(false);
      }
    },
    [providerId, isStreaming, messages, buildWireMessages],
  );

  const abort = useCallback(async () => {
    if (currentRunId.current !== null) {
      await invoke("ai_abort", { runId: currentRunId.current });
      currentRunId.current = null;
      toolCallAssistantId.current = null;
      setIsStreaming(false);
      setMessages((prev) =>
        prev.map((m, i) => {
          if (i === prev.length - 1 && m.role === "assistant" && m.streaming) {
            const updated = {
              ...m,
              streaming: false,
              content: (typeof m.content === "string" ? m.content : "") + " [已中断]",
            };
            // 落库中断后的 assistant
            const sid = sessionIdRef.current;
            if (sid !== null) {
              void persistAppendMessage(sid, updated).catch(console.error);
            }
            return updated;
          }
          return m;
        }),
      );
    }
  }, []);

  const clear = useCallback(async () => {
    if (isStreaming) return;
    // 清空当前 session 的消息（若已有 session）
    const sid = sessionIdRef.current;
    if (sid !== null) {
      try {
        await persistClearMessages(sid);
      } catch (e) {
        console.error("clear messages failed:", e);
      }
    }
    setMessages([]);
    toolCallAssistantId.current = null;
    // 不创建新 session，让下次 send 时按需创建
    setCurrentSessionId(null);
  }, [isStreaming]);

  return {
    messages,
    isStreaming,
    currentSessionId,
    send,
    abort,
    clear,
    switchToSession,
    newChat,
  };
}
