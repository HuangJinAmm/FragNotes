//! 知识图谱 IPC 命令

use crate::error::IpcResult;
use crate::state::AppState;
use memos_core::kg_edge::{self, KgEdge};
use memos_core::kg_graph::{self, KgGraph, UpsertKgGraph};
use memos_core::kg_node::{self, FindKgNode, KgNode, UpsertKgNode};
use memos_core::memo;
use memos_core::memo_kg_node;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct UpsertKgNodeRequest {
    pub uid: String,
    pub graph_id: i32,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub icon: String,
    pub parent_id: Option<i32>,
    pub pos_x: Option<f64>,
    pub pos_y: Option<f64>,
    #[serde(default)]
    pub collapsed: bool,
}

impl From<UpsertKgNodeRequest> for UpsertKgNode {
    fn from(r: UpsertKgNodeRequest) -> Self {
        UpsertKgNode {
            uid: r.uid,
            graph_id: r.graph_id,
            name: r.name,
            description: r.description,
            color: r.color,
            icon: r.icon,
            parent_id: r.parent_id,
            pos_x: r.pos_x,
            pos_y: r.pos_y,
            collapsed: r.collapsed,
        }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct ListKgNodesRequest {
    pub graph_id: Option<i32>,
    /// None=全部; Some(None)=根节点; Some(Some(id))=指定父的子节点
    pub parent_id: Option<Option<i32>>,
    pub id_list: Option<Vec<i32>>,
}

#[derive(Debug, Deserialize)]
pub struct CreateKgEdgeRequest {
    pub source_id: i32,
    pub target_id: i32,
    pub edge_type: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateKgEdgeRequest {
    pub id: i32,
    pub edge_type: String,
    pub label: String,
}

#[derive(Debug, Deserialize)]
pub struct SetPositionRequest {
    pub id: i32,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

#[tauri::command]
pub fn kg_node_create(state: tauri::State<'_, AppState>, req: UpsertKgNodeRequest) -> IpcResult<KgNode> {
    let store = state.store();
    Ok(store.with_conn(|c| kg_node::create(c, &req.into()))?)
}

#[tauri::command]
pub fn kg_node_update(state: tauri::State<'_, AppState>, id: i32, req: UpsertKgNodeRequest) -> IpcResult<KgNode> {
    let store = state.store();
    Ok(store.with_conn(|c| kg_node::update(c, id, &req.into()))?)
}

#[tauri::command]
pub fn kg_node_delete(state: tauri::State<'_, AppState>, id: i32) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| kg_node::delete(c, id))?;
    Ok(())
}

#[tauri::command]
pub fn kg_node_list(state: tauri::State<'_, AppState>, req: ListKgNodesRequest) -> IpcResult<Vec<KgNode>> {
    let store = state.store();
    let find = FindKgNode {
        graph_id: req.graph_id,
        parent_id: req.parent_id,
        id_list: req.id_list.unwrap_or_default(),
    };
    Ok(store.with_conn(|c| kg_node::list(c, &find))?)
}

#[tauri::command]
pub fn kg_node_set_tags(state: tauri::State<'_, AppState>, id: i32, tags: Vec<String>) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| kg_node::set_tags(c, id, &tags))?;
    Ok(())
}

#[tauri::command]
pub fn kg_node_set_position(state: tauri::State<'_, AppState>, req: SetPositionRequest) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| kg_node::set_position(c, req.id, req.x, req.y))?;
    Ok(())
}

#[tauri::command]
pub fn kg_node_set_collapsed(state: tauri::State<'_, AppState>, id: i32, collapsed: bool) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| kg_node::set_collapsed(c, id, collapsed))?;
    Ok(())
}

#[tauri::command]
pub fn kg_edge_create(state: tauri::State<'_, AppState>, req: CreateKgEdgeRequest) -> IpcResult<KgEdge> {
    let store = state.store();
    Ok(store.with_conn(|c| kg_edge::create(c, req.source_id, req.target_id, &req.edge_type, &req.label))?)
}

#[tauri::command]
pub fn kg_edge_update(state: tauri::State<'_, AppState>, req: UpdateKgEdgeRequest) -> IpcResult<KgEdge> {
    let store = state.store();
    Ok(store.with_conn(|c| kg_edge::update(c, req.id, &req.edge_type, &req.label))?)
}

#[tauri::command]
pub fn kg_edge_delete(state: tauri::State<'_, AppState>, id: i32) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| kg_edge::delete(c, id))?;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct UpsertKgGraphRequest {
    pub uid: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub icon: String,
}

impl From<UpsertKgGraphRequest> for UpsertKgGraph {
    fn from(r: UpsertKgGraphRequest) -> Self {
        UpsertKgGraph {
            uid: r.uid,
            name: r.name,
            description: r.description,
            color: r.color,
            icon: r.icon,
        }
    }
}

#[tauri::command]
pub fn kg_graph_create(state: tauri::State<'_, AppState>, req: UpsertKgGraphRequest) -> IpcResult<KgGraph> {
    let store = state.store();
    Ok(store.with_conn(|c| kg_graph::create(c, &req.into()))?)
}

#[tauri::command]
pub fn kg_graph_update(state: tauri::State<'_, AppState>, id: i32, req: UpsertKgGraphRequest) -> IpcResult<KgGraph> {
    let store = state.store();
    Ok(store.with_conn(|c| kg_graph::update(c, id, &req.into()))?)
}

#[tauri::command]
pub fn kg_graph_delete(state: tauri::State<'_, AppState>, id: i32) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| kg_graph::delete(c, id))?;
    Ok(())
}

#[tauri::command]
pub fn kg_graph_get(state: tauri::State<'_, AppState>, id: i32) -> IpcResult<KgGraph> {
    let store = state.store();
    Ok(store.with_conn(|c| kg_graph::get(c, id))?)
}

#[tauri::command]
pub fn kg_graph_list(state: tauri::State<'_, AppState>) -> IpcResult<Vec<KgGraph>> {
    let store = state.store();
    Ok(store.with_conn(|c| kg_graph::list(c))?)
}

#[derive(Debug, Deserialize, Default)]
pub struct ListKgEdgesRequest {
    pub node_ids: Option<Vec<i32>>,
}

#[tauri::command]
pub fn kg_edge_list(state: tauri::State<'_, AppState>, req: ListKgEdgesRequest) -> IpcResult<Vec<KgEdge>> {
    let store = state.store();
    Ok(store.with_conn(|c| {
        let node_ids = req.node_ids.unwrap_or_default();
        kg_edge::list_by_nodes(c, &node_ids)
    })?)
}

#[tauri::command]
pub fn kg_link_memo(state: tauri::State<'_, AppState>, memo_uid: String, node_id: i32) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| {
        let memo = memo::get(c, &memo::FindMemo { uid: Some(memo_uid.clone()), ..Default::default() })?
            .ok_or_else(|| memos_core::CoreError::NotFound(format!("memo uid {memo_uid}")))?;
        memo_kg_node::link(c, memo.id, node_id)
    })?;
    Ok(())
}

#[tauri::command]
pub fn kg_unlink_memo(state: tauri::State<'_, AppState>, memo_uid: String, node_id: i32) -> IpcResult<()> {
    let store = state.store();
    store.with_conn(|c| {
        let memo = memo::get(c, &memo::FindMemo { uid: Some(memo_uid.clone()), ..Default::default() })?
            .ok_or_else(|| memos_core::CoreError::NotFound(format!("memo uid {memo_uid}")))?;
        memo_kg_node::unlink(c, memo.id, node_id)
    })?;
    Ok(())
}

/// 返回笔记关联的节点：自动匹配（标签交集）∪ 手动关联，去重
#[tauri::command]
pub fn kg_list_memo_nodes(state: tauri::State<'_, AppState>, memo_uid: String) -> IpcResult<Vec<KgNode>> {
    let store = state.store();
    Ok(store.with_conn(|c| {
        let memo_obj = memo::get(c, &memo::FindMemo { uid: Some(memo_uid.clone()), ..Default::default() })?
            .ok_or_else(|| memos_core::CoreError::NotFound(format!("memo uid {memo_uid}")))?;
        let memo_tags = memos_core::markdown::extract_tags(&memo_obj.content);
        // 自动匹配节点
        let mut node_ids = memo_kg_node::find_nodes_by_memo_tags(c, &memo_tags)?;
        // 加入手动关联
        for nid in memo_kg_node::list_by_memo(c, memo_obj.id)? {
            if !node_ids.contains(&nid) {
                node_ids.push(nid);
            }
        }
        if node_ids.is_empty() {
            return Ok(Vec::new());
        }
        kg_node::list(c, &FindKgNode { graph_id: None, parent_id: None, id_list: node_ids })
    })?)
}

/// 返回节点相关的笔记（自动匹配 + 手动关联）
#[tauri::command]
pub fn kg_list_node_memos(state: tauri::State<'_, AppState>, node_id: i32) -> IpcResult<Vec<memo::Memo>> {
    let store = state.store();
    Ok(store.with_conn(|c| {
        let memo_ids = memo_kg_node::find_memos_by_kg_node(c, node_id)?;
        if memo_ids.is_empty() {
            return Ok(Vec::new());
        }
        memo::list(c, &memo::FindMemo { id_list: memo_ids, ..Default::default() })
    })?)
}
