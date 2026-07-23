---
id: b-office-cli-guide
name: Office CLI 指南
description: 指导 office_cli 工具生成 Word/Excel/PPT 文档的子命令与参数格式（工具待实现，占位）
tools: [office_cli]
---

# Office CLI 使用指南

> 注意：`office_cli` 工具当前尚未实现。本 skill 为前向占位，待工具落地后填充实际内容。

## 预期子命令（草案）

- `word --template report --out {{path}}` 生成 Word
- `excel --sheets {{n}} --out {{path}}` 生成 Excel
- `ppt --slides {{n}} --out {{path}}` 生成 PPT

## 注意事项（待定）

- 路径必须为绝对路径
- 模板名见 templates 目录
- 此 skill 仅供参考，实际调用以工具实现为准
