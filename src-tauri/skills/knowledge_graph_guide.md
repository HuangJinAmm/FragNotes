---
id: b-knowledge-graph-guide
name: 知识图谱构建指南
description: 指导 AI agent 使用知识图谱工具创建图谱、节点和关系的最佳实践
tools: [list_kg_graphs, create_kg_graph, list_kg_nodes, create_kg_node, set_kg_node_tags, link_kg_nodes]
---

# 知识图谱构建指南

## 工具总览

| 工具 | 用途 |
|---|---|
| `list_kg_graphs` | 列出所有知识图谱 |
| `create_kg_graph` | 创建新图谱 |
| `list_kg_nodes` | 列出图谱中的节点 |
| `create_kg_node` | 创建节点（含标签、父节点、颜色、图标） |
| `set_kg_node_tags` | 修改节点标签 |
| `link_kg_nodes` | 在两个节点间创建关系边 |

## 典型工作流

### 1. 创建新知识图谱

```
用户："帮我建一个机器学习知识体系图谱"
→ create_kg_graph(name="机器学习知识体系", description="涵盖 ML 核心概念与关联")
→ 返回 graph_id
```

### 2. 构建层级节点结构

用 `parent_id` 建立树形层级：

```
根节点：机器学习 (parent_id=null)
  ├── 监督学习 (parent_id=根节点id)
  │     ├── 分类 (parent_id=监督学习id)
  │     └── 回归 (parent_id=监督学习id)
  ├── 无监督学习 (parent_id=根节点id)
  │     ├── 聚类 (parent_id=无监督学习id)
  │     └── 降维 (parent_id=无监督学习id)
  └── 强化学习 (parent_id=根节点id)
```

创建子节点时传入父节点 id：
```
create_kg_node(graph_id=X, name="监督学习", parent_id=根节点id)
```

### 3. 用标签关联笔记

节点标签会**自动关联**带相同 `#tag` 的笔记。标签不带 `#` 前缀。

```
create_kg_node(graph_id=X, name="RAG", tags=["RAG"], parent_id=Y)
```

这样所有包含 `#RAG` 标签的笔记会自动显示为该节点的子节点。

### 4. 用边建立跨层级关系

当两个节点不在同一父级下但有概念关联时，用 `link_kg_nodes` 创建边：

```
link_kg_nodes(source_id=分类节点id, target_id=逻辑回归节点id, edge_type="derived")
```

边类型：
- `related`（相关）— 一般性关联
- `contains`（包含）— 整体与部分
- `derived`（派生）— 派生/衍生关系

## 最佳实践

1. **先规划再创建**：复杂图谱先用 `update_plan` 制定步骤
2. **层级优先**：优先用 `parent_id` 建立层级，跨层级关联才用 `link_kg_nodes`
3. **标签与笔记对齐**：标签名应与笔记中 `#tag` 一致（不带 `#`）
4. **节点命名简短**：节点名称控制在 2-10 字，描述放 `description` 字段
5. **颜色语义化**：可用颜色区分节点类别（如 blue=概念、green=技术、red=问题）

## 示例：从用户笔记构建知识图谱

```
用户："根据我的笔记帮我建一个 RAG 相关的知识图谱"

步骤：
1. list_tags → 查看用户现有标签
2. list_memos(query="RAG") → 了解用户的 RAG 笔记内容
3. create_kg_graph(name="RAG 知识体系")
4. 创建根节点：create_kg_node(graph_id=X, name="RAG", tags=["RAG"])
5. 创建子节点：create_kg_node(graph_id=X, name="向量检索", tags=["向量检索"], parent_id=根id)
6. 创建子节点：create_kg_node(graph_id=X, name="Embedding", tags=["Embedding"], parent_id=根id)
7. 建立关联：link_kg_nodes(source_id=向量检索id, target_id=Embeddingid, edge_type="related")
```
