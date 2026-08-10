use memos_core::*;
use memos_core::kg_node::{FindKgNode, KgNode, UpsertKgNode};
use memos_core::kg_edge::KgEdge;
use memos_core::memo_kg_node;
use memos_core::memo::CreateMemo;
use memos_core::types::Visibility;
use serde_json::json;

fn open_test_store() -> Store {
    Store::open_in_memory().expect("打开内存数据库失败")
}

fn make_node(conn: &rusqlite::Connection, name: &str) -> KgNode {
    kg_node::create(conn, &UpsertKgNode {
        uid: format!("kg-{}", name),
        name: name.to_string(),
        description: String::new(),
        color: String::new(),
        icon: String::new(),
        parent_id: None,
        pos_x: None,
        pos_y: None,
        collapsed: false,
    })
    .expect("创建节点失败")
}

#[test]
fn kg_node_create() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let node = make_node(&conn, "root");
    assert_eq!(node.name, "root");
    assert_eq!(node.uid, "kg-root");
    assert!(node.parent_id.is_none());
    assert!(node.pos_x.is_none());
    assert!(!node.collapsed);
    assert!(node.tags.is_empty());
}

#[test]
fn kg_node_update_and_circular_check() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let parent = make_node(&conn, "parent");
    let child = kg_node::create(&conn, &UpsertKgNode {
        uid: "kg-child".into(),
        name: "child".into(),
        description: String::new(),
        color: String::new(),
        icon: String::new(),
        parent_id: Some(parent.id),
        pos_x: None,
        pos_y: None,
        collapsed: false,
    }).unwrap();

    // 正常更新
    let updated = kg_node::update(&conn, child.id, &UpsertKgNode {
        uid: "kg-child".into(),
        name: "child2".into(),
        description: "desc".into(),
        color: "blue".into(),
        icon: "StarIcon".into(),
        parent_id: Some(parent.id),
        pos_x: Some(10.0),
        pos_y: Some(20.0),
        collapsed: true,
    }).unwrap();
    assert_eq!(updated.name, "child2");
    assert_eq!(updated.color, "blue");
    assert_eq!(updated.pos_x, Some(10.0));
    assert!(updated.collapsed);

    // 循环校验：把 parent 的 parent 设为 child 应失败
    let err = kg_node::update(&conn, parent.id, &UpsertKgNode {
        uid: "kg-parent".into(),
        name: "parent".into(),
        description: String::new(),
        color: String::new(),
        icon: String::new(),
        parent_id: Some(child.id),
        pos_x: None,
        pos_y: None,
        collapsed: false,
    });
    assert!(err.is_err(), "应拒绝循环父子关系");
}

#[test]
fn kg_node_tags_and_position() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let node = make_node(&conn, "n1");

    // set_tags 全量替换
    kg_node::set_tags(&conn, node.id, &["rust".into(), "tauri".into()]).unwrap();
    let tags = kg_node::get_tags(&conn, node.id).unwrap();
    assert_eq!(tags, vec!["rust".to_string(), "tauri".to_string()]);

    // 再次 set_tags 替换为新集合
    kg_node::set_tags(&conn, node.id, &["ai".into()]).unwrap();
    let tags = kg_node::get_tags(&conn, node.id).unwrap();
    assert_eq!(tags, vec!["ai".to_string()]);

    // 位置：None 表示自动布局
    kg_node::set_position(&conn, node.id, Some(1.5), Some(2.5)).unwrap();
    let got = kg_node::get(&conn, node.id).unwrap();
    assert_eq!(got.pos_x, Some(1.5));
    assert_eq!(got.pos_y, Some(2.5));

    kg_node::set_position(&conn, node.id, None, None).unwrap();
    let got = kg_node::get(&conn, node.id).unwrap();
    assert!(got.pos_x.is_none());
    assert!(got.pos_y.is_none());
}

#[test]
fn kg_node_delete_cascades() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let n1 = make_node(&conn, "n1");
    let _n2 = make_node(&conn, "n2");
    kg_node::set_tags(&conn, n1.id, &["t1".into()]).unwrap();

    // 删除 n1
    kg_node::delete(&conn, n1.id).unwrap();

    // 标签应被级联清理
    let tags = kg_node::get_tags(&conn, n1.id).unwrap();
    assert!(tags.is_empty(), "标签应被级联删除");

    // get 应返回 NotFound
    let err = kg_node::get(&conn, n1.id);
    assert!(err.is_err());
}

