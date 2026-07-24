export type ToolPermission = "read_only" | "writable" | "executable" | "dangerous";

export interface ToolDto {
  id: string;
  name: string;
  command: string;
  permission: ToolPermission;
  description: string;
  timeout_ms: number;
  enabled: boolean;
  created_ts: number;
  updated_ts: number;
}

/** 内置 10 个工具名（黑名单，校验用户输入用） */
export const BUILTIN_TOOL_NAMES = [
  "list_memos",
  "get_memo",
  "create_memo",
  "list_tags",
  "list_memos_by_tag",
  "update_memo",
  "search_semantic",
  "link_memos",
  "create_review_cards",
  "load_skill",
] as const;

export const PERMISSION_LABELS: Record<ToolPermission, string> = {
  read_only: "只读",
  writable: "可写",
  executable: "可执行",
  dangerous: "危险",
};

/** 权限等级 badge 颜色（Tailwind class） */
export const PERMISSION_BADGE_COLORS: Record<ToolPermission, string> = {
  read_only: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  writable: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  executable: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  dangerous: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
};

/** tool:confirm_request 事件 payload */
export interface ToolConfirmRequest {
  call_id: number;
  tool_name: string;
  command: string;
  permission: ToolPermission;
}
