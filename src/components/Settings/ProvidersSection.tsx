import { invoke } from "@tauri-apps/api/core";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getErrorMessage } from "@/lib/error";
import { useTranslate } from "@/utils/i18n";
import { ProviderForm } from "@/components/AiChat/ProviderForm";
import type { ProviderConfig } from "@/components/AiChat/types";
import SettingGroup from "./SettingGroup";
import { SettingList, SettingListItem } from "./SettingList";
import SettingSection from "./SettingSection";

const emptyProvider = (): ProviderConfig => ({
  id: crypto.randomUUID(),
  name: "",
  base_url: "",
  api_key: "",
  model: "",
});

const ProvidersSection = () => {
  const t = useTranslate();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await invoke<ProviderConfig[]>("list_providers");
        setProviders(list);
      } catch (e) {
        toast.error(getErrorMessage(e, t("setting.providers.load-failed")));
      } finally {
        setLoading(false);
      }
    })();
  }, [t]);

  const handleEditorSave = async (provider: ProviderConfig) => {
    const existing = providers.findIndex((p) => p.id === provider.id);
    const next = existing >= 0
      ? providers.map((p) => (p.id === provider.id ? provider : p))
      : [...providers, provider];
    try {
      await invoke<ProviderConfig[]>("save_providers_cmd", { providers: next });
      setProviders(next);
      setEditorOpen(false);
    } catch (e) {
      toast.error(getErrorMessage(e, t("setting.providers.save-failed")));
    }
  };

  const handleDelete = (provider: ProviderConfig) => {
    if (!confirm(t("setting.providers.confirm-delete", { name: provider.name }))) return;
    const next = providers.filter((p) => p.id !== provider.id);
    invoke<ProviderConfig[]>("save_providers_cmd", { providers: next })
      .then(() => setProviders(next))
      .catch((e) => toast.error(getErrorMessage(e, t("setting.providers.delete-failed"))));
  };

  return (
    <SettingSection title={t("setting.providers.label")} description={t("setting.providers.description")}>
      <SettingGroup title={t("setting.providers.list")}>
        {loading ? (
          <p className="p-4 text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : providers.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t("setting.providers.empty")}</p>
        ) : (
          <SettingList>
            {providers.map((provider) => (
              <SettingListItem
                key={provider.id}
                label={provider.name}
                description={`${provider.base_url} · ${provider.model}`}
              >
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setEditingProvider(provider);
                      setEditorOpen(true);
                    }}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(provider)}>
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </SettingListItem>
            ))}
          </SettingList>
        )}
        <div className="p-2">
          <Button
            variant="outline"
            onClick={() => {
              setEditingProvider(emptyProvider());
              setEditorOpen(true);
            }}
          >
            <PlusIcon className="mr-2 size-4" />
            {t("setting.providers.create")}
          </Button>
        </div>
      </SettingGroup>

      <Dialog open={editorOpen} onOpenChange={(o) => { if (!o) setEditorOpen(false); }}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>
              {editingProvider && providers.some((p) => p.id === editingProvider.id)
                ? t("setting.providers.editor.edit")
                : t("setting.providers.editor.create")}
            </DialogTitle>
          </DialogHeader>
          {editingProvider && (
            <ProviderForm
              provider={editingProvider}
              onSave={handleEditorSave}
              onCancel={() => setEditorOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </SettingSection>
  );
};

export default ProvidersSection;
