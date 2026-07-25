export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  created_ts: number;
  is_active: boolean;
  status: "valid" | "path_not_found" | "path_not_dir" | "not_writable";
}

export interface CreateWorkspaceRequest {
  name: string;
  path: string;
}
