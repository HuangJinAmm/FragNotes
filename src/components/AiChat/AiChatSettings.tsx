import { invoke } from "@tauri-apps/api/core";
import { PencilIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useTranslate } from "@/utils/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ProviderConfig } from "./types";
import { ProviderForm } from "./ProviderForm";

interface AiChatSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function AiChatSettings({ open, onOpenChange, onSaved }: AiChatSettingsProps) {
  const t = useTranslate();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [editing, setEditing] = useState<ProviderConfig | null>(null);

  useEffect(() => {
    if (open) {
      invoke<ProviderConfig[]>("list_providers").then(setProviders).catch(toast.error);
    }
  }, [open]);

  const handleSave = async (provider: ProviderConfig) => {
    const existing = providers.findIndex((p) => p.id === provider.id);
    const next = existing >= 0
      ? providers.map((p) => (p.id === provider.id ? provider : p))
      : [...providers, provider];
    try {
      await invoke<ProviderConfig[]>("save_providers_cmd", { providers: next });
      setProviders(next);
      setEditing(null);
      onSaved();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleDelete = async (id: string) => {
    const next = providers.filter((p) => p.id !== id);
    try {
      await invoke<ProviderConfig[]>("save_providers_cmd", { providers: next });
      setProviders(next);
      onSaved();
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t("aiChat.settingsTitle")}</DialogTitle>
        </DialogHeader>

        {editing ? (
          <ProviderForm
            provider={editing}
            onSave={handleSave}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {providers.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("aiChat.configureFirst")}</p>
            )}
            {providers.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-md border p-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{p.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {p.base_url} · {p.model}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button size="icon" variant="ghost" onClick={() => setEditing(p)}>
                    <PencilIcon className="size-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => handleDelete(p.id)}>
                    <TrashIcon className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
            <Button
              variant="outline"
              onClick={() =>
                setEditing({
                  id: crypto.randomUUID(),
                  name: "",
                  base_url: "",
                  api_key: "",
                  model: "",
                })
              }
            >
              <PlusIcon className="size-4 mr-1" />
              {t("aiChat.addProvider")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
