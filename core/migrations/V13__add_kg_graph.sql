-- 知识图谱顶层实体：一个图谱包含一棵节点树
CREATE TABLE IF NOT EXISTS kg_graph (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    created_ts BIGINT NOT NULL DEFAULT (strftime('%s','now')),
    updated_ts BIGINT NOT NULL DEFAULT (strftime('%s','now'))
);

-- 插入默认图谱（id=1），用于归属现有节点
INSERT INTO kg_graph (uid, name, description, color, icon)
VALUES ('default-kg-graph', '主图谱', '默认知识图谱', '', '');

-- kg_node 增加 graph_id 列，现有节点归入默认图谱（id=1）
ALTER TABLE kg_node ADD COLUMN graph_id INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_kg_node_graph ON kg_node(graph_id);
