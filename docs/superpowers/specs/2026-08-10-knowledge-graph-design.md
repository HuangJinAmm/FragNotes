# 知识图谱模块 设计

> **状态**：已批准，待写实现计划
> **日期**：2026-08-10
> **作者**：brainstorming 产物

## 目标

为 LocalFragNote 增加知识图谱模块，以图形节点方式展示知识结构与关联：

1. **图形化节点展示**：用 React Flow 画布渲染节点（名称+描述+颜色+图标），节点间可建立带类型标签的连线
2. **节点 CRUD**：新建、编辑、删除节点；支持层级父子结构（折叠/展开）
3. **节点标签关联**：每个节点关联一组标签（独立于笔记 `#tag`）
4. **笔记中查看节点**：在笔记详情侧栏展示关联的知识图谱节点（自动按标签匹配 + 手动关联）
5. **选中节点展示相关笔记**：在图谱页选中节点时，右侧分栏展示与该节点标签交集的笔记列表

## 非目标

- 不实现节点间路径查找、聚类分析等图论算法
- 不实现节点/边的版本历史
- 不实现多工作空间间共享知识图谱（KG 随工作空间 memos.db 隔离）
- 不实现 AI 自动从笔记内容生成节点（未来可扩展）
- 不实现节点级权限控制（本地单用户）

## 技术选型

| 维度 | 选择 | 理由 |
|------|------|------|
| 图形库 | `@xyflow/react`（React Flow） | React 生态主流，自定义节点用 React 组件，内置拖拽/平移/缩放 |
| 自动布局 | `@dagrejs/dagre` | 层次布局适配父子结构，轻量 |
| 渲染 | React 19 + 现有 Radix/Tailwind | 节点卡片复用现有 UI 组件 |
| 数据存储 | SQLite（memos.db，工作空间隔离） | 与现有 memo/tag/review 一致 |

## 数据模型

新增迁移 `core/migrations/V12__add_knowledge_graph.sql`：

```sql
-- 知识图谱节点
CREATE TABLE IF NOT EXISTS kg_node (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',        -- 调色板 key，如 'blue' 'green'，空则用默认
    icon TEXT NOT NULL DEFAULT '',         -- lucide 图标名，如 'NetworkIcon'
    parent_id INTEGER DEFAULT NULL,        -- 父节点（层级结构）
    pos_x REAL DEFAULT NULL,               -- 手动覆盖坐标；NULL 表示用自动布局
    pos_y REAL DEFAULT NULL,
    collapsed INTEGER NOT NULL DEFAULT 0,  -- 0=展开子节点 1=折叠
    created_ts BIGINT NOT NULL DEFAULT (strftime('%s','now')),
    updated_ts BIGINT NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (parent_id) REFERENCES kg_node(id) ON DELETE SET NULL
);
CREATE INDEX idx_kg_node_parent ON kg_node(parent_id);

-- 节点间连线（边）
CREATE TABLE IF NOT EXISTS kg_edge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'related',  -- 预设 'contains' 'related' 'derived'，允许自由输入自定义类型
    label TEXT NOT NULL DEFAULT '',        -- 边上显示文字
    created_ts BIGINT NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(source_id, target_id, type),
    FOREIGN KEY (source_id) REFERENCES kg_node(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES kg_node(id) ON DELETE CASCADE
);

-- 节点-标签关联（独立于 memo 的 #tag，是节点的标签维度）
CREATE TABLE IF NOT EXISTS kg_node_tag (
    node_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY(node_id, tag),
    FOREIGN KEY (node_id) REFERENCES kg_node(id) ON DELETE CASCADE
);

-- 笔记-节点手动关联（自动匹配走标签交集，此表存额外的手动关联）
CREATE TABLE IF NOT EXISTS memo_kg_node (
    memo_id INTEGER NOT NULL,
    node_id INTEGER NOT NULL,
    created_ts BIGINT NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY(memo_id, node_id),
    FOREIGN KEY (memo_id) REFERENCES memo(id) ON DELETE CASCADE,
    FOREIGN KEY (node_id) REFERENCES kg_node(id) ON DELETE CASCADE
);
```

### 设计要点

1. **`kg_node_tag` 与现有 `tag` 表的关系**：`tag` 表是 memo `#tag` 的索引缓存（单一真相源在 markdown content）。`kg_node_tag` 是节点独立维护的标签集合，不复用 `tag` 表，因为节点可能关联尚未在任何 memo 中使用的标签（规划未来笔记的主题）。

