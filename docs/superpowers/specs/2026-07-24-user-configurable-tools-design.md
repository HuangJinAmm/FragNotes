# 用户可配置工具集 设计文档

**日期**: 2026-07-24
**状态**: 待实现
**关联**: 2026-07-23-ai-chat-skills-design.md（skill 与 tool 的关联机制）

## 1. 背景与目标

### 背景

现有 AI chat agent 暴露 10 个硬编码工具（`list_memos`、`get_memo`、`load_skill` 等）给 LLM。工具集定义在 [src-tauri/src/ai/tools.rs](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/ai/tools.rs) 的 `tool_definitions()` 中，静态写死，新增工具需要改源码并重新编译。

skill 系统已经实现了用户可配置的 Markdown 指南文档（[2026-07-23-ai-chat-skills-design.md](./2026-07-23-ai-chat-skills-design.md)），其 `tools` 字段是 JSON 数组，声明该 skill 关联的工具名。但用户当前无法创建自己的工具——只能写 skill 文档引用工具名，工具本身不存在则 LLM 调用失败（如现有 `b-office-cli-guide` 引用的 `office_cli` 工具就是前向占位符）。

### 目标

允许用户在配置中创建自己的工具，让 LLM 能调用这些工具完成内置工具未覆盖的任务（如运行 shell 命令、调用本地脚本）。每个工具配置包含：

1. **工具名**：LLM 可见的唯一标识
2. **执行命令**：默认/示例命令（仅展示，LLM 调用时传完整 command 覆盖）
3. **权限等级**：`read_only` | `writable` | `executable` | `dangerous`
4. **工具描述**：注入 LLM 工具描述

后端把用户配置的工具合并到 LLM 可用工具集中，并支持用户工具与现有 skill 的关联（通过 skill 表的 `tools` 字段单向引用）。

### 非目标（YAGNI）

详见第 8 节。

## 2. 架构与数据模型

### 2.1 新增 `tool` 表

Migration 文件 `core/migrations/V10__add_tool.sql`，对称于 `core/migrations/V9__add_skill.sql`：

```sql
CREATE TABLE IF NOT EXISTS tool (
    id           TEXT PRIMARY KEY,        -- "u-<slug>"
    name         TEXT NOT NULL UNIQUE,    -- LLM 可见的工具名（与内置 10 个不可冲突）
    command      TEXT NOT NULL,           -- 默认/示例命令（仅展示，LLM 调用时传完整 command 覆盖）
    permission   TEXT NOT NULL CHECK(permission IN ('read_only','writable','executable','dangerous')),
    description  TEXT NOT NULL,           -- 注入 LLM 工具描述
    timeout_ms   INTEGER NOT NULL DEFAULT 30000,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_ts   INTEGER NOT NULL,
    updated_ts   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_enabled ON tool(enabled);
```

### 2.2 Rust 数据模型

`core/src/tool.rs`（对称于 [core/src/skill.rs](file:///d:/3-ai-project/LocalFragNote/core/src/skill.rs)）：

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    ReadOnly,
    Writable,
    Executable,
    Dangerous,
}

