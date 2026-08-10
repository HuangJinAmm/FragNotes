use memos_core::*;
use memos_core::kg_node::{FindKgNode, KgNode, UpsertKgNode};

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
