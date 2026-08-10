// 知识图谱前端类型（与后端 Rust serde 序列化对齐）

export interface KgNode {
  id: number;
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