impl Permission {
    pub fn as_str(&self) -> &'static str {
        match self {
            Permission::ReadOnly => "read_only",
            Permission::Writable => "writable",
            Permission::Executable => "executable",
            Permission::Dangerous => "dangerous",
        }
    }

    /// 是否需要用户确认才能执行
    pub fn requires_confirmation(&self) -> bool {
        matches!(self, Permission::Executable | Permission::Dangerous)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tool {
    pub id: String,
    pub name: String,
    pub command: String,
    pub permission: Permission,
    pub description: String,
    pub timeout_ms: i64,
    pub enabled: bool,
    pub created_ts: i64,
    pub updated_ts: i64,
}
```

CRUD 函数（对齐 `memos_core::skill::*` 命名）：`list / list_enabled / get / get_by_name / create / update / delete / set_enabled`。

### 2.3 关键约束

- `name` 唯一约束，且后端 `create`/`update` 时校验不能与内置 10 个工具名冲突（黑名单常量 `BUILTIN_TOOL_NAMES`）
- `name` 仅允许 `[a-z0-9_]`，长度 1-64
- `permission` 必须是 4 个值之一（DB CHECK 约束 + Rust enum 双重保障）
- `timeout_ms` 范围 1000-600000（1s-10min），后端 create/update 时校验
- `command` 非空，长度 ≤ 1024
- 不引入"内置工具"DB 概念，所有用户工具都是 `u-` 前缀；内置工具继续硬编码在 `tools.rs`

### 2.4 整体架构图

```
core/migrations/V10__add_tool.sql  ──►  core/src/tool.rs (CRUD)
                                          │
                                          ▼
src-tauri/src/commands/tool.rs  ──►  6 个 Tauri IPC 命令
       │                                 │
       │  tool_confirm_response 命令      │
       │                                 ▼
       │                       src-tauri/src/state.rs
       │                       AppState.pending_confirmations
       │                                 ▲
       ▼                                 │ emit tool:confirm_request
src-tauri/src/ai/tools.rs:               │
  tool_definitions(user_tools) ──►  execute_tool
       │                          增加 user_tool 分发分支
       ▼                                 │
src-tauri/src/commands/ai_chat.rs        │
  agent_loop: load enabled user tools    │
            + tool_definitions(&user_tools)
            + execute_tool(...) 增加 pending + app 参数
            + abort/shutdown 时 cancel_all()
       │
       ▼
src/hooks/useToolQueries.ts  ◄──  src/types/tool.ts (ToolDto)
       │
       ▼
components/Settings/ToolsSection.tsx + ToolEditor.tsx
       │
       │ useKnownToolNames() 合并内置 10 + 用户工具
       ▼
components/Settings/SkillEditor.tsx (tools 字段多选动态化)

src/components/AiChat/ToolConfirmDialog.tsx (订阅 tool:confirm_request 事件)
```

## 3. 工具定义与执行

### 3.1 `tool_definitions()` 改造

[src-tauri/src/ai/tools.rs](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/ai/tools.rs) 函数签名从无参改为接收用户工具列表：

```rust
pub fn tool_definitions(user_tools: &[memos_core::tool::Tool]) -> Vec<Value> {
    let mut defs: Vec<Value> = vec![
        json!({ /* list_memos */ }),
        // ... 原有 10 个内置工具 JSON 不变
    ];
    for ut in user_tools.iter().filter(|t| t.enabled) {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": ut.name,
                "description": format!(
                    "{}\n\n[权限等级: {}] 执行用户配置的 shell 命令。配置默认命令: `{}`。\
                     调用时传入完整 command 字符串，后端在固定工作目录执行。",
                    ut.description, ut.permission.as_str(), ut.command
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "要执行的完整 shell 命令字符串"
                        }
                    },
                    "required": ["command"]
                }
            }
        }));
    }
    defs
}
```

测试 `test_tool_definitions_count` 需要调整为：传 `&[]` 时返回 10。

### 3.2 `execute_tool()` 增加分发分支

`execute_tool` 签名增加 3 个参数：`user_tools`、`pending_confirmations`、`app_handle`。

匹配逻辑：

```rust
match name {
    "list_memos" => execute_list_memos(...),
    // ... 原有 10 个内置分支不变
    other => {
        // 先查内置 10 个名字，未命中再查用户工具
        if BUILTIN_TOOL_NAMES.contains(&other) {
            return Err(json!({"error": format!("unknown builtin tool: {}", other)}));
        }
        let user_tool = memos_core::tool::get_by_name(&store, other)?
            .ok_or_else(|| json!({"error": format!("unknown tool: {}", other)}))?;
        if !user_tool.enabled {
            return Err(json!({"error": format!("tool {} is disabled", other)}));
        }
        let command = args["command"].as_str()
            .ok_or_else(|| json!({"error": "missing 'command' argument"}))?;
        execute_user_tool(user_tool, command, &state, pending).await
    }
}
```

### 3.3 `execute_user_tool` 实现

跨平台 shell 选择：

```rust
#[cfg(windows)]
fn build_shell_command(command: &str) -> tokio::process::Command {
    let mut c = tokio::process::Command::new("cmd");
    c.arg("/C").arg(command);
    c
}

