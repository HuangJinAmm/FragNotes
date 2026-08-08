import copy from "copy-to-clipboard";
import {
  BotIcon,
  CheckIcon,
  CopyIcon,
  ListTodoIcon,
  LoaderIcon,
  CircleIcon,
  CheckCircle2Icon,
  UserIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { MemoMarkdownRenderer } from "@/components/MemoContent/MemoMarkdownRenderer";
import { MemoViewContext } from "@/components/MemoView/MemoViewContext";
import { STUB_MEMO_VIEW_CONTEXT } from "@/components/MemoPreview/MemoPreview";
import { useTranslate } from "@/utils/i18n";
import { cn } from "@/lib/utils";
import {
  PERMISSION_BADGE_COLORS,
  PERMISSION_LABELS,
  type ToolPermission,
} from "@/types/tool";
import type { ChatMessage, ContentPart, PlanResult, PlanTodoStatus } from "./types";

interface AiChatMessagesProps {
  messages: ChatMessage[];
}

/// 复制 markdown 原文的小按钮：点击复制，2 秒内显示打勾反馈。
function CopyMarkdownButton({ text }: { text: string }) {
  const t = useTranslate();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const ok = copy(text);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground",
        "transition-colors hover:bg-foreground/5 hover:text-foreground",
      )}
      aria-label={t("common.copy")}
      title={t("common.copy")}
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      <span>{copied ? t("message.copied") : t("common.copy")}</span>
    </button>
  );
}