2. **`memo_kg_node` 的角色**：仅存"手动额外关联"。自动匹配（笔记 `#tag` ∩ 节点 `kg_node_tag`）在查询时实时计算，不落表，避免数据冗余与同步问题。这与 `tag.rs` 的"content 是真相源、tag 表是缓存"哲学一致。

3. **`parent_id` 与 `kg_edge` 并存**：`parent_id` 表达层级包含关系（影响布局与折叠），`kg_edge` 表达任意语义关系（带类型标签）。两者不重叠：父子关系不重复建边，布局时优先按 `parent_id` 做 dagre 层次布局，`kg_edge` 作为附加连线渲染。

4. **`pos_x/pos_y` 可空**：NULL = 跟随自动布局；非 NULL = 用户拖拽后的手动覆盖。"重置布局"按钮清空所有节点的 pos_x/pos_y。

5. **`collapsed`**：折叠状态持久化，下次打开恢复。

6. **删除级联**：节点删除 → 关联的 edge、kg_node_tag、memo_kg_node 自动清理（FK CASCADE）；memo 删除 → memo_kg_node 清理。

## 后端模块

### core 层新增模块

参照现有 `memo_relation.rs` 的风格，新增 3 个模块文件：

**`core/src/kg_node.rs`** — 节点 CRUD

```rust
pub struct KgNode {
    pub id: i32,
    pub uid: String,
    pub name: String,
    pub description: String,
    pub color: String,
    pub icon: String,
    pub parent_id: Option<i32>,
    pub pos_x: Option<f64>,
    pub pos_y: Option<f64>,
    pub collapsed: bool,
    pub created_ts: i64,
    pub updated_ts: i64,
    pub tags: Vec<String>,      // 查询时 JOIN kg_node_tag 填充
}

pub struct UpsertKgNode { /* name, description, color, icon, parent_id, pos_x, pos_y, collapsed */ }
pub struct FindKgNode { parent_id: Option<Option<i32>>, /* None=全部, Some(None)=根, Some(Some(id))=指定父 */ }

pub fn create(conn, &UpsertKgNode) -> CoreResult<KgNode>
pub fn update(conn, id, &UpsertKgNode) -> CoreResult<KgNode>
pub fn delete(conn, id) -> CoreResult<()>           // FK CASCADE 自动清理 edge/tag/memo_kg_node
pub fn get(conn, id) -> CoreResult<KgNode>
pub fn list(conn, &FindKgNode) -> CoreResult<Vec<KgNode>>
pub fn set_tags(conn, node_id, &[String]) -> CoreResult<()>   // 全量替换
pub fn set_position(conn, node_id, x: Option<f64>, y: Option<f64>) -> CoreResult<()>
pub fn set_collapsed(conn, node_id, collapsed: bool) -> CoreResult<()>
```

**`core/src/kg_edge.rs`** — 边 CRUD

```rust
pub struct KgEdge {
    pub id: i32,
    pub source_id: i32,
    pub target_id: i32,
    pub r#type: String,
    pub label: String,
    pub created_ts: i64,
}

pub fn create(conn, source_id, target_id, type, label) -> CoreResult<KgEdge>
pub fn update(conn, id, type, label) -> CoreResult<KgEdge>
pub fn delete(conn, id) -> CoreResult<()>
pub fn list_by_nodes(conn, &[i32]) -> CoreResult<Vec<KgEdge>>   // 给定节点集，返回涉及的边
```

**`core/src/memo_kg_node.rs`** — 笔记-节点手动关联

```rust
pub fn link(conn, memo_id, node_id) -> CoreResult<()>
pub fn unlink(conn, memo_id, node_id) -> CoreResult<()>
pub fn list_by_memo(conn, memo_id) -> CoreResult<Vec<i32>>      // 手动关联的节点 id
pub fn list_by_node(conn, node_id) -> CoreResult<Vec<i32>>      // 手动关联的 memo id
```

**`core/src/lib.rs`** 导出新模块，`core/src/store.rs` 无需改动（Store 只持 Connection，模块函数以 `&Connection` 为参数，与 `memo_relation.rs` 一致）。

### 节点-笔记匹配查询

核心查询：给定节点，返回相关笔记。放在 `memo_kg_node.rs`：

