---
id: b-review-card-best-practices
name: 复习卡片最佳实践
description: 指导 create_review_cards 工具的卡片类型选择与 front/back 编写规范
tools: [create_review_cards]
---

# 复习卡片生成指南

## 卡片类型选择决策树

1. **basic** — 单向问答（"X 是什么？"）。默认选择，适合定义、事实。
2. **reversed** — 双向问答（"X ↔ 定义"）。适合术语 ↔ 概念的双向映射。
3. **cloze** — 填空（"___ 是 X"）。适合完整背诵定义、公式。必须提供 `cloze_answer`。
4. **concept** — 概念解释（"解释 X"）。适合需要展开论述的概念。
5. **compare** — 对比（"对比 A 与 B"）。适合易混淆概念。

## front/back 编写规范

- front：问题，简短明确，一句话。避免多问。
- back：答案，Markdown。包含"是什么 + 关键点 + （可选）例子"。
- 每张卡只考一个知识点。若笔记涉及多个，拆成多张卡。
- `angle` 字段：`定义` | `应用` | `对比` | `列举` | `原理`，反映考核角度。

## 示例

笔记内容："Rust 所有权规则：每个值有唯一所有者，作用域结束自动释放。"

生成卡片：
- card_type: `cloze`
- front: "`___` 规则：每个值有唯一所有者，作用域结束自动释放。"
- cloze_answer: "所有权"
- back: "**所有权**：Rust 内存安全核心机制。每个值有唯一所有者，所有者离开作用域时值自动 drop。"
- angle: `定义`
