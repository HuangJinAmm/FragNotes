# 可配置工作目录 + 多工作空间切换 设计

> **状态**：已批准，待写实现计划
> **日期**：2026-07-25
> **作者**：brainstorming 产物

## 目标

将应用硬编码的 `~/localFragNote` 数据存储位置改为配置式，支持：

1. **用户自定义数据位置**：用户可自由选择数据存放路径（U盘、自定义文件夹等）
2. **多工作空间切换**：支持多个独立笔记库，启动时可切换（如"工作笔记"、"个人笔记"）
3. **笔记数据隔离，配置共享**：笔记数据（memos.db + attachments）随工作空间隔离；embedding 模型、AI Provider、MCP、LAN 身份等共享

## 非目标

- 不实现笔记数据迁移（旧 `~/localFragNote` 数据保留不动，用户从空白开始）
- 不实现工作空间热切换（切换工作空间需重启应用）
- 不实现工作空间级别 AI Provider/MCP/工具配置隔离（这些是共享的）

## 目录结构

### 引导目录（共享配置层）

通过 `tauri::Manager::path().app_config_dir()` 获取：
- Windows: `%APPDATA%\LocalFragNote\`
- macOS: `~/Library/Application Support/LocalFragNote/`
- Linux: `~/.config/LocalFragNote/`

```
<app_config_dir>/
├── workspaces.json              # 工作空间索引 + active workspace id
├── app_config.db                # 共享配置 SQLite（拆自原 memos.db）
├── models/                      # embedding 模型（共享）
│   └── all-MiniLM-L6-v2/
│       ├── model.onnx
│       └── tokenizer.json
└── lan_identity.key             # LAN 身份私钥（共享）
```

### 工作空间目录（笔记隔离层）

用户自选路径，包含该工作空间独立的笔记数据：

```
<用户选的路径，如 D:\MyNotes\>/
├── memos.db                     # 该工作空间的笔记 + 向量索引
└── attachments/                 # 该工作空间的附件
    └── <uid>_<filename>
