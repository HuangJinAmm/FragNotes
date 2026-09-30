import copy from "copy-to-clipboard";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  CircleXIcon,
  CopyIcon,
  ListTodoIcon,
  LoaderIcon,
  CircleIcon,
  CheckCircle2Icon,
  UserIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

/// 将任意值格式化为可读 JSON 字符串（工具参数 / 工具结果展开显示用）
function formatJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/// 折叠态单行摘要：取首个非空行并截断，避免「折叠后什么都看不到」
function firstLineSummary(text: string | undefined, max = 120): string {
  if (!text) return "";
  const line = (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
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

/// 思考过程展示框：
/// - 最多显示 4 行（max-h-24，leading-6 → 约 4 行）
/// - 流式过程中自动滚动到底部，显示最新思考内容
/// - 思考完成后可滚动查看全部内容
/// - 可通过点击 header 折叠/展开
function ThinkingBox({ reasoning, streaming }: { reasoning: string; streaming: boolean }) {
  const t = useTranslate();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  // 流式过程中自动滚动到底部，显示最新思考内容
  useEffect(() => {
    if (streaming && !collapsed && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [reasoning, streaming, collapsed]);

  // 思考刚完成时（streaming 从 true → false），滚动到顶部便于从头查看
  const prevStreamingRef = useRef(streaming);
  useEffect(() => {
    if (prevStreamingRef.current && !streaming && !collapsed && bodyRef.current) {
      bodyRef.current.scrollTop = 0;
    }
    prevStreamingRef.current = streaming;
  }, [streaming, collapsed]);

  return (
    <div className="mb-1.5 rounded border border-amber-200 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/20 text-xs overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-amber-700 dark:text-amber-300 hover:bg-amber-100/50 dark:hover:bg-amber-900/30 transition-colors"
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3 shrink-0" />
        ) : (
          <ChevronDownIcon className="size-3 shrink-0" />
        )}
        {streaming ? (
          <LoaderIcon className="size-3 shrink-0 animate-spin" />
        ) : (
          <CheckIcon className="size-3 shrink-0" />
        )}
        <span className="font-medium">
          {streaming ? t("aiChat.streaming") : t("aiChat.thinkingDone")}
        </span>
      </button>
      {!collapsed && (
        <div
          ref={bodyRef}
          className="px-2 pb-1.5 pt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-amber-900/80 dark:text-amber-100/70 leading-6"
        >
          {reasoning}
        </div>
      )}
    </div>
  );
}

/// 工具调用状态
type ToolCallStatus = "success" | "error" | "denied";

/// 统一的可折叠工具调用记录卡片：
/// - header 常驻：展开箭头 + 状态图标 + 工具名 + 徽章；折叠时追加一行结果摘要
/// - body 展开：参数 JSON + 输出（可用 children 覆盖，如 skill 正文 markdown）
/// - 仅「错误」结果默认展开以保证可见性，其余默认折叠，避免记录刷屏
function ToolCallCard({
  name,
  status,
  tone,
  argsJson,
  output,
  error,
  badges,
  children,
  variant = "card",
}: {
  /// header 标题（工具名 / 已本地化的描述）
  name: ReactNode;
  status: ToolCallStatus;
  /// 卡片配色，默认由 status 推导；blue 用于 skill 等特殊类别
  tone?: "neutral" | "blue";
  argsJson?: string;
  output?: string;
  error?: string;
  /// header 中的附加徽章（权限等级、拒绝标记等）
  badges?: ReactNode;
  /// 展开区自定义内容；提供时忽略默认的「参数 + 输出」渲染
  children?: ReactNode;
  /// card：独立卡片（带边框底色）；plain：嵌套在折叠面板内的无边框行
  variant?: "card" | "plain";
}) {
  const t = useTranslate();
  // 错误默认展开以保证可见性，其余默认折叠
  const [collapsed, setCollapsed] = useState(status !== "error");

  const palette =
    status === "error"
      ? {
          box: "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30",
          header: "text-red-700 dark:text-red-300",
        }
      : status === "denied"
        ? {
            box: "border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/30",
            header: "text-yellow-700 dark:text-yellow-300",
          }
        : tone === "blue"
          ? {
              box: "border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30",
              header: "text-blue-700 dark:text-blue-300",
            }
          : {
              box: "border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/30",
              header: "text-muted-foreground",
            };

  const statusIcon =
    status === "error" ? (
      <CircleXIcon className="size-3 shrink-0 text-red-500" />
    ) : status === "denied" ? (
      <CircleSlashIcon className="size-3 shrink-0 text-yellow-500" />
    ) : (
      <CheckCircle2Icon className="size-3 shrink-0 text-emerald-500" />
    );

  // 折叠态摘要：错误显示错误信息，拒绝显示「已拒绝」，否则显示输出首行
  const summary =
    status === "error"
      ? firstLineSummary(error)
      : status === "denied"
        ? t("aiChat.tool.denied")
        : firstLineSummary(output);

  const isPlain = variant === "plain";

  return (
    <div className={cn("overflow-hidden text-xs", !isPlain && cn("my-1 rounded border", palette.box))}>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className={cn(
          "flex w-full items-center gap-1.5 text-left transition-colors hover:bg-foreground/5",
          isPlain ? "rounded px-1 py-0.5" : "px-2 py-1",
          palette.header,
        )}
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3 shrink-0" />
        ) : (
          <ChevronDownIcon className="size-3 shrink-0" />
        )}
        {statusIcon}
        <span className="min-w-0 max-w-[70%] truncate font-medium">{name}</span>
        {badges}
        {collapsed && summary && (
          <span className="ml-1 min-w-0 flex-1 truncate font-normal text-muted-foreground">{summary}</span>
        )}
      </button>
      {!collapsed && (
        <div className={cn("space-y-1.5 pt-0.5", isPlain ? "pb-1 pl-5 pr-0.5" : "px-2 pb-1.5")}>
          {children ?? (
            <>
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
              {error ? (
                <p className="whitespace-pre-wrap break-all font-mono text-red-600 dark:text-red-400">{error}</p>
              ) : output ? (
                <div>
                  <div className="text-[10px] text-muted-foreground">{t("aiChat.tool.output")}</div>
                  <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono">
                    {output}
                  </pre>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/// 工具消息是否执行失败（用于分组面板的失败计数与自动展开）
function isToolMessageError(msg: ChatMessage): boolean {
  const result = msg.toolResult;
  if (!result || typeof result !== "object") return false;
  const r = result as { error?: unknown; denied?: unknown };
  if (r.denied === true) return false;
  return typeof r.error === "string" && r.error.length > 0;
}

/// 单条工具消息的渲染分派：
/// - update_plan → 任务清单进度卡片（独立展示，不进折叠面板）
/// - load_skill → 蓝色卡片 + skill 正文
/// - 用户工具   → 工具名 + 权限徽章
/// - 其余内置工具 → 工具名 + 参数 / 结果
function ToolMessageRecord({ msg, variant = "card" }: { msg: ChatMessage; variant?: "card" | "plain" }) {
  const t = useTranslate();
  // 工具参数格式化为 JSON 字符串（用于展开显示）
  const argsJson = formatJson(msg.toolArgs);
  // 工具显示名：优先 toolName，其次从 content 解析
  const displayName = msg.toolName ?? extractToolName(msg.content) ?? "tool";

  // update_plan：渲染任务清单进度卡片
  if (msg.toolName === "update_plan") {
    const result = msg.toolResult as PlanResult | null;
    return <PlanCard result={result} />;
  }

  // load_skill：蓝色卡片 + 折叠的 skill 正文
  if (msg.toolName === "load_skill") {
    const result = msg.toolResult as { id?: string; name?: string; body?: string; error?: string } | null;
    return (
      <ToolCallCard
        name={`📖 ${t("aiChat.skill.loaded", { name: result?.name ?? "skill" })}`}
        status={result?.error ? "error" : "success"}
        tone="blue"
        error={result?.error}
        variant={variant}
      >
        {result?.error ? (
          <p className="whitespace-pre-wrap break-all font-mono text-red-600 dark:text-red-400">{result.error}</p>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown>{result?.body ?? ""}</ReactMarkdown>
          </div>
        )}
      </ToolCallCard>
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
    const hasError = !isDenied && typeof userToolResult.error === "string" && userToolResult.error.length > 0;
    return (
      <ToolCallCard
        name={userToolResult.tool_name}
        status={isDenied ? "denied" : hasError ? "error" : "success"}
        argsJson={argsJson}
        error={hasError ? userToolResult.error : undefined}
        output={isDenied ? undefined : userToolResult.output}
        variant={variant}
        // 权限徽章 + 拒绝标记（常驻 header）
        badges={
          <>
            <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px]", PERMISSION_BADGE_COLORS[perm])}>
              {PERMISSION_LABELS[perm]}
            </span>
            {isDenied && (
              <span className="shrink-0 text-yellow-700 dark:text-yellow-300">{t("aiChat.tool.denied")}</span>
            )}
          </>
        }
      />
    );
  }

  // 默认工具（内置工具如 create_memo / update_memo 等）
  // 后端工具执行失败时以 { error: "..." } 形式返回（见 ai_chat.rs）
  const builtinError =
    msg.toolResult && typeof msg.toolResult === "object"
      ? (msg.toolResult as { error?: unknown }).error
      : undefined;
  const builtinErrorText = typeof builtinError === "string" && builtinError.length > 0 ? builtinError : undefined;
  return (
    <ToolCallCard
      name={`🔧 ${displayName}`}
      status={builtinErrorText ? "error" : "success"}
      argsJson={argsJson}
      error={builtinErrorText}
      output={builtinErrorText ? undefined : formatJson(msg.toolResult) || undefined}
      variant={variant}
    />
  );
}

/// 一次「工具调用批次」的折叠面板：把本轮连续产生的所有工具调用记录收进一个面板，
/// 折叠态显示调用次数 + 工具名摘要（同名合并为 `name ×N`）+ 失败数，
/// 展开后逐条展示每次调用。存在失败调用时默认展开，保证错误可见。
function ToolGroupPanel({ msgs }: { msgs: ChatMessage[] }) {
  const t = useTranslate();
  const failed = msgs.filter(isToolMessageError).length;
  const [collapsed, setCollapsed] = useState(failed === 0);

  // 流式过程中新增了失败的调用时自动展开，避免错误被折叠隐藏
  useEffect(() => {
    if (failed > 0) setCollapsed(false);
  }, [failed]);

  // 工具名摘要：同名合并计数，如 "create_memo ×2, update_memo"
  const nameSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of msgs) {
      const name = m.toolName ?? extractToolName(m.content) ?? "tool";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
  }, [msgs]);

  return (
    <div className="my-1 overflow-hidden rounded border border-gray-200 bg-gray-50 text-xs dark:border-gray-800 dark:bg-gray-900/30">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-muted-foreground transition-colors hover:bg-foreground/5"
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3 shrink-0" />
        ) : (
          <ChevronDownIcon className="size-3 shrink-0" />
        )}
        <WrenchIcon className="size-3 shrink-0" />
        <span className="shrink-0 font-medium">{t("aiChat.tool.groupTitle", { count: msgs.length })}</span>
        {collapsed && nameSummary && (
          <span className="ml-1 min-w-0 flex-1 truncate font-normal text-muted-foreground/80">{nameSummary}</span>
        )}
        {failed > 0 && (
          <span className="ml-auto shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700 dark:bg-red-900/50 dark:text-red-300">
            {t("aiChat.tool.groupFailed", { count: failed })}
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="space-y-0.5 px-2 pb-1.5 pt-0.5">
          {msgs.map((m) => (
            <ToolMessageRecord key={m.id} msg={m} variant="plain" />
          ))}
        </div>
      )}
    </div>
  );
}

/// 渲染分组：连续的工具消息合并为一个折叠面板，其余消息各成一组
type MessageGroup =
  | { kind: "message"; key: string; msg: ChatMessage }
  | { kind: "tools"; key: string; msgs: ChatMessage[] };

/// 将消息列表切分为渲染分组。
/// update_plan 不参与合并：它是持续刷新的任务进度看板，需要始终保持可见。
function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const msg of messages) {
    const groupable = msg.role === "tool" && msg.toolName !== "update_plan";
    const last = groups[groups.length - 1];
    if (groupable) {
      if (last?.kind === "tools") {
        last.msgs.push(msg);
      } else {
        groups.push({ kind: "tools", key: msg.id, msgs: [msg] });
      }
    } else {
      groups.push({ kind: "message", key: msg.id, msg });
    }
  }
  return groups;
}

export function AiChatMessages({ messages }: AiChatMessagesProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // 连续的工具消息合并为一个折叠面板
  const groups = useMemo(() => groupMessages(messages), [messages]);

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
      {groups.map((group) => {
        if (group.kind === "tools") {
          // 单次工具调用直接展示为独立卡片，多次调用才收进折叠面板
          return group.msgs.length === 1 ? (
            <ToolMessageRecord key={group.key} msg={group.msgs[0]} />
          ) : (
            <ToolGroupPanel key={group.key} msgs={group.msgs} />
          );
        }
        const msg = group.msg;
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
            key={group.key}
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
                ) : (
                  <>
                    {/* 思考过程框（有 reasoning 内容时显示） */}
                    {typeof msg.reasoning === "string" && msg.reasoning.length > 0 && (
                      <ThinkingBox
                        reasoning={msg.reasoning}
                        streaming={!!msg.streaming}
                      />
                    )}
                    {typeof msg.content === "string" && msg.content ? (
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
                    ) : msg.streaming && !(typeof msg.reasoning === "string" && msg.reasoning.length > 0) ? (
                      <span className="text-muted-foreground text-xs">思考中...</span>
                    ) : null}
                  </>
                )}
              </div>
              {showCopyButton && <CopyMarkdownButton text={msg.content as string} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
