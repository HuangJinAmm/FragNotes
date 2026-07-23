import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { SkillDto } from "@/types/skill";

export const skillKeys = {
  all: ["skills"] as const,
  list: () => [...skillKeys.all, "list"] as const,
};

export function useSkillList() {
  return useQuery<SkillDto[]>({
    queryKey: skillKeys.list(),
    queryFn: () => invoke<SkillDto[]>("skill_list"),
  });
}

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skill: SkillDto) => invoke<SkillDto>("skill_create", { skill }),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skill: SkillDto) => invoke<SkillDto>("skill_update", { skill }),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke<void>("skill_delete", { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export function useSetSkillEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      invoke<void>("skill_set_enabled", { id, enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}
