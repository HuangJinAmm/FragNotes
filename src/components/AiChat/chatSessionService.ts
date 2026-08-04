import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage, ChatMessageRecord, ChatSession, ContentPart } from "./types";

// ==================== IPC 封装 ====================

export async function listSessions(): Promise<ChatSession[]> {
  return invoke<ChatSession[]>("chat_list_sessions");
}

export async function createSession(
  title: string,
  providerId: string | null,
): Promise<ChatSession> {
  return invoke<ChatSession>("chat_create_session", { title, providerId });
}

export async function renameSession(id: number, title: string): Promise<ChatSession> {
  return invoke<ChatSession>("chat_rename_session", { id, title });
}

export async function deleteSession(id: number): Promise<void> {
  return invoke<void>("chat_delete_session", { id });
}

export async function listMessages(sessionId: number): Promise<ChatMessageRecord[]> {
  return invoke<ChatMessageRecord[]>("chat_list_messages", { sessionId });
}

export async function appendMessage(
  sessionId: number,
  message: ChatMessage,
): Promise<ChatMessageRecord> {
  // content 序列化：string 原样保留；ContentPart[] 转 JSON 字符串
  const contentStr =
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content);

  // tool_calls 序列化
  let toolCallsStr: string | null = null;
  if (message.toolCalls && message.toolCalls.length > 0) {
    toolCallsStr = JSON.stringify(
      message.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        args: tc.args ?? {},
      })),
    );
  }

  // tool_result 序列化
  let toolResultStr: string | null = null;
  if (message.toolResult !== undefined) {
    toolResultStr = JSON.stringify(message.toolResult);
  }

  return invoke<ChatMessageRecord>("chat_append_message", {
    sessionId,
    role: message.role,
    content: contentStr,
    toolCalls: toolCallsStr,
    toolCallId: message.toolCallId ?? null,
    toolResult: toolResultStr,
    isError: message.isError ?? false,
  });
}

export async function clearMessages(sessionId: number): Promise<void> {
  return invoke<void>("chat_clear_messages", { sessionId });
}

// ==================== 序列化反序列化辅助 ====================

/// 将后端返回的 ChatMessageRecord 转换为前端使用的 ChatMessage
export function recordToMessage(rec: ChatMessageRecord): ChatMessage {
  // content 反序列化：尝试 JSON.parse，失败则视为纯字符串
  let content: string | ContentPart[];
  try {
    const parsed = JSON.parse(rec.content);
    if (Array.isArray(parsed)) {
      content = parsed;
    } else if (typeof parsed === "string") {
      content = parsed;
    } else {
      content = rec.content;
    }
  } catch {
    content = rec.content;
  }

  // tool_calls 反序列化
  let toolCalls: ChatMessage["toolCalls"];
  if (rec.tool_calls) {
    try {
      const arr = JSON.parse(rec.tool_calls);
      if (Array.isArray(arr)) {
        toolCalls = arr.map((tc: { id?: string; name?: string; args?: unknown }) => ({
          id: tc.id ?? "",
          name: tc.name ?? "",
          args: tc.args,
        }));
      }
    } catch {
      // ignore
    }
  }

  // tool_result 反序列化
  let toolResult: unknown;
  if (rec.tool_result) {
    try {
      toolResult = JSON.parse(rec.tool_result);
    } catch {
      toolResult = rec.tool_result;
    }
  }

  // toolArgs：从 content "🔧 name(args_json)" 中解析参数（兼容旧消息）
  let toolArgs: unknown;
  if (rec.role === "tool" && typeof content === "string") {
    const parsed = parseToolArgsFromContent(content);
    if (parsed) toolArgs = parsed;
  }

  return {
    id: crypto.randomUUID(),
    role: rec.role,
    content,
    streaming: false,
    isToolCall: rec.role === "tool",
    isError: rec.is_error,
    toolCallId: rec.tool_call_id ?? undefined,
    toolCalls,
    toolResult,
    toolArgs,
  };
}

/// 从 content "🔧 name(args_json)" 中解析工具名和参数。
/// 用于兼容旧消息（落库时未单独存储 toolArgs）。
function parseToolArgsFromContent(content: string): unknown | undefined {
  if (!content.startsWith("🔧 ")) return undefined;
  const rest = content.slice(3);
  const parenIdx = rest.indexOf("(");
  if (parenIdx === -1) return undefined;
  const argsStr = rest.slice(parenIdx + 1, rest.lastIndexOf(")"));
  if (!argsStr) return undefined;
  try {
    return JSON.parse(argsStr);
  } catch {
    return argsStr;
  }
}

/// 默认新会话标题：基于当前时间生成
export function generateDefaultTitle(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