#[cfg(not(windows))]
fn build_shell_command(command: &str) -> tokio::process::Command {
    let mut c = tokio::process::Command::new("sh");
    c.arg("-c").arg(command);
    c
}
```

不用 PowerShell 避免 `ExecutionPolicy` 报错。`cmd /C` 走 `%ComSpec%` 默认 cmd.exe。

执行函数：

```rust
async fn execute_user_tool(
    tool: Tool,
    command: &str,
    state: &AppState,
    pending: &PendingConfirmations,
) -> Result<Value, Value> {
    // 1. 权限分级拦截
    if tool.permission.requires_confirmation() {
        let approved = pending.request_confirmation(
            tool.name.clone(),
            command.to_string(),
            tool.permission,
            state.app_handle(),
        ).await?;
        if !approved {
            return Ok(json!({"error": "user denied the tool call", "denied": true}));
        }
    }

    // 2. 在固定工作目录执行（不继承父进程 cwd）
    let cwd = state.app_data_dir();
    let mut cmd = build_shell_command(command);
    cmd.current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn()
        .map_err(|e| json!({"error": format!("spawn failed: {}", e)}))?;

    // 3. 超时强制 kill（tool.timeout_ms 可配）
    let output = match tokio::time::timeout(
        Duration::from_millis(tool.timeout_ms as u64),
        child.wait_with_output(),
    ).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(json!({"error": format!("wait failed: {}", e)})),
        Err(_) => {
            let _ = child.kill().await;
            return Err(json!({"error": format!("timeout after {}ms", tool.timeout_ms)}));
        }
    };

    // 4. 合并 stdout+stderr，stderr 加前缀；超 10KB 截断
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr: String = String::from_utf8_lossy(&output.stderr)
        .lines().map(|l| format!("[stderr] {}\n", l)).collect();
    let mut combined = format!("{}{}", stdout, stderr);

    const MAX_OUTPUT_BYTES: usize = 10 * 1024;
    if combined.len() > MAX_OUTPUT_BYTES {
        combined = truncate_at_char_boundary(&combined, MAX_OUTPUT_BYTES);
    }

    Ok(json!({
        "output": combined,
        "exit_code": output.status.code().unwrap_or(-1),
        "tool_name": tool.name,
        "permission": tool.permission.as_str(),
    }))
}
```

**截断 helper**（稳定 Rust API 实现 UTF-8 安全边界，替代 nightly 的 `floor_char_boundary`/`ceil_char_boundary`）：

```rust
/// 在不超过 max_bytes 的前提下，保留头部和尾部各 max_bytes/2 字节，
/// 中间用 truncation marker 占位。所有切点都对齐 UTF-8 字符边界。
fn truncate_at_char_boundary(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let half = max_bytes / 2;

    // 从中间向左找最近的字符边界（避免切断多字节字符）
    let mut head_end = half;
    while !s.is_char_boundary(head_end) && head_end > 0 {
        head_end -= 1;
    }

    let tail_start_target = s.len() - half;
    let mut tail_start = tail_start_target;
    while !s.is_char_boundary(tail_start) && tail_start < s.len() {
        tail_start += 1;
    }

    let truncated_bytes = s.len() - head_end - (s.len() - tail_start);
    format!(
        "{}\n...[truncated {} bytes]...\n{}",
        &s[..head_end],
        truncated_bytes,
        &s[tail_start..]
    )
}
```

`str::is_char_boundary` 是稳定 API（Rust 1.9+），无 nightly 依赖。

## 4. 确认通道（权限分级拦截）

### 4.1 权限等级语义

| 等级 | 拦截行为 | 用途示例 |
|---|---|---|
| `read_only` | 直接执行，不拦截 | `git status`、`ls -la` |
| `writable` | 直接执行，不拦截 | `git add`、文件写入 |
| `executable` | 弹确认 Dialog，用户批准后才执行 | 启动构建脚本、`npm install` |
| `dangerous` | 弹确认 Dialog + 红色警告框，用户批准后才执行 | `rm -rf`、`git push --force` |

设计理由：`read_only` 和 `writable` 在桌面本地应用场景下，工具调用的真实影响与 LLM 调用 `update_memo`、`create_review_cards` 等内置可写工具相当，无需逐次打断用户。`executable`/`dangerous` 涉及子进程执行任意代码，必须人工确认。

### 4.2 `PendingConfirmations` 类型

[src-tauri/src/state.rs](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/state.rs) 增加：

```rust
use tokio::sync::oneshot;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct PendingConfirmations {
    next_id: AtomicU64,
    inner: Mutex<HashMap<u64, oneshot::Sender<bool>>>,
}

