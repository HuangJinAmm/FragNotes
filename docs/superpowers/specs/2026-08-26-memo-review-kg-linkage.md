# 笔记 · 回顾 · 知识图谱 三模块联动 — 功能总结

> 日期：2026-08-26
> 范围：笔记（Memo）、回顾（Review / FSRS）、知识图谱（Knowledge Graph）三个模块之间的双向关联与数据同步

***

## 背景与目标

三个模块此前各自独立：知识图谱节点只能查看匹配笔记，复习卡片不知道来源笔记与图谱位置，笔记详情也看不到复习进度。本次改动旨在建立**完整的双向导航闭环 + 实时状态可视化 + 数据流同步**，让「学（笔记）— 识（图谱）— 记（复习）」形成一体。

## 联动能力总览

| # | 方向 | 能力 | 入口 |
|---|------|------|------|
| 1 | 图谱 → 复习 | 节点「复习此主题」一键生成/复用牌组（BFS 收集后代节点标签并集） | 节点卡片快捷操作 |
| 2 | 图谱 → 笔记 | 节点「查看关联笔记」按标签筛选跳转笔记列表 | 节点卡片快捷操作 |
| 3 | 复习 → 笔记 | 卡片「查看原文」跳转笔记详情 | 复习卡翻面后 |
| 4 | 复习 → 图谱 | 卡片显示所属 KG 节点，点击跳转图谱并选中该节点 | 复习卡翻面后 |
| 5 | 笔记 → 图谱 | 侧栏显示关联节点 chips，点击跳转；支持手动关联/解除 | 笔记详情侧栏 |
| 6 | 笔记 → 复习 | 侧栏「复习状态」区块：卡片数、到期数、下次复习时间，点击跳转所属牌组 | 笔记详情侧栏 |
| 7 | 图谱 ← 复习状态 | 节点卡片记忆徽章：琥珀色「N 张到期」/ 绿色「已巩固」，悬停显示总卡片数与平均稳定性 | 图谱画布（批量聚合） |
| 8 | 数据同步 | 评分 / AI 生成卡片后失效图谱统计缓存；删除笔记级联标记卡片 `memo_deleted`；笔记更新触发卡片过期检测 | 自动 |

## 技术实现

### 后端（Rust）

**核心逻辑 `core/src/review.rs`：**

- `create_deck_from_kg_node(conn, node_id)` — 从 KG 节点创建牌组：
  - BFS 收集节点及其全部后代（kg_node 禁止跨图父子，树内遍历）。
  - 标签取并集并按遍历顺序去重；无标签时报错提示。
  - 复用规则：同名牌组（`主题：{节点名}`）存在时更新其标签，避免重复创建。
- `kg_node_review_stats(conn, node_ids)` — 批量统计节点记忆状态：
  - 所有 NORMAL 笔记与标签只加载/提取一次；复习卡片按 `memo_uid` 一次 `GROUP BY` 查询，避免逐节点 N+1。
  - 关联笔记 = 标签匹配 ∪ 手动关联（`memo_kg_node` 表）。
  - 输出 `KgNodeReviewStats { node_id, memo_count, total_cards, due_count, avg_stability }`。
- `memo_review_stats(conn, memo_uid)` — 单篇笔记复习状态：
  - 单次聚合查询：卡片总数、到期数、新卡数、`MIN(due)` 下次到期时间。
  - `deck_id`：卡片数最多的牌组（笔记可能因标签重叠属于多个牌组）。
  - `stale` 过期检测：`memo.updated_ts > MAX(card.created_ts)` 即笔记在卡片生成后被编辑过。

**Tauri 命令 `src-tauri/src/commands/review.rs`（已注册于 `main.rs`）：**

| 命令 | 功能 |
|------|------|
| `review_create_deck_from_kg_node` | 从 KG 节点创建/复用牌组 |
| `review_kg_node_stats` | 批量节点记忆统计 |
| `review_memo_stats` | 单篇笔记复习状态（含过期标记） |
| `kg_list_memo_nodes`（commands/kg.rs） | 查询笔记关联的 KG 节点 |

### 前端（React）

| 文件 | 变更 |
|------|------|
| `hooks/useKgQueries.ts` | 新增 `useKgNodeReviewStats`（批量统计）、`useCreateDeckFromKgNode`（建牌组 mutation）、`useMemoKgNodes`（笔记 → 节点） |
| `components/Review/hooks.ts` | 新增 `useMemoReviewStats`（笔记复习状态，笔记更新时间作为触发依赖自动重取）；AI 生成卡片完成事件后失效图谱统计缓存 |
| `components/Review/CardReview.tsx` | 翻面后显示「查看原文」与所属 KG 节点跳转按钮（翻面前不查询节点，避免泄题）；评分成功后失效图谱统计缓存 |
| `components/Review/types.ts` | 新增 `MemoReviewStats` 接口 |
| `components/KnowledgeGraph/KgNodeCard.tsx` | 记忆状态徽章（到期/已巩固，悬停显示详情）+「复习此主题」快捷操作 |
| `components/KnowledgeGraph/KgCanvas.tsx` | 集成批量统计查询与建牌组跳转（`/review/{deckId}`） |
| `components/MemoDetailSidebar/MemoDetailSidebar.tsx` | 关联节点 chips（已有）+ 新增「复习状态」区块与过期提示 |

### 缓存与数据一致性

- 全局 React Query `staleTime: 30s`，评分 / 生成卡片后需显式失效 `nodeReviewStats` 查询（两处已接）。
- 笔记删除：`core/src/memo.rs::delete` 在事务内 `UPDATE review_card SET memo_deleted = 1 WHERE memo_uid = ?`；`memo_kg_node` 关联由外键 `ON DELETE CASCADE` + `PRAGMA foreign_keys = ON`（`store.rs`）自动清理。
- 图谱统计对孤儿数据有防御：`memo_info.get()` 返回 None 时跳过该笔记。

### i18n

`review.view-source` / `memo-stats-section` / `memo-cards` / `memo-due` / `memo-mastered` / `memo-next-due` / `memo-stale` 词条已同步 `zh-Hans.json` 与 `en.json`。

## 验证

- `cargo check`（src-tauri）：通过，仅既有无关 warning。
- `npx tsc --noEmit`：通过。
- 命令注册、i18n 词条、路由跳转（`/review/:deckId`、`/knowledge-graph/:graphId?select=:nodeId`）均已人工核对。

## 后续可选增强

- 过期卡片「重新生成」入口（侧栏提示处直达牌组重新生成）。
- 牌组级过期汇总（DeckList 标记含过期卡片的牌组）。
- 图谱整体记忆热力图（按节点平均稳定性着色）。
- 复习会话结束后自动返回来源图谱页。
