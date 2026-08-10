-- 知识图谱节点
CREATE TABLE IF NOT EXISTS kg_node (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    parent_id INTEGER DEFAULT NULL,
    pos_x REAL DEFAULT NULL,
    pos_y REAL DEFAULT NULL,
    collapsed INTEGER NOT NULL DEFAULT 0,
    created_ts BIGINT NOT NULL DEFAULT (strftime('%s','now')),
    updated_ts BIGINT NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (parent_id) REFERENCES kg_node(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_node_parent ON kg_node(parent_id);

-- 节点间连线（边）
CREATE TABLE IF NOT EXISTS kg_edge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'related',
    label TEXT NOT NULL DEFAULT '',
    created_ts BIGINT NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(source_id, target_id, type),
    FOREIGN KEY (source_id) REFERENCES kg_node(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES kg_node(id) ON DELETE CASCADE
);

-- 节点-标签关联
CREATE TABLE IF NOT EXISTS kg_node_tag (
    node_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY(node_id, tag),
    FOREIGN KEY (node_id) REFERENCES kg_node(id) ON DELETE CASCADE
);

-- 笔记-节点手动关联
CREATE TABLE IF NOT EXISTS memo_kg_node (
    memo_id INTEGER NOT NULL,
    node_id INTEGER NOT NULL,
    created_ts BIGINT NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY(memo_id, node_id),
    FOREIGN KEY (memo_id) REFERENCES memo(id) ON DELETE CASCADE,
    FOREIGN KEY (node_id) REFERENCES kg_node(id) ON DELETE CASCADE
);
