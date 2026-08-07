import { useState } from "react";
import { useTranslate } from "@/utils/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PROVIDER_PRESETS, type ProviderConfig, type ProviderPreset } from "./types";

interface ProviderFormProps {
  provider: ProviderConfig;
  onSave: (p: ProviderConfig) => void;
  onCancel: () => void;
}

/// Provider 编辑表单（不含 Dialog 外壳），供 AiChatSettings 与配置中心复用。
export function ProviderForm({ provider, onSave, onCancel }: ProviderFormProps) {
  const t = useTranslate();
  const [form, setForm] = useState<ProviderConfig>(provider);

  const applyPreset = (preset: ProviderPreset) => {
    setForm({
      ...form,
      name: preset.name,
      base_url: preset.base_url,
      model: preset.model,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {PROVIDER_PRESETS.map((preset) => (
          <Button key={preset.label} size="sm" variant="outline" onClick={() => applyPreset(preset)}>
            {preset.label}
          </Button>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <Label>{t("aiChat.name")}</Label>
        <Input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="OpenAI"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label>{t("aiChat.baseUrl")}</Label>
        <Input
          value={form.base_url}
          onChange={(e) => setForm({ ...form, base_url: e.target.value })}
          placeholder="https://api.openai.com/v1"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label>{t("aiChat.apiKey")}</Label>
        <Input
          type="password"
          value={form.api_key}
          onChange={(e) => setForm({ ...form, api_key: e.target.value })}
          placeholder="sk-..."
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label>{t("aiChat.model")}</Label>
        <Input
          value={form.model}
          onChange={(e) => setForm({ ...form, model: e.target.value })}
          placeholder="gpt-4o-mini"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t("aiChat.cancel")}
        </Button>
        <Button onClick={() => onSave(form)} disabled={!form.name || !form.base_url || !form.model}>
          {t("aiChat.save")}
        </Button>
      </div>
    </div>
  );
}
