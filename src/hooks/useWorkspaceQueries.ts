import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { CreateWorkspaceRequest, WorkspaceInfo } from "@/types/workspace";

export const workspaceKeys = {
  all: ["workspaces"] as const,
};

export function useWorkspaceList() {
  return useQuery<WorkspaceInfo[]>({
    queryKey: workspaceKeys.all,
    queryFn: () => invoke<WorkspaceInfo[]>("workspace_list"),
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateWorkspaceRequest) =>
      invoke<WorkspaceInfo>("workspace_create", { req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.all }),
  });
}

export function useSwitchWorkspace() {
  return useMutation({
    mutationFn: (id: string) => invoke<void>("workspace_switch", { id }),
  });
}

export function useRenameWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, newName }: { id: string; newName: string }) =>
      invoke<void>("workspace_rename", { id, newName }),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.all }),
  });
}

export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke<void>("workspace_delete", { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.all }),
  });
}

export function useOpenInExplorer() {
  return useMutation({
    mutationFn: (path: string) => invoke<void>("workspace_open_in_explorer", { path }),
  });
}