```

## workspaces.json 数据结构

```json
{
  "version": 1,
  "active_workspace_id": "ws-a3f8e1d2-9b4c-4e7a-8f2d-1c3e5a7b9d0e",
  "workspaces": [
    {
      "id": "ws-a3f8e1d2-9b4c-4e7a-8f2d-1c3e5a7b9d0e",
      "name": "我的工作笔记",
      "path": "D:/Notes/Work",
      "created_ts": 1721958400
    }
  ]
}
```

### 字段说明

- `version`: schema 版本号，便于未来迁移
- `active_workspace_id`: 当前活动工作空间 ID，启动时读取决定加载哪个 memos.db
- `workspaces[]`: 工作空间列表
  - `id`: `ws-` 前缀 + UUID v4，避免与 memo UID 冲突
  - `name`: 显示名，用户可改
  - `path`: 工作空间文件夹绝对路径
  - `created_ts`: 创建时间戳（Unix 秒）

### 工作空间校验规则

启动时打开 active workspace 前校验：

1. `path` 存在且是目录
2. `path/memos.db` 存在（首次创建时新建）
3. 路径可写

校验失败时：
- 路径不存在/不是目录 → 标记工作空间为 invalid，UI 显示警告图标，提示用户重新定位或删除
- memos.db 不存在 → 自动初始化新 memos.db（跑迁移）
- 路径不可写 → 标记 invalid

### 并发与原子写入

- 写入采用 `.tmp` 临时文件 + `rename` 原子替换，避免崩溃损坏
- 通过 `Mutex<WorkspaceRegistry>` 在 AppState 中保护内存副本
- 启动时一次读取，操作（增/删/改 active）时同步落盘

## 数据库拆分

### 拆分映射

原 `memos.db` 的表分两类：

**移到 `app_config.db`（共享配置）**：
- `app_setting` — 共享配置 key：`ai_providers`、`mcp_config`、`lan_enabled`、`lan_acl_rules`、`storage_config`
- `instance_setting` — 全部移过来（含 `lan_display_name`）
- `tool` — 用户自定义工具表（工具定义与具体笔记无关，跨工作空间共享）

**保留在 `memos.db`（每工作空间独立）**：
- `memo`、`memo_organizer`、`memo_relation`
- `attachment`、`resource`
- `memo_vec`（向量索引）
- `memo_fts`（FTS5）
- `tag`
- `review_card`、`review_deck`
- `memo_property`
- `migration_history`（refinery 表，每个 db 独立维护）

### storage_config 路径解析

`StorageConfig.local_storage_path` 移到 `app_config.db` 共享，但路径解析改为相对工作空间根目录：

- 相对路径（如 `"attachments"`）→ `<workspace.path>/attachments`
- 绝对路径 → 直接使用

这样工作空间切换时附件策略保持一致，但实际位置随工作空间变化。

### 迁移文件

**`app_config.db` 迁移**：
- `core/migrations/config/V1__initial_config_schema.sql`
  ```sql
  CREATE TABLE IF NOT EXISTS app_setting (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS instance_setting (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT
  );
  CREATE TABLE IF NOT EXISTS tool (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      permission TEXT NOT NULL,
      description TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
  );
  ```

**`memos.db` 迁移**：
- 保留现有 V1~V10 不变（兼容旧库）
- 新增 `V11__drop_shared_config_tables.sql`
  ```sql
  DROP TABLE IF EXISTS app_setting;
  DROP TABLE IF EXISTS instance_setting;
  DROP TABLE IF EXISTS tool;
  ```

### 迁移执行逻辑

- `app_config.db`：用独立的 refinery runner 连接到 `<app_config_dir>/app_config.db`
- `memos.db`：跑现有 V1~V11，对旧 memos.db 兼容（V11 会删掉 app_setting/instance_setting/tool 表）
- 新建 memos.db 时 V1~V10 建表后 V11 立即删掉，净结果是共享配置表不存在

### 旧用户首次启动

- 检测 `~/localFragNote` 旧数据保留不动
- 用户选工作空间目录 → 新建空 memos.db + 空 app_config.db
- 旧的 `~/localFragNote` 数据成为孤儿，用户可自行删除
- 用户需要重新配置 AI Provider、MCP、工具等共享配置

## 核心模块改动

### Store 拆分（core/src/store.rs）

将现有 `Store` 拆为两部分：

```rust
// core/src/config_store.rs（新增）
pub struct ConfigStore {
    conn: Mutex<Connection>,
    setting: AppSettingStore,
    instance_setting: InstanceSettingStore,
    tool: ToolStore,
}

impl ConfigStore {
    pub fn open(path: &Path) -> Result<Self>;
    pub fn setting(&self) -> &AppSettingStore;
    pub fn instance_setting(&self) -> &InstanceSettingStore;
    pub fn tool(&self) -> &ToolStore;
}

// core/src/store.rs（精简后）
pub struct Store {
    conn: Mutex<Connection>,
    memo: MemoStore,
    tag: TagStore,
    attachment: AttachmentStore,
    resource: ResourceStore,
    relation: MemoRelationStore,
    review_card: ReviewCardStore,
    // 移除 setting 和 tool 字段
}
```

### AppState 改造（src-tauri/src/state.rs）

```rust
pub struct AppState {
    pub store: Mutex<Store>,                    // memos.db（工作空间隔离）
    pub config_store: Mutex<ConfigStore>,       // app_config.db（共享）
    pub attachments_dir: PathBuf,               // workspace.path/attachments
    pub workspace_registry: Mutex<WorkspaceRegistry>,  // workspaces.json
    pub config_dir: PathBuf,                    // 引导目录，供 embedding/lan 模块使用
    pub shutdown: AtomicBool,
}
```

所有原本通过 `state.store().setting.app.get(...)` 访问的代码改为 `state.config_store.lock().setting().app.get(...)`。

所有原本通过 `state.store().tool.list(...)` 访问的代码改为 `state.config_store.lock().tool().list(...)`。

### 工作空间注册表模块（src-tauri/src/workspace.rs 新增）

```rust
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub created_ts: i64,
}

pub struct WorkspaceRegistry {
    pub version: u32,
    pub active_workspace_id: Option<String>,
    pub workspaces: Vec<Workspace>,
}

impl WorkspaceRegistry {
    pub fn load(config_dir: &Path) -> Result<Self>;
    pub fn save(&self, config_dir: &Path) -> Result<()>;
    pub fn add(&mut self, name: &str, path: PathBuf) -> &Workspace;
    pub fn remove(&mut self, id: &str) -> Result<()>;
    pub fn rename(&mut self, id: &str, new_name: &str) -> Result<()>;
    pub fn set_active(&mut self, id: &str) -> Result<()>;
    pub fn get_active(&self) -> Option<&Workspace>;
    pub fn validate(&self, ws: &Workspace) -> WorkspaceStatus;
}