impl PendingConfirmations {
    pub fn new() -> Self {
        Self { next_id: AtomicU64::new(1), inner: Mutex::new(HashMap::new()) }
    }

    /// 发起确认请求，emit `tool:confirm_request` 事件到前端，等待 oneshot 唤醒
    pub async fn request_confirmation(
        &self,
        tool_name: String,
        command: String,
        permission: Permission,
        app: &tauri::AppHandle,
    ) -> Result<bool, Value> {
        let call_id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.inner.lock().unwrap().insert(call_id, tx);

        app.emit("tool:confirm_request", json!({
            "call_id": call_id,
            "tool_name": tool_name,
            "command": command,
            "permission": permission.as_str(),
        })).map_err(|e| json!({"error": format!("emit failed: {}", e)}))?;

        // 60s 等待超时（等价于拒绝，避免永久阻塞）
        match tokio::time::timeout(Duration::from_secs(60), rx).await {
            Ok(Ok(approved)) => Ok(approved),
            Ok(Err(_)) => Ok(false),  // sender dropped = 取消
            Err(_) => {
                self.inner.lock().unwrap().remove(&call_id);
                Ok(false)
            }
        }
    }

    /// 前端回传时调用
    pub fn respond(&self, call_id: u64, approved: bool) -> bool {
        if let Some(tx) = self.inner.lock().unwrap().remove(&call_id) {
            let _ = tx.send(approved);
            true
        } else {
            false  // 已超时或不存在
        }
    }

