import { useState } from "react";
import toast from "react-hot-toast";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { getErrorMessage } from "@/lib/error";
import {
  useCreateSkill,
  useDeleteSkill,
  useSetSkillEnabled,
  useSkillList,
  useUpdateSkill,
} from "@/hooks/useSkillQueries";
import { useTranslate } from "@/utils/i18n";
import type { SkillDto } from "@/types/skill";
import SettingGroup from "./SettingGroup";
import { SettingList, SettingListItem } from "./SettingList";
import SettingSection from "./SettingSection";
import SkillEditor from "./SkillEditor";

const SkillsSection = () => {
  const t = useTranslate();
  const { data: skills = [], isLoading } = useSkillList();
  const createMut = useCreateSkill();
  const updateMut = useUpdateSkill();
  const deleteMut = useDeleteSkill();
  const setEnabledMut = useSetSkillEnabled();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillDto | null>(null);

  const builtin = skills.filter((s) => s.source === "builtin");
  const user = skills.filter((s) => s.source === "user");

  const handleToggle = (skill: SkillDto, enabled: boolean) => {
    setEnabledMut.mutate(
      { id: skill.id, enabled },
      {
        onError: (e) =>
          toast.error(getErrorMessage(e, t("setting.skills.toggle-failed"))),
      },
    );
  };

  const handleDelete = (skill: SkillDto) => {
    if (!confirm(t("setting.skills.confirm-delete", { name: skill.name }))) return;
    deleteMut.mutate(skill.id, {
      onError: (e) =>
        toast.error(getErrorMessage(e, t("setting.skills.delete-failed"))),
    });
  };

  const handleEditorSave = async (skill: SkillDto) => {
    if (editingSkill) {
      await updateMut.mutateAsync(skill);
    } else {
      await createMut.mutateAsync(skill);
    }
  };

  return (
    <SettingSection title={t("setting.skills.label")} description={t("setting.skills.description")}>
      <SettingGroup title={t("setting.skills.builtin")}>
        {isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : (
          <SettingList>
            {builtin.map((skill) => (
              <SettingListItem
                key={skill.id}
                label={skill.name}
                description={skill.description}
              >
                <div className="flex items-center gap-3">
                  <div className="flex flex-wrap gap-1">
                    {skill.tools.map((tool) => (
                      <span key={tool} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {tool}
                      </span>
                    ))}
                  </div>
                  <Switch
                    checked={skill.enabled}
                    onCheckedChange={(v) => handleToggle(skill, v)}
                  />
                </div>
              </SettingListItem>
            ))}
          </SettingList>
        )}
      </SettingGroup>

      <SettingGroup title={t("setting.skills.custom")}>
        <SettingList>
          {user.map((skill) => (
            <SettingListItem
              key={skill.id}
              label={skill.name}
              description={skill.description}
            >
              <div className="flex items-center gap-3">
                <div className="flex flex-wrap gap-1">
                  {skill.tools.map((tool) => (
                    <span key={tool} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {tool}
                    </span>
                  ))}
                </div>
                <Switch
                  checked={skill.enabled}
                  onCheckedChange={(v) => handleToggle(skill, v)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setEditingSkill(skill);
                    setEditorOpen(true);
                  }}
                >
                  <PencilIcon className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => handleDelete(skill)}>
                  <Trash2Icon className="h-4 w-4" />
                </Button>
              </div>
            </SettingListItem>
          ))}
        </SettingList>
        <div className="p-2">
          <Button
            variant="outline"
            onClick={() => {
              setEditingSkill(null);
              setEditorOpen(true);
            }}
          >
            <PlusIcon className="mr-2 h-4 w-4" />
            {t("setting.skills.create")}
          </Button>
        </div>
      </SettingGroup>

      <SkillEditor
        open={editorOpen}
        skill={editingSkill}
        onSave={handleEditorSave}
        onClose={() => setEditorOpen(false)}
      />
    </SettingSection>
  );
};

export default SkillsSection;