```rust
/// 返回与节点相关的笔记 id：标签交集（自动匹配）∪ 手动关联
pub fn find_memos_by_kg_node(conn, node_id) -> CoreResult<Vec<i32>> {
    // 1. 取节点标签
    let node_tags: HashSet<String> = kg_node::get_tags(conn, node_id)?;
    // 2. 从所有 NORMAL 状态 memo 的 content 中提取 #tag，与 node_tags 求交集
    //    复用 markdown::extract_tags，全表扫描（与现有 list_tags 同策略）
    // 3. UNION 手动关联 memo_kg_node.list_by_node
    // 4. 去重返回
}
```

**性能考量**：与 `tag.rs::list_tags` 同样的全表扫描策略，对本地单用户场景足够。若未来 memo 量大，可加 `memo_tag` 索引表（类似 `tag` 表的反向索引），但当前不做（YAGNI）。

### Tauri commands

新增 `src-tauri/src/commands/kg.rs`，参照 `memo_relation.rs` 命令风格：

```rust
#[tauri::command]
pub fn kg_node_create(state, upsert: UpsertKgNode) -> Result<KgNode, String>
pub fn kg_node_update(state, id: i32, upsert: UpsertKgNode) -> Result<KgNode, String>
pub fn kg_node_delete(state, id: i32) -> Result<(), String>
pub fn kg_node_list(state, find: FindKgNode) -> Result<Vec<KgNode>, String>
pub fn kg_node_set_tags(state, id: i32, tags: Vec<String>) -> Result<(), String>
pub fn kg_node_set_position(state, id: i32, x: Option<f64>, y: Option<f64>) -> Result<(), String>
pub fn kg_node_set_collapsed(state, id: i32, collapsed: bool) -> Result<(), String>

pub fn kg_edge_create(state, source_id, target_id, type, label) -> Result<KgEdge, String>
pub fn kg_edge_update(state, id, type, label) -> Result<KgEdge, String>
pub fn kg_edge_delete(state, id: i32) -> Result<(), String>

pub fn kg_link_memo(state, memo_id, node_id) -> Result<(), String>
pub fn kg_unlink_memo(state, memo_id, node_id) -> Result<(), String>
pub fn kg_list_memo_nodes(state, memo_id) -> Result<Vec<KgNode>, String>  // 含自动+手动
pub fn kg_list_node_memos(state, node_id) -> Result<Vec<Memo>, String>   // 图谱页右侧用
```

注册到 `src-tauri/src/lib.rs` 的 `invoke_handler!`。

## 前端架构

### 路由与导航

- 新增路由 `/knowledge-graph`，添加到 `src/router/routes.ts` 的 `ROUTES`
- `src/components/Navigation.tsx` 的 `primaryNavLinks` 增加"知识图谱"项，图标用 `Share2Icon` 或 `NetworkIcon`，位于 review 之后

### 目录结构

```
src/components/KnowledgeGraph/
├── KnowledgeGraphPage.tsx       # 页面入口，左右分栏
├── KgCanvas.tsx                  # React Flow 画布
├── KgNodeCard.tsx               # 自定义节点（名称+图标+颜色+标签预览）
├── KgEdgeWithLabel.tsx          # 带类型标签的边
├── KgNodeDetailPanel.tsx        # 节点详情/编辑面板（右侧或抽屉）
├── KgNodeEditDialog.tsx         # 新建/编辑节点对话框
├── KgTagEditor.tsx              # 节点标签编辑器（复用现有 tag 逻辑）
├── KgMemoListPanel.tsx          # 选中节点时右侧展示相关笔记
├── KgToolbar.tsx                # 顶部工具栏（新建节点/重置布局/筛选）
├── layout.ts                    # dagre 自动布局
├── constants.ts                 # 颜色调色板（blue/green/amber/red/purple/cyan/pink，空=默认）、边类型预设（contains/related/derived）、默认图标
├── types.ts                     # KgNode/KgEdge 前端类型
├── index.ts
└── hooks.ts                     # React Query 封装
```

**用户偏好对齐**：`KgMemoListPanel` 在窄屏（移动端）下用左右滑动卡片轮播展示笔记，符合用户偏好"竖向卡片+左右滑动"。桌面端用列表。

### React Query hooks