/// 将工具参数格式化为 JSON 字符串（用于展开显示）
function formatArgsJson(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/// 从 content "🔧 name(...)" 中提取工具名（兼容旧消息）
function extractToolName(content: string | ContentPart[]): string | undefined {
  if (typeof content !== "string" || !content.startsWith("🔧 ")) return undefined;
  const rest = content.slice(3);
  const parenIdx = rest.indexOf("(");
  return parenIdx === -1 ? rest : rest.slice(0, parenIdx);
}

/// 任务清单卡片：渲染 update_plan 工具返回的 todo-list 及进度
function PlanCard({ result }: { result: PlanResult | null }) {
  const t = useTranslate();
  const todos = result?.todos ?? [];
  const total = result?.total ?? todos.length;
  const completed = result?.completed ?? todos.filter((td) => td.status === "completed").length;
  const allDone = total > 0 && completed === total;

  const statusIcon = (status: PlanTodoStatus) => {
    if (status === "completed") {
      return <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-500" />;
    }
    if (status === "in_progress") {
      return <LoaderIcon className="size-3.5 shrink-0 text-blue-500 animate-spin" />;
    }
    return <CircleIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  };

  return (
    <div className="my-1 rounded border border-violet-200 bg-violet-50 dark:border-violet-900 dark:bg-violet-950/30 p-2 text-xs">
      <div className="mb-1.5 flex items-center gap-2">
        <ListTodoIcon className="size-3.5 text-violet-600 dark:text-violet-400" />
        <span className="font-medium text-violet-700 dark:text-violet-300">
          {t("aiChat.plan.title")}
        </span>
        <span
          className={cn(
            "ml-auto rounded px-1.5 py-0.5 text-[10px]",
            allDone
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"
              : "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300",
          )}
        >
          {completed}/{total}
        </span>
      </div>
      {todos.length > 0 ? (
        <ol className="space-y-1">
          {todos.map((td, i) => (
            <li
              key={i}
              className={cn(
                "flex items-start gap-1.5",
                td.status === "completed" && "text-muted-foreground line-through",
                td.status === "in_progress" && "text-foreground",
              )}
            >
              {statusIcon(td.status)}
              <span className="break-words">{td.content}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-muted-foreground italic">{t("aiChat.plan.empty")}</p>
      )}
    </div>
  );
}

export function AiChatMessages({ messages }: AiChatMessagesProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const t = useTranslate();

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const renderUserContent = (content: string | ContentPart[]) => {
    if (typeof content === "string") {
      return <p className="whitespace-pre-wrap break-words">{content}</p>;
    }
    return (
      <div className="space-y-2">
        {content.map((part, i) => {
          if (part.type === "text") {
            return (
              <p key={i} className="whitespace-pre-wrap break-words">
                {part.text}
              </p>
            );
          }
          return (
            <img
              key={i}
              src={part.image_url.url}
              alt=""
              className="max-w-48 rounded-md"
            />
          );
        })}
      </div>
    );
  };

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <BotIcon className="size-8" />
        <p className="text-sm">有什么可以帮你的？</p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
      {messages.map((msg) => {
        if (msg.role === "tool") {
          // 工具参数格式化为 JSON 字符串（用于展开显示）
          const argsJson = formatArgsJson(msg.toolArgs);
          // 工具显示名：优先 toolName，其次从 content 解析
          const displayName = msg.toolName ?? extractToolName(msg.content) ?? "tool";

          // update_plan：渲染任务清单进度卡片
          if (msg.toolName === "update_plan") {
            const result = msg.toolResult as PlanResult | null;
            return <PlanCard key={msg.id} result={result} />;
          }

          // load_skill：保持原有特殊渲染（蓝色卡片 + skill body）
          if (msg.toolName === "load_skill") {
            const result = msg.toolResult as { id?: string; name?: string; body?: string; error?: string } | null;
            return (
              <div key={msg.id} className="my-1 rounded border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30 p-2 text-xs">
                <details>
                  <summary className="cursor-pointer font-medium text-blue-700 dark:text-blue-300">
                    📖 {t("aiChat.skill.loaded", { name: result?.name ?? "skill" })}
                  </summary>
                  <div className="mt-2 prose prose-sm dark:prose-invert max-w-none">
                    {result?.error ? (
                      <p className="text-red-600">{result.error}</p>
                    ) : (
                      <ReactMarkdown>{result?.body ?? ""}</ReactMarkdown>
                    )}
                  </div>
                </details>
              </div>
            );
          }

          // 用户工具：result 中包含 tool_name 和 permission
          const userToolResult = msg.toolResult as {
            tool_name?: string;
            permission?: string;
            denied?: boolean;
            error?: string;
            output?: string;
            exit_code?: number;
          } | null;

          if (userToolResult?.tool_name && userToolResult?.permission) {
            const perm = userToolResult.permission as ToolPermission;
            const isDenied = userToolResult.denied === true;
            return (
              <div
                key={msg.id}
                className={`my-1 rounded border p-2 text-xs ${
                  isDenied
                    ? "border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/30"
                    : userToolResult.error
                    ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30"
                    : "border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/30"
                }`}
              >
                {/* 工具名 + 权限徽章 + 拒绝标记（始终可见） */}
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-medium">{userToolResult.tool_name}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${PERMISSION_BADGE_COLORS[perm]}`}>
                    {PERMISSION_LABELS[perm]}
                  </span>
                  {isDenied && (
                    <span className="text-yellow-700 dark:text-yellow-300">
                      {t("aiChat.tool.denied")}
                    </span>
                  )}
                </div>
                {/* 折叠的参数区域 */}
                {argsJson && (
                  <details className="mb-1">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      {t("aiChat.tool.parameters")}
                    </summary>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background/50 p-1.5 font-mono text-[11px]">
                      {argsJson}
                    </pre>
                  </details>
                )}
                {/* 输出/错误（始终可见） */}
                {userToolResult.error ? (
                  <p className="font-mono text-red-600 dark:text-red-400">{userToolResult.error}</p>
                ) : (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono">
                    {userToolResult.output ?? ""}
                  </pre>
                )}
              </div>
            );
          }

          // 默认工具（内置工具如 create_memo / update_memo 等）
          return (
            <div key={msg.id} className="my-1 rounded border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/30 p-2 text-xs">
              <details>
                <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">
                  🔧 {displayName}
                </summary>
                <div className="mt-1.5 space-y-1.5">
                  {argsJson ? (
                    <div>
                      <div className="text-[10px] text-muted-foreground">{t("aiChat.tool.parameters")}</div>
                      <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background/50 p-1.5 font-mono text-[11px]">
                        {argsJson}
                      </pre>
                    </div>
                  ) : (
                    <p className="text-muted-foreground italic">{t("aiChat.tool.noParameters")}</p>
                  )}
                </div>
              </details>
            </div>
          );
        }
        const isUser = msg.role === "user";
        // assistant 非空文本回复完成（非错误、非流式）时，在气泡下方显示复制按钮
        const showCopyButton =
          !isUser &&
          !msg.streaming &&
          !msg.isError &&
          typeof msg.content === "string" &&
          msg.content.length > 0;
        return (
          <div
            key={msg.id}
            className={cn("flex gap-2", isUser ? "flex-row-reverse" : "flex-row")}
          >
            <div className="shrink-0 mt-0.5">
              {isUser ? (
                <UserIcon className="size-5 text-muted-foreground" />
              ) : (
                <BotIcon className="size-5 text-primary" />
              )}
            </div>
            <div className={cn("flex flex-col flex-1 min-w-0", isUser ? "items-end" : "items-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                  isUser
                    ? "bg-primary text-primary-foreground"
                    : msg.isError
                      ? "bg-destructive/10 text-destructive"
                      : "bg-muted",
                )}
              >
                {isUser ? (
                  renderUserContent(msg.content)
                ) : typeof msg.content === "string" && msg.content ? (
                  <div className="break-words">
                    <MemoViewContext.Provider value={STUB_MEMO_VIEW_CONTEXT}>
                      <MemoMarkdownRenderer
                        content={msg.content}
                        resolvedMentionUsernames={new Set()}
                      />
                    </MemoViewContext.Provider>
                    {msg.streaming && (
                      <span className="inline-block w-1 h-4 ml-0.5 bg-current animate-pulse" />
                    )}
                  </div>
                ) : msg.streaming ? (
                  <span className="text-muted-foreground text-xs">思考中...</span>
                ) : null}
              </div>
              {showCopyButton && <CopyMarkdownButton text={msg.content as string} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
