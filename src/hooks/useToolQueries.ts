import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { BUILTIN_TOOL_NAMES, type ToolDto } from "@/types/tool";

export const toolKeys = {
  all: ["tools"] as const,
  list: (options?: { enabled?: boolean }) => [...toolKeys.all, "list", options] as const,
};

/**
 * 拉取工具列表
 * @param options.enabled - true 只返回启用的，false/undefined 返回所有
 */
export function useToolList(options?: { enabled?: boolean }) {
  return useQuery<ToolDto[]>({
    queryKey: toolKeys.list(options),
    queryFn: () => invoke<ToolDto[]>("tool_list", { enabled: options?.enabled ?? null }),
  });
}

export function useCreateTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tool: ToolDto) => invoke<ToolDto>("tool_create", { tool }),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.all }),
  });
}

export function useUpdateTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tool: ToolDto) => invoke<ToolDto>("tool_update", { tool }),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.all }),
  });
}

export function useDeleteTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke<void>("tool_delete", { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.all }),
  });
}

export function useSetToolEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      invoke<void>("tool_set_enabled", { id, enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.all }),
  });
}

/** 合并内置 11 个工具名 + 所有用户工具名（含禁用），供 SkillEditor 多选用 */
export function useKnownToolNames() {
  const { data: userTools } = useToolList({ enabled: false });
  const userNames = (userTools ?? []).map((t) => t.name);
  return [...BUILTIN_TOOL_NAMES, ...userNames];
}
