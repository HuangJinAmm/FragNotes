import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  DownloadIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import dayjs from "dayjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getErrorMessage } from "@/lib/error";
import {
  useClearMemories,
  useCreateMemory,
  useDeleteMemory,
  useMemoryConfig,
  useMemoryList,
  useExportMemories,
  useImportMemories,
  useReindexMemories,
  useSaveMemoryConfig,
  useSetMemoryEnabled,
  useSourceSessionTitles,
  useUpdateMemory,
} from "@/hooks/useMemoryQueries";
import { openAiChatSession } from "@/components/AiChat/aiChatController";
import { downloadText } from "@/helpers/utils";
import { useTranslate } from "@/utils/i18n";
import { MEMORY_CONFIG_LIMITS, type AiMemoryDto, type MemoryConfigDto } from "@/types/memory";
import MemoryEditor from "./MemoryEditor";
import SettingGroup from "./SettingGroup";
import { SettingList, SettingListItem } from "./SettingList";
import SettingSection from "./SettingSection";

const MemorySection = () => {
  const t = useTranslate();
  const { data: memories = [], isLoading } = useMemoryList();
  const { data: config } = useMemoryConfig();
  const { data: sessionTitles } = useSourceSessionTitles();
  const saveConfigMut = useSaveMemoryConfig();
  const createMut = useCreateMemory();
  const updateMut = useUpdateMemory();
  const deleteMut = useDeleteMemory();
  const setEnabledMut = useSetMemoryEnabled();
  const reindexMut = useReindexMemories();
  const clearMut = useClearMemories();
  const exportMut = useExportMemories();
  const importMut = useImportMemories();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AiMemoryDto | null>(null);
  const [itemsDraft, setItemsDraft] = useState("");
  const [charsDraft, setCharsDraft] = useState("");
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!config) return;
    setItemsDraft(String(config.maxItems));
    setCharsDraft(String(config.maxChars));
  }, [config]);

  const patchConfig = (patch: Partial<MemoryConfigDto>) => {
    if (!config) return;
    saveConfigMut.mutate(
      { ...config, ...patch },
      { onError: (e) => toast.error(getErrorMessage(e, t("setting.memory.save-failed"))) },
    );
  };

  const clampNumber = (raw: string, min: number, max: number, fallback: number) => {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  };

  const commitMaxItems = (raw: string) => {
    const value = clampNumber(
      raw,
      MEMORY_CONFIG_LIMITS.minItems,
      MEMORY_CONFIG_LIMITS.maxItems,
      config?.maxItems ?? 20,
    );
    setItemsDraft(String(value));
    if (value !== config?.maxItems) patchConfig({ maxItems: value });
  };

  const commitMaxChars = (raw: string) => {
    const value = clampNumber(
      raw,
      MEMORY_CONFIG_LIMITS.minChars,
      MEMORY_CONFIG_LIMITS.maxChars,
      config?.maxChars ?? 800,
    );
    setCharsDraft(String(value));
    if (value !== config?.maxChars) patchConfig({ maxChars: value });
  };

  const handleToggle = (memory: AiMemoryDto, enabled: boolean) => {
    setEnabledMut.mutate(
      { id: memory.id, enabled },
      { onError: (e) => toast.error(getErrorMessage(e, t("setting.memory.toggle-failed"))) },
    );
  };

  const handleDelete = (memory: AiMemoryDto) => {
    deleteMut.mutate(memory.id, {
      onError: (e) => toast.error(getErrorMessage(e, t("setting.memory.delete-failed"))),
    });
  };

  const handleReindex = () => {
    reindexMut.mutate(undefined, {
      onSuccess: (count) =>
        count > 0
          ? toast.success(t("setting.memory.reindex-done", { count }))
          : toast(t("setting.memory.reindex-none")),
      onError: (e) => toast.error(getErrorMessage(e, t("setting.memory.reindex-failed"))),
    });
  };

  const handleExport = () => {
    exportMut.mutate(undefined, {
      onSuccess: (text) => {
        downloadText(
          `fragnote-memory-${dayjs().format("YYYYMMDD-HHmmss")}.json`,
          text,
          "application/json",
        );
        toast.success(t("setting.memory.export-done"));
      },
      onError: (e) => toast.error(getErrorMessage(e, t("setting.memory.export-failed"))),
    });
  };

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text();
      if (!text.trim()) {
        toast.error(t("setting.memory.import-empty"));
        return;
      }
      const report = await importMut.mutateAsync(text);
      toast.success(
        t("setting.memory.import-done", {
          imported: report.imported,
          merged: report.merged,
          skipped: report.skipped,
        }),
      );
    } catch (e) {
      toast.error(getErrorMessage(e, t("setting.memory.import-failed")));
    }
  };

  const handleClear = () => {
    if (!confirm(t("setting.memory.confirm-clear"))) return;
    clearMut.mutate(undefined, {
      onSuccess: (removed) => toast.success(t("setting.memory.cleared", { count: removed })),
      onError: (e) => toast.error(getErrorMessage(e, t("setting.memory.delete-failed"))),
    });
  };

  const handleEditorSave = async (draft: { kind: AiMemoryDto["kind"]; content: string; importance: number }) => {
    if (editing) {
      await updateMut.mutateAsync({
        id: editing.id,
        kind: draft.kind,
        content: draft.content,
        importance: draft.importance,
        enabled: editing.enabled,
      });
    } else {
      await createMut.mutateAsync(draft);
    }
  };

  return (
    <SettingSection title={t("setting.memory.label")} description={t("setting.memory.description")}>
      <SettingGroup title={t("setting.memory.settings")} description={t("setting.memory.settings-hint")}>
        <SettingList>
          <SettingListItem label={t("setting.memory.enabled")} description={t("setting.memory.enabled-hint")}>
            <Switch
              checked={config?.enabled ?? false}
              onCheckedChange={(v) => patchConfig({ enabled: v })}
            />
          </SettingListItem>
          <SettingListItem label={t("setting.memory.auto-extract")} description={t("setting.memory.auto-extract-hint")}>
            <Switch
              checked={config?.autoExtract ?? false}
              disabled={!config?.enabled}
              onCheckedChange={(v) => patchConfig({ autoExtract: v })}
            />
          </SettingListItem>
          <SettingListItem label={t("setting.memory.max-items")} description={t("setting.memory.max-items-hint")}>
            <Input
              className="w-20"
              type="number"
              min={MEMORY_CONFIG_LIMITS.minItems}
              max={MEMORY_CONFIG_LIMITS.maxItems}
              value={itemsDraft}
              disabled={!config?.enabled}
              onChange={(e) => setItemsDraft(e.target.value)}
              onBlur={(e) => commitMaxItems(e.target.value)}
            />
          </SettingListItem>
          <SettingListItem label={t("setting.memory.max-chars")} description={t("setting.memory.max-chars-hint")}>
            <Input
              className="w-24"
              type="number"
              min={MEMORY_CONFIG_LIMITS.minChars}
              max={MEMORY_CONFIG_LIMITS.maxChars}
              value={charsDraft}
              disabled={!config?.enabled}
              onChange={(e) => setCharsDraft(e.target.value)}
              onBlur={(e) => commitMaxChars(e.target.value)}
            />
          </SettingListItem>
          <SettingListItem label={t("setting.memory.reindex")} description={t("setting.memory.reindex-hint")}>
            <Button
              variant="outline"
              size="sm"
              onClick={handleReindex}
              disabled={!config?.enabled || reindexMut.isPending}
            >
              <RefreshCwIcon className="mr-2 h-4 w-4" />
              {reindexMut.isPending ? t("setting.memory.reindex-running") : t("setting.memory.reindex")}
            </Button>
          </SettingListItem>
          <SettingListItem label={t("setting.memory.backup")} description={t("setting.memory.backup-hint")}>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleExport}
                disabled={memories.length === 0 || exportMut.isPending}
              >
                <DownloadIcon className="mr-2 h-4 w-4" />
                {t("setting.memory.export")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => importInputRef.current?.click()}
                disabled={importMut.isPending}
              >
                <UploadIcon className="mr-2 h-4 w-4" />
                {t("setting.memory.import")}
              </Button>
            </div>
          </SettingListItem>
        </SettingList>
      </SettingGroup>

      {/* 隐藏的文件输入：记忆备份导入 */}
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleImportFile(file);
          // 重置 value 允许重复选择同一文件
          e.target.value = "";
        }}
      />

      <SettingGroup
        title={t("setting.memory.list")}
        description={t("setting.memory.list-hint")}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClear}
              disabled={memories.length === 0 || clearMut.isPending}
            >
              <Trash2Icon className="mr-2 h-4 w-4" />
              {t("setting.memory.clear-all")}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setEditorOpen(true);
              }}
            >
              <PlusIcon className="mr-2 h-4 w-4" />
              {t("setting.memory.create")}
            </Button>
          </>
        }
      >
        {isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : memories.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t("setting.memory.empty")}</p>
        ) : (
          <SettingList>
            {memories.map((memory) => (
              <SettingListItem
                key={memory.id}
                vertical
                label={
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {t(`setting.memory.kind.${memory.kind}`)}
                    </span>
                    <span className={memory.enabled ? "" : "text-muted-foreground line-through"}>
                      {memory.content}
                    </span>
                  </span>
                }
                description={
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>
                      {t("setting.memory.meta", {
                        source: t(`setting.memory.source.${memory.source}`),
                        importance: memory.importance,
                        hits: memory.hits,
                      })}
                    </span>
                    {memory.sourceSessionId !== null && (
                      <button
                        type="button"
                        onClick={() => openAiChatSession(memory.sourceSessionId!)}
                        title={t("setting.memory.source-session-hint")}
                        className="inline-flex max-w-[16rem] items-center gap-1 rounded px-1 text-primary hover:bg-muted"
                      >
                        <MessageSquareIcon className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          {sessionTitles?.get(memory.sourceSessionId) ??
                            t("setting.memory.source-session-fallback")}
                        </span>
                      </button>
                    )}
                  </span>
                }
              >
                <div className="flex items-center gap-3">
                  <Switch checked={memory.enabled} onCheckedChange={(v) => handleToggle(memory, v)} />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setEditing(memory);
                      setEditorOpen(true);
                    }}
                  >
                    <PencilIcon className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(memory)}>
                    <Trash2Icon className="h-4 w-4" />
                  </Button>
                </div>
              </SettingListItem>
            ))}
          </SettingList>
        )}
      </SettingGroup>

      <MemoryEditor
        open={editorOpen}
        memory={editing}
        onSave={handleEditorSave}
        onClose={() => setEditorOpen(false)}
      />
    </SettingSection>
  );
};

export default MemorySection;