```ts
useKgNodes()                    // GET 全部节点 + 标签
useKgEdges()                    // GET 全部边
useCreateKgNode() / useUpdateKgNode() / useDeleteKgNode()
useSetKgNodeTags() / useSetKgNodePosition() / useSetKgNodeCollapsed()
useCreateKgEdge() / useUpdateKgEdge() / useDeleteKgEdge()
useKgNodeMemos(nodeId)          // 选中节点时拉取相关笔记
useLinkMemoToNode() / useUnlinkMemoFromNode()
useMemoKgNodes(memoId)          // 笔记详情侧栏用
```

### MemoDetailSidebar 集成

在 `src/components/MemoDetailSidebar/MemoDetailSidebar.tsx` 新增一个 `SidebarSection`，展示该笔记关联的知识图谱节点：
- 自动匹配节点（标签交集）+ 手动关联节点
- 点击节点跳转到 `/knowledge-graph?select=<nodeId>`
- 提供"关联节点"按钮打开选择器

## 交互流程

### 知识图谱页面布局

```
┌─────────────────────────────────────────────────────────────────┐
│ [KgToolbar] 新建节点 │ 重置布局 │ 筛选标签 ▼            🔍搜索节点│
├──────────────────────────────────────┬──────────────────────────┤
│                                      │ [右侧面板]               │
│                                      │                          │
│         React Flow 画布              │ ┌── 未选中时 ──┐         │
│                                      │ │ 图谱统计/说明│         │
│   ◯ 节点A ──包含──> ◯ 节点B          │ └──────────────┘         │
│      │                               │                          │
│     相关                             │ ┌── 选中节点时 ──┐         │
│      ↓                               │ │ 节点信息+编辑 │         │
│   ◯ 节点C                            │ │ 节点标签      │         │
│                                      │ │ 相关笔记列表  │         │
│   (拖拽/缩放/平移)                    │ │ (桌面列表/    │         │
│                                      │ │  移动端卡片)  │         │
│                                      │ └──────────────┘         │
└──────────────────────────────────────┴──────────────────────────┘
```

- 桌面端：左右分栏，画布占 70%，右侧 30%
- 移动端：全屏画布，点击节点底部弹出 Sheet 面板（复用 `src/components/ui/sheet.tsx`）

### 节点操作流程

**新建节点**：
1. 工具栏"新建节点" → 弹出 `KgNodeEditDialog`
2. 填写名称（必填）、描述、颜色（调色板）、图标（lucide 名）、父节点（可选下拉）
3. 标签编辑（逗号分隔输入，复用 `KgTagEditor`）
4. 保存 → 后端 `kg_node_create` + `kg_node_set_tags` → 画布新增节点（位置用自动布局计算）

**编辑节点**：
- 双击节点 → 打开 `KgNodeEditDialog` 预填
- 或在右侧面板点"编辑"按钮

**删除节点**：
- 节点右键菜单/详情面板"删除" → `ConfirmDialog`（复用 `src/components/ConfirmDialog`）确认 → 后端 CASCADE 清理
- 删除前若有关联笔记（手动关联），提示"该节点关联 N 篇笔记，删除后自动解除关联"

**拖拽节点**：
- 拖动结束 → `kg_node_set_position(id, x, y)` 持久化
- "重置布局"按钮 → 批量 `set_position(id, NULL, NULL)` → 重新 dagre 布局

**折叠/展开子节点**：
- 节点上的 ▶/▼ 按钮 → `kg_node_set_collapsed` → 隐藏后代节点与相关边

### 边操作流程

**创建边**：
- React Flow 的连接手柄：从节点边缘拖出连线到目标节点 → 弹出小对话框选 type（预设 contains/related/derived 下拉 + 允许自由输入自定义类型）+ 可选 label → `kg_edge_create`

**编辑/删除边**：
- 点击边选中 → 右侧面板或浮层显示 type/label 编辑入口
- 删除键或按钮 → `kg_edge_delete`

### 笔记-节点关联流程（在笔记详情侧栏）

```
[MemoDetailSidebar]
├── 大纲
├── 创建时间
├── 属性徽章
├── 标签
└── 知识图谱节点 (新增) ──┬─ 自动匹配(标签交集): [节点A] [节点C]
                          │  点击 → /knowledge-graph?select=A
                          ├─ 手动关联: [节点B]
                          │  点击 → /knowledge-graph?select=B
                          └─ [+ 关联节点] 按钮 → 弹出节点选择器
                                              → kg_link_memo
```

### 选中节点展示笔记（图谱页右侧）

