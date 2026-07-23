export type SkillSource = "builtin" | "user";

export interface SkillDto {
  id: string;
  name: string;
  description: string;
  tools: string[];
  body: string;
  enabled: boolean;
  source: SkillSource;
  created_ts: number;
  updated_ts: number;
}

/** 已知的工具名（供 SkillEditor 的 tools 多选） */
export const KNOWN_TOOL_NAMES = [
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