    /// abort/shutdown 时唤醒所有等待中的确认（发送 false）
    pub fn cancel_all(&self) {
        let mut map = self.inner.lock().unwrap();
        for (_, tx) in map.drain() {
            let _ = tx.send(false);
        }
    }
}
```

AppState 增加 `pending_confirmations: PendingConfirmations` 字段，初始化时 `PendingConfirmations::new()`。

**关于 `app_handle()`**：AppState 需要增加一个 `app_handle: tauri::AppHandle` 字段（在 `main.rs` setup 阶段通过 `app.handle()` 克隆），并暴露 `pub fn app_handle(&self) -> &tauri::AppHandle` 方法。`request_confirmation` 调用 `state.app_handle()` 拿到 handle 用于 `emit` 事件。

### 4.3 Tauri 命令 `tool_confirm_response`

[src-tauri/src/commands/tool.rs](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/commands/tool.rs)：

```rust
#[tauri::command]
pub async fn tool_confirm_response(
    call_id: u64,
    approved: bool,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    Ok(state.pending_confirmations.respond(call_id, approved))
}
```

注册到 [src-tauri/src/main.rs](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/main.rs) 的 invoke_handler。

### 4.4 前端确认 Dialog

`src/components/AiChat/ToolConfirmDialog.tsx`：

- 订阅 `tool:confirm_request` 事件
- 维护一个待确认请求队列（FIFO）
- Dialog 显示：
  - 工具名 + 权限等级 badge（颜色：`read_only` 灰、`writable` 蓝、`executable` 橙、`dangerous` 红）
  - 完整命令（`<pre>` 等宽字体，不允许编辑）
  - 警告文案（`dangerous` 等级额外加红色警告框：「此工具被标记为危险，执行可能造成不可逆后果」）
  - 「拒绝」（默认聚焦，按 Esc 触发）+「批准」两个按钮
  - 倒计时 60s 提示（与后端等待一致），超时自动按拒绝处理
- 用户操作后调 `invoke('tool_confirm_response', { callId, approved })`，从队列移除当前项，显示下一个

```typescript
interface ToolConfirmRequest {
  call_id: number;
  tool_name: string;
  command: string;
  permission: 'read_only' | 'writable' | 'executable' | 'dangerous';
}
```

**并发处理**：同一时刻可能有多个 executable/dangerous 工具调用排队等待确认。`PendingConfirmations.inner` 用 `Mutex<HashMap>` 支持并发插入；前端 Dialog 用队列渲染——每次只显示队列头部的一个 Dialog，用户操作（批准/拒绝/超时）后从队列移除，自动渲染下一个。LLM 调用顺序与 Dialog 出队顺序一致（FIFO）。

## 5. Agent Loop 集成

[src-tauri/src/commands/ai_chat.rs](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/commands/ai_chat.rs) `agent_loop` 三处改造：

### 5.1 启动时一次性加载 enabled 用户工具

与现有 `skill_section` 同位置加载：

```rust
let user_tools = {
    let store = state.store();
    memos_core::tool::list_enabled(&store).unwrap_or_default()
};
```

`list_enabled` 在 agent_loop 之外预读一次（避免每轮查 DB），与现有 `skill_section` 模式一致。运行期间用户启用/禁用工具只影响下一次对话。

### 5.2 构造请求 body 时传入用户工具

```rust
let body = json!({
    "model": provider.model,
    "messages": req_messages,
    "stream": true,
    "tools": tool_definitions(&user_tools),
});
```

### 5.3 工具执行分发传入确认通道

```rust
let result = execute_tool(
    &tc.name,
    &args,
    &store,
    &state.builtin_skills,
    &user_tools,
    &state.pending_confirmations,
    state.app_handle(),
).await;
```

### 5.4 abort/shutdown 协同

现有 agent_loop 在每轮开头检查 `state.shutdown.load(Ordering::SeqCst)` 和 abort flag。在两处检查点后追加：

```rust
if is_aborted || shutdown {
    state.pending_confirmations.cancel_all();
    break;
}
```

`cancel_all()` 实现见 4.2。同步操作，不 spawn async task，与项目记忆中"LAN module shutdown must use synchronous shutdown signal without spawning async tasks"原则一致。

### 5.5 ai:tool 事件 payload 扩展

现有 `ai:tool` event 携带 tool call 结果供前端持久化。用户工具结果额外带字段：

```rust
app.emit("ai:tool", json!({
    "name": tc.name,
    "args": tc.args,
    "result": result,
    "is_user_tool": true,        // 新增（仅 user_tool 分支填充）
    "permission": permission_str,
    "denied": denied_flag,
}))?;
```

前端 [src/components/AiChat/AiChatMessages.tsx](file:///d:/3-ai-project/LocalFragNote/src/components/AiChat/AiChatMessages.tsx) 增加分支：若 `is_user_tool` 为 true，渲染成带权限 badge 的卡片样式（类似 `load_skill` 的特殊渲染），而非默认的普通工具结果块。

### 5.6 `invalidateQueriesForTool` 处理

[src/components/AiChat/hooks.ts](file:///d:/3-ai-project/LocalFragNote/src/components/AiChat/hooks.ts) 现有 switch 处理 10 个内置工具名；新增 `user_tool` 分支跳过 memo 数据失效（对齐 `load_skill` 的 no-op 模式），因为用户工具不直接修改笔记数据。

## 6. Tauri 命令、前端配置 UI 与 Skill 关联

### 6.1 Tauri 命令

[src-tauri/src/commands/tool.rs](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/commands/tool.rs)（对称于 `commands/skill.rs`）：

```rust
#[derive(Serialize)]
pub struct ToolDto {
    pub id: String,
    pub name: String,
    pub command: String,
    pub permission: String,    // snake_case 字符串
    pub description: String,
    pub timeout_ms: i64,
    pub enabled: bool,
    pub created_ts: i64,
    pub updated_ts: i64,
}

pub struct CreateToolInput {
    pub name: String,
    pub command: String,
    pub permission: String,
    pub description: String,
    pub timeout_ms: i64,
}

