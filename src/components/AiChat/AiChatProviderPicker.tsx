import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useTranslate } from "@/utils/i18n";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProviderConfig } from "./types";

/// localStorage key for the currently selected AI chat provider.
/// Shared so non-chat features (e.g. suggest_tags) can read the same value
/// to keep their LLM calls in sync with the chat panel's selection.
export const AI_CHAT_ACTIVE_PROVIDER_STORAGE_KEY = "ai_chat.active_provider";

interface AiChatProviderPickerProps {
  /// 当前选中的 provider id（由父组件持有并初始化）
  value: string | null;
  onProviderChange: (id: string | null) => void;
  /// 外部递增的刷新信号:值变化时重新加载 provider 列表。
  /// 用于在 AiChatSettings 保存后通知 picker 刷新,而无需关闭面板重开。
  refreshKey?: number;
}

export function AiChatProviderPicker({
  value,
  onProviderChange,
  refreshKey,
}: AiChatProviderPickerProps) {
  const t = useTranslate();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);

  // 加载 provider 列表用于渲染下拉项；选中状态由父组件 value 控制（受控模式）。
  useEffect(() => {
    let cancelled = false;
    invoke<ProviderConfig[]>("list_providers")
      .then((list) => {
        if (cancelled) return;
        setProviders(list);
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const handleChange = (v: string) => {
    localStorage.setItem(AI_CHAT_ACTIVE_PROVIDER_STORAGE_KEY, v);
    onProviderChange(v);
  };

  // 使用 "" 而非 undefined 作为空值,确保 Radix Select 始终处于受控模式,
  // 避免 undefined → string 切换时选中值无法正确渲染。
  return (
    <Select value={value ?? ""} onValueChange={handleChange}>
      <SelectTrigger size="sm" className="w-auto min-w-[120px]">
        <SelectValue placeholder={t("aiChat.selectProvider")} />
      </SelectTrigger>
      <SelectContent>
        {providers.length === 0 && (
          <SelectItem value="__empty__" disabled>
            {t("aiChat.configureFirst")}
          </SelectItem>
        )}
        {providers.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
