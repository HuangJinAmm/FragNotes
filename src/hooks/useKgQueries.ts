import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type {
  CreateKgEdgeRequest,
  KgEdge,
  KgNode,
  ListKgNodesRequest,
  SetKgPositionRequest,
  UpdateKgEdgeRequest,
  UpsertKgNodeRequest,
} from "@/types/kg";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";

export const kgKeys = {
  all: ["kg"] as const,
  nodes: () => [...kgKeys.all, "nodes"] as const,
  edges: () => [...kgKeys.all, "edges"] as const,
  nodeMemos: (nodeId: number) => [...kgKeys.all, "nodeMemos", nodeId] as const,
  memoNodes: (memoId: number) => [...kgKeys.all, "memoNodes", memoId] as const,
};

export function useKgNodes() {
  return useQuery<KgNode[]>({
    queryKey: kgKeys.nodes(),
    queryFn: () => invoke<KgNode[]>("kg_node_list", { req: {} as ListKgNodesRequest }),
  });
}

export function useKgEdges() {
  return useQuery<KgEdge[]>({
    queryKey: kgKeys.edges(),
    queryFn: () => invoke<KgEdge[]>("kg_edge_list", { req: { node_ids: null } }),
  });
}

export function useCreateKgNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpsertKgNodeRequest) => invoke<KgNode>("kg_node_create", { req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: kgKeys.nodes() }),
  });
}

export function useUpdateKgNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, req }: { id: number; req: UpsertKgNodeRequest }) =>
      invoke<KgNode>("kg_node_update", { id, req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: kgKeys.nodes() }),
  });
}

export function useDeleteKgNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => invoke<void>("kg_node_delete", { id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: kgKeys.nodes() });
      qc.invalidateQueries({ queryKey: kgKeys.all });
    },
  });
}

export function useSetKgNodeTags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, tags }: { id: number; tags: string[] }) =>
      invoke<void>("kg_node_set_tags", { id, tags }),
    onSuccess: () => qc.invalidateQueries({ queryKey: kgKeys.nodes() }),
  });
}

export function useSetKgNodePosition() {
  return useMutation({
    mutationFn: (req: SetKgPositionRequest) => invoke<void>("kg_node_set_position", { req }),
  });
}

export function useSetKgNodeCollapsed() {
  return useMutation({
    mutationFn: ({ id, collapsed }: { id: number; collapsed: boolean }) =>
      invoke<void>("kg_node_set_collapsed", { id, collapsed }),
  });
}

export function useCreateKgEdge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateKgEdgeRequest) => invoke<KgEdge>("kg_edge_create", { req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: kgKeys.edges() }),
  });
}

export function useUpdateKgEdge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpdateKgEdgeRequest) => invoke<KgEdge>("kg_edge_update", { req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: kgKeys.edges() }),
  });
}

export function useDeleteKgEdge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => invoke<void>("kg_edge_delete", { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: kgKeys.edges() }),
  });
}

export function useLinkMemoToNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ memoId, nodeId }: { memoId: number; nodeId: number }) =>
      invoke<void>("kg_link_memo", { memoId, nodeId }),
    onSuccess: (_data, { memoId }) => qc.invalidateQueries({ queryKey: kgKeys.memoNodes(memoId) }),
  });
}

export function useUnlinkMemoFromNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ memoId, nodeId }: { memoId: number; nodeId: number }) =>
      invoke<void>("kg_unlink_memo", { memoId, nodeId }),
    onSuccess: (_data, { memoId }) => qc.invalidateQueries({ queryKey: kgKeys.memoNodes(memoId) }),
  });
}

export function useKgNodeMemos(nodeId: number | null) {
  return useQuery<Memo[]>({
    queryKey: kgKeys.nodeMemos(nodeId ?? 0),
    queryFn: () => invoke<Memo[]>("kg_list_node_memos", { nodeId }),
    enabled: nodeId != null,
  });
}

export function useMemoKgNodes(memoId: number | null) {
  return useQuery<KgNode[]>({
    queryKey: kgKeys.memoNodes(memoId ?? 0),
    queryFn: () => invoke<KgNode[]>("kg_list_memo_nodes", { memoId }),
    enabled: memoId != null,
  });
}
