import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listSessions } from "@/components/AiChat/chatSessionService";
import type {
  AiMemoryDto,
  MemoryConfigDto,
  MemoryImportReport,
  MemoryKind,
} from "@/types/memory";

export const memoryKeys = {
  all: ["memory"] as const,
  list: () => [...memoryKeys.all, "list"] as const,
  config: () => [...memoryKeys.all, "config"] as const,
};

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: memoryKeys.all });
}

/** 记忆列表（含已停用条目） */
export function useMemoryList() {
  return useQuery<AiMemoryDto[]>({
    queryKey: memoryKeys.list(),
    queryFn: () => invoke<AiMemoryDto[]>("memory_list", { query: null, includeDisabled: true }),
  });
}

export function useMemoryConfig() {
  return useQuery<MemoryConfigDto>({
    queryKey: memoryKeys.config(),
    queryFn: () => invoke<MemoryConfigDto>("memory_get_config"),
  });
}

export function useSaveMemoryConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: MemoryConfigDto) => invoke<MemoryConfigDto>("memory_set_config", { config }),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useCreateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: MemoryKind; content: string; importance: number }) =>
      invoke<AiMemoryDto>("memory_create", input),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useUpdateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: number;
      kind: MemoryKind;
      content: string;
      importance: number;
      enabled: boolean;
    }) => invoke<AiMemoryDto>("memory_update", input),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useDeleteMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => invoke<void>("memory_delete", { id }),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useSetMemoryEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      invoke<void>("memory_set_enabled", { id, enabled }),
    onSuccess: () => invalidateAll(qc),
  });
}

/**
 * 记忆来源会话的标题映射（sessionId → title）。
 * 会话可能已被删除，因此展示侧需对缺失 id 做兜底。
 */
export function useSourceSessionTitles() {
  return useQuery<Map<number, string>>({
    queryKey: [...memoryKeys.all, "sessionTitles"] as const,
    queryFn: async () => {
      const sessions = await listSessions();
      return new Map(sessions.map((s) => [s.id, s.title]));
    },
    staleTime: 60_000,
  });
}

/** 导出全部记忆为 JSON 备份文本 */
export function useExportMemories() {
  return useMutation({
    mutationFn: () => invoke<string>("memory_export_json"),
  });
}

/** 导入记忆备份（幂等，返回导入统计） */
export function useImportMemories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jsonStr: string) => invoke<MemoryImportReport>("memory_import_json", { jsonStr }),
    onSuccess: () => invalidateAll(qc),
  });
}

/** 重建缺失的记忆向量（语义召回用）。返回本次生成的条数。 */
export function useReindexMemories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invoke<number>("memory_reindex"),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useClearMemories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invoke<number>("memory_clear"),
    onSuccess: () => invalidateAll(qc),
  });
}