#[test]
fn kg_edge_create_and_list() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let n1 = make_node(&conn, "n1");
    let n2 = make_node(&conn, "n2");

    let edge = kg_edge::create(&conn, n1.id, n2.id, "related", "关联").unwrap();
    assert_eq!(edge.source_id, n1.id);
    assert_eq!(edge.target_id, n2.id);
    assert_eq!(edge.r#type, "related");
    assert_eq!(edge.label, "关联");

    let edges = kg_edge::list_by_nodes(&conn, &[n1.id, n2.id]).unwrap();
    assert_eq!(edges.len(), 1);
    assert_eq!(edges[0].id, edge.id);
}

#[test]
fn kg_edge_unique_and_delete() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let n1 = make_node(&conn, "n1");
    let n2 = make_node(&conn, "n2");

    let edge = kg_edge::create(&conn, n1.id, n2.id, "related", "").unwrap();
    // 相同 source/target/type 应冲突
    let dup = kg_edge::create(&conn, n1.id, n2.id, "related", "");
    assert!(dup.is_err(), "应拒绝重复边");

    // 不同 type 允许
    let edge2 = kg_edge::create(&conn, n1.id, n2.id, "contains", "");
    assert!(edge2.is_ok());

    // 删除
    kg_edge::delete(&conn, edge.id).unwrap();
    let edges = kg_edge::list_by_nodes(&conn, &[n1.id, n2.id]).unwrap();
    assert_eq!(edges.len(), 1);
}

fn make_memo(conn: &rusqlite::Connection, uid: &str, content: &str) -> i32 {
    let m = memo::create(conn, &CreateMemo {
        uid: uid.into(),
        content: content.into(),
        visibility: Visibility::Private,
        pinned: false,
        payload: json!({}),
        location: None,
        parent_id: None,
    }).unwrap();
    m.id
}

#[test]
fn memo_kg_node_link_and_find() {
    let store = open_test_store();
    let conn = store.lock_conn();

    // memo1 含 #rust 标签，memo2 含 #python 标签
    let m1 = make_memo(&conn, "m1", "学习 #rust 笔记");
    let m2 = make_memo(&conn, "m2", "#python 入门");

    // node1 关联 rust 标签（自动匹配 m1）
    let n1 = make_node(&conn, "rust-node");
    kg_node::set_tags(&conn, n1.id, &["rust".into()]).unwrap();

    // node2 无标签，手动关联 m2
    let n2 = make_node(&conn, "manual-node");
    memo_kg_node::link(&conn, m2, n2.id).unwrap();

    // find_memos_by_kg_node(n1) 应返回 [m1]（标签自动匹配）
    let memos = memo_kg_node::find_memos_by_kg_node(&conn, n1.id).unwrap();
    assert_eq!(memos, vec![m1]);

    // find_memos_by_kg_node(n2) 应返回 [m2]（手动关联）
    let memos = memo_kg_node::find_memos_by_kg_node(&conn, n2.id).unwrap();
    assert_eq!(memos, vec![m2]);

    // list_by_memo(m2) 应返回 [n2.id]
    let nodes = memo_kg_node::list_by_memo(&conn, m2).unwrap();
    assert_eq!(nodes, vec![n2.id]);

    // unlink
    memo_kg_node::unlink(&conn, m2, n2.id).unwrap();
    let nodes = memo_kg_node::list_by_memo(&conn, m2).unwrap();
    assert!(nodes.is_empty());
}

#[test]
fn memo_kg_node_empty_tags() {
    let store = open_test_store();
    let conn = store.lock_conn();
    let n = make_node(&conn, "empty-node");
    let m = make_memo(&conn, "m1", "无标签笔记");

    // 节点无标签、无手动关联 → 空结果
    let memos = memo_kg_node::find_memos_by_kg_node(&conn, n.id).unwrap();
    assert!(memos.is_empty());

    // 手动关联后返回
    memo_kg_node::link(&conn, m, n.id).unwrap();
    let memos = memo_kg_node::find_memos_by_kg_node(&conn, n.id).unwrap();
    assert_eq!(memos, vec![m]);
}