pub enum WorkspaceStatus {
    Valid,
    PathNotFound,
    PathNotDir,
    NotWritable,
    DbCorrupted(String),
}
```

### main.rs 启动流程

```rust
setup: |app_handle, _| {
    // 1. 计算引导目录
    let config_dir = app_handle.path().app_config_dir()?;
    std::fs::create_dir_all(&config_dir)?;
    
    // 2. 打开 app_config.db
    let config_db_path = config_dir.join("app_config.db");
    let config_store = ConfigStore::open(&config_db_path)?;
    
    // 3. 加载 WorkspaceRegistry
    let mut registry = WorkspaceRegistry::load(&config_dir)?;
    
    // 4. 决定 active workspace
    let active_ws = match registry.get_active() {
        Some(ws) if matches!(registry.validate(ws), WorkspaceStatus::Valid) => ws.clone(),
        _ => {
            // 无有效 active workspace：注册一个 placeholder AppState
            // AppState.store 用临时 in-memory SQLite（:memory:）初始化
            // 前端通过 show_workspace_picker 事件接管，路由到 /workspace-picker
            let placeholder_store = Store::open_in_memory()?;
            let state = AppState {
                store: Mutex::new(placeholder_store),
                config_store: Mutex::new(config_store),
                attachments_dir: PathBuf::new(),  // 空路径，前端不应触发文件操作
                workspace_registry: Mutex::new(registry),
                config_dir: config_dir.clone(),
                shutdown: AtomicBool::new(false),
            };
            app_handle.manage(state);
            // 在 app setup 完成后通过 emit 显示 WorkspacePicker
            tauri::async_runtime::spawn(async move {
                let _ = app_handle.emit("show_workspace_picker", ());
            });
            return Ok(());
        }
    };
    
    // 5. 打开 active workspace 的 memos.db
    let db_path = active_ws.path.join("memos.db");
    let store = Store::open(&db_path)?;
    
    // 6. attachments_dir
    let attachments_dir = active_ws.path.join("attachments");
    std::fs::create_dir_all(&attachments_dir)?;
    
    // 7. AppState
    let state = AppState {
        store: Mutex::new(store),
        config_store: Mutex::new(config_store),
        attachments_dir,
        workspace_registry: Mutex::new(registry),
        config_dir,
        shutdown: AtomicBool::new(false),
    };
    app_handle.manage(state);
    
    Ok(())
}
```

**关于 `Store::open_in_memory()`**：`rusqlite::Connection::open_in_memory()` 创建内存 SQLite，无需磁盘文件。在 placeholder 状态下，任何对笔记的查询/写入都作用于空数据库，不会崩溃但返回空结果。前端在 WorkspacePicker 显示期间不会触发笔记操作（路由隔离）。

**关于 `Store::open` 添加 `open_in_memory` 方法**：
```rust
impl Store {
    pub fn open(db_path: &Path) -> Result<Self>;  // 现有
    pub fn open_in_memory() -> Result<Self>;       // 新增
}
```

### embedding.rs 改造

移除 `dirs::home_dir().join("localFragNote")` 硬编码，改为从 `AppState.config_dir` 派生：

```rust
fn model_dir(config_dir: &Path) -> IpcResult<PathBuf> {
    let dir = config_dir.join("models").join("all-MiniLM-L6-v2");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
```

### lan/endpoint.rs 改造

```rust
pub fn init_lan_state(config_dir: &Path) -> Result<LanState> {
    let key_path = config_dir.join("lan_identity.key");
    // ... 其余逻辑不变
}
```

移除 `dirs::home_dir().join("localFragNote")` 硬编码。

### commands/setting.rs 的 StorageConfig 改造

`StorageConfig.local_storage_path` 默认值 `"attachments"` 改为相对工作空间根目录解析：

```rust
let attachments_dir = if Path::new(&storage_config.local_storage_path).is_absolute() {
    PathBuf::from(&storage_config.local_storage_path)
} else {
    workspace_path.join(&storage_config.local_storage_path)
};
```

`workspace_path` 从 `state.workspace_registry.lock().get_active().path` 获取。

## 工作空间切换流程

```
用户在侧边栏切换工作空间:
1. 前端调 switch_workspace(ws_id) IPC 命令
2. 后端:
   a. 校验目标 workspace.path 有效性
   b. 检查是否有运行中的 AI Agent 任务（state.agent_running）
      - 有 → 返回错误"有正在执行的 AI 任务，请等待完成或中止后再切换"
   c. 更新 workspaces.json 的 active_workspace_id
   d. 发送 workspace_switching 事件给前端
3. 前端收到事件，显示"正在切换工作空间..."遮罩
4. 后端调 app_handle.restart() 重启 Tauri 应用
5. 重启后从启动流程第 5 步开始加载新工作空间
```

重启策略简单可靠：避免热切换导致的 React Query 缓存、AppState 引用、长时间运行的 spawn_blocking 任务等复杂清理问题。

## 前端 UI

### WorkspacePicker 页面

路径：`/workspace-picker`（启动时无 active workspace 时显示）

功能：
- 列出现有工作空间（若有）
- "新建工作空间"按钮：选择文件夹 → 输入名称 → 创建
- "打开现有工作空间"：选择包含 memos.db 的文件夹 → 注册到 workspaces.json

### 侧边栏顶部工作空间切换器

在 `src/components/Navigation.tsx` 顶部 logo 下方新增 `<WorkspaceSwitcher />` 组件：

```
┌─────────────────────────┐
│   LocalFragNote Logo   │
├─────────────────────────┤
│ [📁 我的工作笔记    ▼] │  ← WorkspaceSwitcher
├─────────────────────────┤
│ 🏠 主页                │
│ 📝 笔记                │
│ 🔍 发现                │
│ ...                    │
└─────────────────────────┘
```

下拉项：
- 列出所有工作空间（active 项打勾）
- 分隔线
- "+ 新建工作空间"
- "管理工作空间..."（打开设置页工作空间区域）

点击非 active 工作空间 → 调 `switch_workspace` IPC → 显示"正在切换..."遮罩 → app_handle.restart()

### 设置页"工作空间"区域

新增 `src/components/Settings/WorkspaceSection.tsx`：
- 列出所有工作空间（卡片形式）
- 每个卡片：名称、路径、状态（有效/无效）、创建时间
- 操作：重命名、在文件管理器中打开、删除（带确认）
- "新建工作空间"按钮

### i18n 新增键

`src/locales/zh-Hans.json` 新增 `workspace` 命名空间：

```json
"workspace": {
  "picker": {
    "title": "选择工作空间",
    "empty": "还没有工作空间，请新建一个开始",
    "new": "新建工作空间",
    "open": "打开现有文件夹",
    "name": "工作空间名称",
    "path": "路径",
    "create": "创建",
    "selectFolder": "选择文件夹"
  },
  "switcher": {
    "switching": "正在切换工作空间...",
    "switch": "切换到工作空间",
    "manage": "管理工作空间",
    "new": "新建工作空间"
  },
  "settings": {
    "title": "工作空间",
    "name": "名称",
    "path": "路径",
    "status": "状态",
    "statusValid": "有效",
    "statusInvalid": "无效",
    "rename": "重命名",
    "openInExplorer": "在文件管理器中打开",
    "delete": "删除",
    "deleteConfirm": "删除工作空间将仅从列表中移除，不会删除磁盘文件。确定继续吗？",
    "new": "新建工作空间"
  }
}
```

英文对应键同步添加到 `src/locales/en.json`。

## 错误处理与边界场景

### 启动时 active workspace 无效

- `WorkspaceRegistry::validate` 返回非 Valid → 不打开磁盘上的 memos.db
- AppState 用 placeholder 状态：`store` 指向 in-memory SQLite（`Store::open_in_memory()`），`attachments_dir` 为空路径
- 通过 `show_workspace_picker` 事件通知前端路由到 `/workspace-picker`
- WorkspacePicker 中显示该工作空间状态为 invalid，用户可重新定位或删除
- 在 placeholder 状态下，前端所有笔记相关 IPC 命令仍可调用（作用于空 db），但应通过路由隔离避免用户访问笔记页面

### 工作空间文件夹被外部删除/移动

- 启动时 validate 失败 → 同上
- 运行时文件操作失败（写入 attachments 报错）→ toast 提示"工作空间路径不可用，请切换到其他工作空间"，引导到 WorkspacePicker

### workspaces.json 损坏

- JSON 解析失败 → 备份为 `workspaces.json.corrupt.<ts>`，新建空 registry，进入 WorkspacePicker
- workspaces 为空但文件正常 → 同上

### app_config.db 锁定或损坏

- 启动时打开失败 → 致命错误对话框"共享配置数据库损坏，请检查 `<path>`"，退出应用
- 运行时写失败 → toast 提示，不中断当前操作

### 切换工作空间时正在执行的 AI Agent 任务

- switch_workspace IPC 命令先检查 `state.agent_running` 标志
- 若有运行中的任务 → 返回错误"有正在执行的 AI 任务，请等待完成或中止后再切换"
- 前端显示提示，不执行切换

### attachments_dir 路径穿越保护

保持现有 `file_storage::resolve_path` 的 canonicalize 逻辑，但基准改为 `workspace.path/attachments` 而非 `data_dir/attachments`。

## 测试策略

### 单元测试

**`core/src/config_store.rs`**：
- `test_open_creates_new_db`：打开不存在的 db 文件能创建并迁移
- `test_setting_crud`：app_setting/instance_setting 增删改查
- `test_tool_crud`：tool 表增删改查

**`src-tauri/src/workspace.rs`**：
- `test_load_missing_file`：文件不存在返回空 registry
- `test_save_load_roundtrip`：保存后重新加载能还原所有字段
- `test_add_workspace`：添加工作空间后 active 自动设为该 id
- `test_validate_path_not_found`：路径不存在返回 PathNotFound
- `test_validate_path_not_dir`：路径是文件返回 PathNotDir
- `test_atomic_save`：保存时检查 .tmp 文件被清理

### 集成测试

**`src-tauri/src/main.rs` 启动流程**：
- 模拟空引导目录 → 应进入 WorkspacePicker 流程
- 模拟有 active workspace → 应正确加载 memos.db
- 模拟 active workspace 路径无效 → 应进入 WorkspacePicker

## 不变的部分

- 笔记 CRUD 业务逻辑（memo、tag、relation、review_card 等）不受影响
- AI Agent 循环、工具执行逻辑不受影响
- LAN 模块的发现/认证/ACL 逻辑不受影响，仅密钥路径变更
- embedding 模型下载/推理逻辑不受影响，仅模型存储路径变更
- 前端笔记编辑器、AI 聊天、复习卡片等页面不受影响

## 影响范围

### 新增文件

- `core/src/config_store.rs` — 共享配置 Store
- `core/migrations/config/V1__initial_config_schema.sql` — app_config.db 建表迁移
- `core/migrations/V11__drop_shared_config_tables.sql` — memos.db 删表迁移
- `src-tauri/src/workspace.rs` — WorkspaceRegistry
- `src-tauri/src/commands/workspace.rs` — 工作空间 IPC 命令
- `src/components/WorkspacePicker/WorkspacePicker.tsx` — 工作空间选择页
- `src/components/WorkspacePicker/index.tsx`
- `src/components/Navigation/WorkspaceSwitcher.tsx` — 侧边栏切换器
- `src/components/Settings/WorkspaceSection.tsx` — 设置页工作空间区域
- `src/hooks/useWorkspaceQueries.ts` — React Query hooks
- `src/types/workspace.ts` — 前端类型

### 修改文件

- `core/src/store.rs` — 移除 setting/tool 字段
- `core/src/lib.rs` — 导出 ConfigStore
- `src-tauri/src/main.rs` — 启动流程改造
- `src-tauri/src/state.rs` — AppState 新增字段
- `src-tauri/src/lib.rs` — 导出 workspace 模块
- `src-tauri/src/embedding.rs` — model_dir 改用 config_dir
- `src-tauri/src/lan/endpoint.rs` — init_lan_state 接收 config_dir
- `src-tauri/src/commands/setting.rs` — StorageConfig 路径解析改为相对 workspace.path
- `src-tauri/src/commands/attachment.rs` — attachments_dir 来自 workspace.path
- `src-tauri/src/commands/tool.rs` — tool 操作改走 config_store
- `src-tauri/src/file_storage.rs` — 路径基准改为 workspace.path/attachments
- `src-tauri/src/ai/provider.rs` — provider 操作改走 config_store
- `src-tauri/src/llm_runner/config.rs` — llm_runner_config 改走 config_store
- `src-tauri/src/mcp/config.rs` — mcp_config 改走 config_store
- `src-tauri/src/lan/endpoint.rs` — lan 配置改走 config_store
- `src/components/Navigation.tsx` — 添加 WorkspaceSwitcher
- `src/components/Settings/index.tsx` — 添加 WorkspaceSection
- `src/router.tsx` — 添加 /workspace-picker 路由
- `src/locales/zh-Hans.json` — 新增 workspace 键
- `src/locales/en.json` — 新增 workspace 键
