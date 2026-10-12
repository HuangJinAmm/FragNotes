-- AI 记忆的向量索引（语义召回）
-- 384 维，对应 all-MiniLM-L6-v2，与 memo_vec 一致
-- rowid 与 ai_memory.id 一一对应；无外键，删除记忆时由 core/src/memory.rs 手动清理
-- 注意：向量为可选能力——模型不可用或未生成向量时，召回自动回退到关键词打分

CREATE VIRTUAL TABLE IF NOT EXISTS ai_memory_vec USING vec0(
    embedding float[384]
);