- 调 `kg_list_node_memos(nodeId)` → 返回自动匹配 + 手动关联的去重笔记列表
- 桌面：列表展示，复用 `src/components/MemoPreview` 或简化卡片
- 移动：水平滑动卡片（用户偏好）
- 点击笔记项 → 跳转 `/memos/:uid`（复用现有路由）

## 自动布局算法

使用 `dagre` 库（npm `@dagrejs/dagre`）：

```ts
// layout.ts
import dagre from '@dagrejs/dagre';

export function layoutGraph(nodes, edges, direction = 'TB') {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 50, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  
  nodes.forEach(n => g.setNode(n.id, { width: 180, height: 80 }));
  // 父子关系优先作为 dagre 边
  nodes.forEach(n => {
    if (n.parent_id) g.setEdge(n.parent_id, n.id);
  });
  // kg_edge 也加入布局（弱影响）
  edges.forEach(e => {
    if (!hasParentEdge(e)) g.setEdge(e.source_id, e.target_id);
  });
  
  dagre.layout(g);
  return nodes.map(n => {
    const pos = g.node(n.id);
    // 用户手动覆盖优先
    return { ...n, position: n.pos_x != null ? { x: n.pos_x, y: n.pos_y } : { x: pos.x, y: pos.y } };
  });
}
```

折叠时：移除折叠节点的后代再布局。

## 错误处理与边界

- **循环父子关系**：`kg_node_update` 校验 `parent_id` 不能设为自身或后代 id，返回错误"不能将节点的父级设为自身或后代"
- **孤儿边**：FK CASCADE 已处理；前端额外校验连线两端节点存在
- **空图谱**：画布显示空状态（复用 `src/components/Placeholder` 风格），引导新建首个节点
- **大量节点**：React Flow 内置视口裁剪，性能可接受；超 200 节点时考虑虚拟化（YAGNI，暂不做）
- **自动匹配无结果**：右侧面板显示"暂无相关笔记"，引导编辑节点标签

## 测试策略

### 单元测试

**`core/src/kg_node.rs`**：
- `test_create_node`：创建节点并验证字段
- `test_update_node`：更新节点字段
- `test_delete_node_cascade`：删除节点后验证 edge/tag/memo_kg_node 被级联清理
- `test_set_tags_replace`：set_tags 全量替换标签
- `test_set_position_null`：set_position(None) 表示用自动布局
- `test_circular_parent_rejected`：将 parent_id 设为后代 id 应被拒绝

**`core/src/kg_edge.rs`**：
- `test_create_edge`：创建边
- `test_unique_constraint`：相同 source/target/type 组合应冲突
- `test_list_by_nodes`：给定节点集返回涉及的边

**`core/src/memo_kg_node.rs`**：
- `test_link_unlink`：关联与解除关联
- `test_find_memos_by_node`：标签交集 + 手动关联的去重结果
- `test_find_memos_empty_tags`：节点无标签时仅返回手动关联

## 文件清单

### 新增文件

**后端 Rust：**
- `core/migrations/V12__add_knowledge_graph.sql` — 建表迁移
- `core/src/kg_node.rs` — 节点 CRUD
- `core/src/kg_edge.rs` — 边 CRUD
- `core/src/memo_kg_node.rs` — 笔记-节点关联 + 匹配查询
- `src-tauri/src/commands/kg.rs` — Tauri 命令

**前端：**
- `src/components/KnowledgeGraph/` 下 14 个文件（见前端架构目录结构）
- `src/pages/KnowledgeGraph.tsx` — 页面包装

### 修改文件

- `core/src/lib.rs` — 导出 kg_node/kg_edge/memo_kg_node 模块
- `src-tauri/src/lib.rs` — 注册 kg 命令
- `src-tauri/src/commands/mod.rs` — 导出 kg 模块
- `src/router/routes.ts` — 新增 KG 路由
- `src/router/index.tsx` — 懒加载 KG 页面
- `src/components/Navigation.tsx` — 新增导航项
- `src/components/MemoDetailSidebar/MemoDetailSidebar.tsx` — 新增 KG 节点区块
- `src/locales/zh-Hans.json` + `src/locales/en.json` — i18n 键
- `package.json` — 新增 `@xyflow/react` + `@dagrejs/dagre` 依赖

## 不变的部分

- 现有 memo/tag/relation/review 业务逻辑不受影响
- AI Agent、LAN、embedding、workspace 等模块不受影响
- 现有路由、导航结构保持不变（仅新增 KG 项）
- 现有 MemoDetailSidebar 区块保持不变（仅新增 KG 节点区块）
