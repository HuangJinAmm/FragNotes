// 知识图谱前端类型（与后端 Rust serde 序列化对齐）

export interface KgGraph {
  id: number;
  uid: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  created_ts: number;
  updated_ts: number;
}

export interface UpsertKgGraphRequest {
  uid: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
}

export interface KgNode {
  id: number;
  graph_id: number;
  uid: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  parent_id: number | null;
  pos_x: number | null;
  pos_y: number | null;
  collapsed: boolean;
  created_ts: number;
  updated_ts: number;
  tags: string[];
}

export interface KgEdge {
  id: number;
  source_id: number;
  target_id: number;
  type: string;
  label: string;
  created_ts: number;
}

export interface UpsertKgNodeRequest {
  uid: string;
  graph_id: number;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  parent_id?: number | null;
  pos_x?: number | null;
  pos_y?: number | null;
  collapsed?: boolean;
}

export interface ListKgNodesRequest {
  graph_id?: number | null;
  parent_id?: number | null | undefined;
  id_list?: number[];
}

export interface CreateKgEdgeRequest {
  source_id: number;
  target_id: number;
  edge_type: string;
  label?: string;
}

export interface UpdateKgEdgeRequest {
  id: number;
  edge_type: string;
  label: string;
}

export interface SetKgPositionRequest {
  id: number;
  x: number | null;
  y: number | null;
}

/** 节点记忆状态：关联笔记（标签匹配 ∪ 手动关联）的复习卡片聚合 */
export interface KgNodeReviewStats {
  node_id: number;
  /** 关联笔记数 */
  memo_count: number;
  /** 复习卡片总数 */
  total_cards: number;
  /** 已到期卡片数 */
  due_count: number;
  /** 平均稳定性（FSRS stability，单位：天），无卡片时为 0 */
  avg_stability: number;
}
