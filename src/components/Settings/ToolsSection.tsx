import { useState } from "react";
import toast from "react-hot-toast";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { getErrorMessage } from "@/lib/error";
import {
  useCreateTool,
  useDeleteTool,
  useSetToolEnabled,
  useToolList,
  useUpdateTool,
} from "@/hooks/useToolQueries";
import { useTranslate } from "@/utils/i18n";
import {
  PERMISSION_BADGE_COLORS,
  PERMISSION_LABELS,
  type ToolDto,
} from "@/types/tool";
import SettingGroup from "./SettingGroup";
import { SettingList, SettingListItem } from "./SettingList";
import SettingSection from "./SettingSection";
import ToolEditor from "./ToolEditor";

const ToolsSection = () => {
  const t = useTranslate();
  const { data: tools = [], isLoading } = useToolList();
  const createMut = useCreateTool();
  const updateMut = useUpdateTool();
  const deleteMut = useDeleteTool();
  const setEnabledMut = useSetToolEnabled();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTool, setEditingTool] = useState<ToolDto | null>(null);

  const handleToggle = (tool: ToolDto, enabled: boolean) => {
    setEnabledMut.mutate(
      { id: tool.id, enabled },
      {
        onError: (e) =>
          toast.error(getErrorMessage(e, t("setting.tools.toggle-failed"))),
      },
    );
  };

  const handleDelete = (tool: ToolDto) => {
    if (!confirm(t("setting.tools.confirm-delete", { name: tool.name }))) return;
    deleteMut.mutate(tool.id, {
      onError: (e) =>
        toast.error(getErrorMessage(e, t("setting.tools.delete-failed"))),
    });
  };

  const handleEditorSave = async (tool: ToolDto) => {
    if (editingTool) {
      await updateMut.mutateAsync(tool);
    } else {
      await createMut.mutateAsync(tool);
    }
  };

  return (
    <SettingSection title={t("setting.tools.label")} description={t("setting.tools.description")}>
      <SettingGroup title={t("setting.tools.list")}>
        {isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : tools.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t("setting.tools.empty")}</p>
        ) : (
          <SettingList>
            {tools.map((tool) => (
              <SettingListItem
                key={tool.id}
                label={tool.name}
                description={tool.description}
              >
                <div className="flex items-center gap-3">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${PERMISSION_BADGE_COLORS[tool.permission]}`}>
                    {PERMISSION_LABELS[tool.permission]}
                  </span>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                    {tool.command}
                  </code>
                  <Switch
                    checked={tool.enabled}
                    onCheckedChange={(v) => handleToggle(tool, v)}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setEditingTool(tool);
                      setEditorOpen(true);
                    }}
                  >
                    <PencilIcon className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(tool)}>
                    <Trash2Icon className="h-4 w-4" />
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
              setEditingTool(null);
              setEditorOpen(true);
            }}
          >
            <PlusIcon className="mr-2 h-4 w-4" />
            {t("setting.tools.create")}
          </Button>
        </div>
      </SettingGroup>

      <ToolEditor
        open={editorOpen}
        tool={editingTool}
        onSave={handleEditorSave}
        onClose={() => setEditorOpen(false)}
      />
    </SettingSection>
  );
};

export default ToolsSection;
