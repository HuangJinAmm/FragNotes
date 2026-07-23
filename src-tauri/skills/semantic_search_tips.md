---
id: b-semantic-search-tips
name: 语义搜索使用提示
description: 指导 search_semantic 工具的查询表达优化与首次模型下载提示
tools: [search_semantic]
---

# 语义搜索使用指南

## 何时用语义搜索 vs list_memos

- **list_memos(query=...)** — 全文搜索（FTS），适合精确关键词匹配。
- **search_semantic(query=...)** — 语义搜索，按含义相似度查找。适合"关于某主题的想法"这类模糊查询。

## 查询表达优化

- 用**自然语言短语**，不要堆关键词。"如何管理时间" 优于 "时间 管理"。
- 描述**意图/主题**，而非复制笔记标题。"关于 Rust 内存安全的思考" 优于 "Rust"。
- 一次只查一个主题。多主题分多次调用。

## 首次调用延迟

首次调用会下载嵌入模型（约 90MB），可能耗时数十秒。后续调用快。若用户等待，提示此情况。

## 返回结果

返回 `memos` 数组，每项含 `uid` + `content` + `score`（0~1，越高越相似）。用 `get_memo(uid)` 取完整内容。
