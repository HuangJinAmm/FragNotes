/** AI 长期记忆：用户偏好 / 稳定事实 / 会话要点 */

export type MemoryKind = "fact" | "preference" | "episode";

export type MemorySource = "manual" | "ai" | "imported";

/** 记忆导入结果（与后端 core::memory::ImportReport 对应） */
export interface MemoryImportReport {
  /** 新增条目数 */
  imported: number;
  /** 内容重复、仅提升重要度的条目数 */
  merged: number;
  /** 无效（空内容 / 超长）条目数 */
  skipped: number;
}

export interface AiMemoryDto {
  id: number;
  kind: MemoryKind;
  content: string;
  source: MemorySource;
  /** 来源会话（AI 自动抽取时为 null） */
  sourceSessionId: number | null;
  /** 1-5，越高越优先注入对话 */
  importance: number;
  confidence: number;
  /** 被注入对话的次数 */
  hits: number;
  lastHitTs: number | null;
  enabled: boolean;
  createdTs: number;
  updatedTs: number;
}

export interface MemoryConfigDto {
  /** 总开关：关闭时既不注入也不自动抽取 */
  enabled: boolean;
  /** 对话结束后自动抽取记忆 */
  autoExtract: boolean;
  maxItems: number;
  maxChars: number;
}

export const MEMORY_KINDS: MemoryKind[] = ["fact", "preference", "episode"];

export const MEMORY_CONFIG_LIMITS = {
  minItems: 1,
  maxItems: 200,
  minChars: 100,
  maxChars: 4000,
} as const;