pub struct UpdateToolInput {
    pub name: Option<String>,
    pub command: Option<String>,
    pub permission: Option<String>,
    pub description: Option<String>,
    pub timeout_ms: Option<i64>,
}
```

6 个命令：

```rust
#[tauri::command]
pub async fn tool_list(state: tauri::State<'_, AppState>) -> Result<Vec<ToolDto>, String>
pub async fn tool_create(input: CreateToolInput, state: ...) -> Result<ToolDto, String>
pub async fn tool_update(id: String, input: UpdateToolInput, state: ...) -> Result<ToolDto, String>
pub async fn tool_delete(id: String, state: ...) -> Result<(), String>
pub async fn tool_set_enabled(id: String, enabled: bool, state: ...) -> Result<(), String>
pub async fn tool_confirm_response(call_id: u64, approved: bool, state: ...) -> Result<bool, String>
```

`CreateToolInput` / `UpdateToolInput` 在后端做以下校验：

- `name` 不能与内置 10 个冲突（黑名单常量 `BUILTIN_TOOL_NAMES`，定义在 `tool.rs` 或 `commands/tool.rs`）
- `name` 仅允许 `[a-z0-9_]`，长度 1-64
- `permission` 必须是 4 个值之一
- `timeout_ms` 范围 1000-600000（1s-10min）
- `command` 非空，长度 ≤ 1024
- `description` 非空，长度 ≤ 500

全部注册到 [src-tauri/src/main.rs](file:///d:/3-ai-project/LocalFragNote/src-tauri/src/main.rs) 的 invoke_handler。

### 6.2 前端类型与 hooks

`src/types/tool.ts`（对称于 [src/types/skill.ts](file:///d:/3-ai-project/LocalFragNote/src/types/skill.ts)）：

```typescript
export type ToolPermission = 'read_only' | 'writable' | 'executable' | 'dangerous';

export interface ToolDto {
  id: string;
  name: string;
  command: string;
  permission: ToolPermission;
  description: string;
  timeout_ms: number;
  enabled: boolean;
  created_ts: number;
  updated_ts: number;
}

// 内置 10 个工具名（黑名单，校验用户输入用）
export const BUILTIN_TOOL_NAMES = [
  'list_memos', 'get_memo', 'create_memo', 'list_tags', 'list_memos_by_tag',
  'update_memo', 'search_semantic', 'link_memos', 'create_review_cards', 'load_skill',
] as const;

export const PERMISSION_LABELS: Record<ToolPermission, string> = {
  read_only: '只读',
  writable: '可写',
  executable: '可执行',
  dangerous: '危险',
};

export const PERMISSION_COLORS: Record<ToolPermission, string> = {
  read_only: 'bg-gray-100 text-gray-700',
  writable: 'bg-blue-100 text-blue-700',
  executable: 'bg-orange-100 text-orange-700',
  dangerous: 'bg-red-100 text-red-700',
};
```

`src/hooks/useToolQueries.ts`（对称于 [useSkillQueries.ts](file:///d:/3-ai-project/LocalFragNote/src/hooks/useSkillQueries.ts)）：

```typescript
// 全部 invalidate ["tools"] query key
export function useToolList(options?: { enabled?: boolean })
  // enabled?: false 时拉所有（含禁用），undefined/true 时只拉启用的
  // 调用 invoke<ToolDto[]>('tool_list', { enabled: options?.enabled })

export function useCreateTool()
export function useUpdateTool()
export function useDeleteTool()
export function useSetToolEnabled()

// 合并内置 10 个工具名 + 所有用户工具名（含禁用），供 SkillEditor 多选用
export function useKnownToolNames() {
  const builtin = BUILTIN_TOOL_NAMES;
  const { data: userTools } = useToolList({ enabled: false }); // 拉所有（含禁用）
  const userNames = (userTools ?? []).map(t => t.name);
  return [...builtin, ...userNames];
}
```

后端 `tool_list` 命令对应增加可选 `enabled: Option<bool>` 参数：

```rust
#[tauri::command]
pub async fn tool_list(
    enabled: Option<bool>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ToolDto>, String> {
    let store = state.store();
    let tools = match enabled {
        Some(true) => memos_core::tool::list_enabled(&store)?,
        Some(false) | None => memos_core::tool::list(&store)?,
    };
    Ok(tools.into_iter().map(ToolDto::from).collect())
}
```

`useKnownToolNames` 用 `{ enabled: false }` 拉所有含禁用工具，让用户能给 skill 关联任何已创建的工具。

### 6.3 Settings 新段

`src/components/Settings/ToolsSection.tsx`（对称于 [SkillsSection.tsx](file:///d:/3-ai-project/LocalFragNote/src/components/Settings/SkillsSection.tsx)）：

- 在 [settingSections.ts](file:///d:/3-ai-project/LocalFragNote/src/components/Settings/settingSections.ts) 注册新段：key `"tools"`，scope `"basic"`，icon 用 `WrenchIcon`（lucide-react）
- 列表展示每个用户工具：
  - name + permission badge（4 色：`read_only` 灰 / `writable` 蓝 / `executable` 橙 / `dangerous` 红）
  - description（次级灰色文字）
  - enabled Switch
  - Edit + Delete 按钮（参考 SkillsSection 的 user skill 行布局）
- 顶部「新建工具」按钮打开 ToolEditor
- 不区分 builtin/user（本功能下全部是用户工具，无内置工具概念）

### 6.4 ToolEditor

`src/components/Settings/ToolEditor.tsx`（对称于 [SkillEditor.tsx](file:///d:/3-ai-project/LocalFragNote/src/components/Settings/SkillEditor.tsx)）：

Dialog 表单字段：

- **name**：slug 输入，编辑模式禁用；保存时前缀 `u-`（与 skill 一致，避免与未来可能的内置工具名冲突）
- **command**：单行 input，placeholder `"git status"`（仅作为默认/示例展示，LLM 调用时传完整 command 覆盖它）
- **permission**：4 个单选按钮（带颜色 badge 预览），默认 `read_only`
- **description**：单行 input，placeholder `"列出当前 git 状态"`
- **timeout_ms**：数字输入，默认 30000，min 1000 / max 600000，旁边显示单位「ms」

校验：

- name 非空且不与 `BUILTIN_TOOL_NAMES` 冲突
- name 仅允许 `[a-z0-9_]`
- command/description 非空
- timeout_ms 在 1000-600000 范围内

### 6.5 Skill 与 Tool 的关联（核心需求）

现有 [src/types/skill.ts](file:///d:/3-ai-project/LocalFragNote/src/types/skill.ts) 的 `KNOWN_TOOL_NAMES` 静态常量改为 6.2 中定义的 `useKnownToolNames()` hook，返回内置 10 + 所有用户工具名（含禁用）。

[SkillEditor.tsx](file:///d:/3-ai-project/LocalFragNote/src/components/Settings/SkillEditor.tsx) 中 `KNOWN_TOOL_NAMES.map(...)` 改为 `useKnownToolNames().map(...)`，让用户能给 skill 关联任何已创建的工具（包括禁用的）。

### 6.6 后端 skill 加载时不校验工具名合法性

现有 `memos_core::skill::create / update` 不校验 `tools` 字段合法性（`office_cli` 就是不存在的工具名）。本设计**不改变**这个行为，原因：

- 允许 skill 引用尚未创建的工具（前向占位）
- skill 与 tool 是松耦合关联（单向引用，skill 声明意图）
- LLM 调用 skill 时加载 body 内容，里面可能引用工具名，但实际能否调用取决于 `tool_definitions` 里是否有该工具

这与现有 `b-office-cli-guide.md` 引用不存在的 `office_cli` 工具的语义一致。

## 7. 错误处理与测试

### 7.1 错误处理矩阵

| 场景 | 后端行为 | 返回给 LLM | 前端表现 |
|---|---|---|---|
| 用户拒绝确认 | oneshot 收到 `false` | `{"error": "user denied the tool call", "denied": true}` | ai:tool 事件带 `denied: true`，卡片渲染「已拒绝」 |
| 60s 确认超时 | `request_confirmation` 内 tokio timeout | 同上（视为拒绝） | 同上 |
| spawn 失败（命令不存在） | `Command::spawn` 返回 Err | `{"error": "spawn failed: <reason>"}` | ai:tool 卡片显示错误 |
| 子进程超时（tool.timeout_ms） | `tokio::time::timeout` + `child.kill()` | `{"error": "timeout after <ms>ms"}` | 卡片显示超时 |
| 输出 > 10KB | 头尾各 5KB + 中间占位 | 截断后的字符串 | 正常显示截断输出 |
| 工具被禁用（运行期间 toggle） | `list_enabled` 在 agent_loop 启动时读一次 | 本轮不会出现在 `tool_definitions` | LLM 不会发起调用 |
| name 与内置工具冲突 | create/update 时后端 422 | IPC 返回 Err | ToolEditor 显示错误 toast |
| LLM 传非字符串 command | `args["command"].as_str()` 返回 None | `{"error": "missing 'command' argument"}` | 卡片显示错误 |
| Windows 上 `cmd` 不可用 | spawn 失败 | 同 spawn 失败 | 同 spawn 失败 |
| abort/shutdown 时仍有 pending 确认 | `cancel_all()` 发送 false | 同「用户拒绝」 | Dialog 自动关闭，卡片渲染「已拒绝」 |

### 7.2 测试策略

- `core/src/tool.rs`：单元测试 CRUD（用内存 SQLite，对齐现有 skill 测试模式）
  - `test_tool_crud_lifecycle`
  - `test_tool_name_unique_constraint`
  - `test_tool_get_by_name`
  - `test_tool_set_enabled_toggle`
- `src-tauri/src/ai/tools.rs`：
  - `test_tool_definitions_count`：改为传 `&[]` 断言返回 10
  - `test_tool_definitions_with_user_tools`：传 1 个 enabled + 1 个 disabled 用户工具，断言总数 11（10 + 1）
  - `test_execute_user_tool_deny`：mock `PendingConfirmations` 立即返回 `false`，断言 `denied: true`
  - `test_execute_user_tool_timeout`：用 `timeout_ms: 100` + 命令 `sleep 1`，断言返回 timeout 错误
  - `test_execute_user_tool_truncation`：命令 `yes hello | head -c 20000`（输出 20KB），断言返回字符串含 `truncated`
  - `test_execute_user_tool_readonly_no_confirm`：`read_only` 工具不触发 `request_confirmation`
- `src-tauri/src/state.rs::test_pending_confirmations`：
  - `test_respond_wakes_waiter`
  - `test_cancel_all_sends_false_to_all`
  - `test_timeout_returns_false`

## 8. YAGNI 边界（明确不做的事）

- 不做沙箱/容器化/资源限制（CPU/memory cgroup）
- 不做命令黑名单（不拦截 `rm -rf /` 等危险命令）—— 依赖权限等级 + 用户确认把关
- 不做工作目录可配置 —— 固定 `app_data_dir`
- 不做环境变量配置 —— 子进程继承父进程 env（LLM 可通过命令本身设置）
- 不做 stdin 交互 —— `Stdio::null()`，所有输入通过命令行参数
- 不做异步流式输出 —— 一次性 `wait_with_output` 后返回（与现有工具一致）
- 不做执行历史持久化 —— 仅在 `ai:tool` 事件里走现有消息持久化路径
- 不做工具调用审计日志 —— 仅靠现有日志机制打 log
- 不做工具导入/导出（JSON 配置文件分享）
- 不做工具与 skill 的反向校验 —— 保持松耦合
- 不做内置工具的启用/禁用 —— 内置 10 个永远可用（保持现状）

## 9. 与现有约束的兼容性

- 项目记忆里 `MAX_AGENT_ROUNDS = 200` 已足够，用户工具调用不增加轮次预算
- 项目记忆里 LAN 模块 shutdown 用同步 `shutdown_tx.send(true)`；本设计的 `cancel_all` 也是同步操作（不 spawn async task），与之协同无冲突
- `app.exit` handler 调用 `std::process::exit(0)` 时，若还有 pending 确认阻塞 agent_loop，进程会立即退出 —— 这是预期行为（用户已主动退出 app）
- 与 `office_cli_guide.md` 现状兼容：用户可创建名为 `office_cli` 的工具让该 skill 真正可用，或在 skill 文档里继续保留前向占位

## 10. 实现顺序建议

1. `core/migrations/V10__add_tool.sql` + `core/src/tool.rs`（数据模型与 CRUD）
2. `src-tauri/src/state.rs` 增加 `PendingConfirmations`（独立可单测）
3. `src-tauri/src/ai/tools.rs` 改 `tool_definitions` 签名 + 增加 `execute_user_tool` + 改 `execute_tool` 分发
4. `src-tauri/src/commands/ai_chat.rs` agent_loop 集成（加载 user_tools + abort 时 cancel_all）
5. `src-tauri/src/commands/tool.rs` 6 个 IPC 命令 + 注册到 `main.rs`
6. `src/types/tool.ts` + `src/hooks/useToolQueries.ts`
7. `src/components/Settings/ToolsSection.tsx` + `ToolEditor.tsx` + 注册到 `settingSections.ts`
8. `src/components/AiChat/ToolConfirmDialog.tsx` + ai:tool 事件渲染扩展
9. `useKnownToolNames` hook + SkillEditor 多选动态化
10. 全部测试通过
