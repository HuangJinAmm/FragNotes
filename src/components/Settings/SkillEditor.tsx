import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getErrorMessage } from "@/lib/error";
import { useTranslate } from "@/utils/i18n";
import { KNOWN_TOOL_NAMES, type SkillDto } from "@/types/skill";

interface SkillEditorProps {
  open: boolean;
  /** 编辑模式时传入原 skill；新建模式为 null */
  skill: SkillDto | null;
  onSave: (skill: SkillDto) => Promise<void>;
  onClose: () => void;
}

const emptySkill = (): SkillDto => ({
  id: "",
  name: "",
  description: "",
  tools: [],
  body: "",
  enabled: true,
  source: "user",
  created_ts: 0,
  updated_ts: 0,
});

const SkillEditor = ({ open, skill, onSave, onClose }: SkillEditorProps) => {
  const t = useTranslate();
  const isEdit = skill !== null;
  const [draft, setDraft] = useState<SkillDto>(emptySkill());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(skill ? { ...skill } : emptySkill());
    }
  }, [open, skill]);

  const toggleTool = (tool: string) => {
    setDraft((d) => ({
      ...d,
      tools: d.tools.includes(tool)
        ? d.tools.filter((x) => x !== tool)
        : [...d.tools, tool],
    }));
  };

  const handleSave = async () => {
    const slug = draft.id.trim().replace(/^u-/, "");
    if (!slug || !draft.name.trim() || !draft.description.trim() || !draft.body.trim()) {
      toast.error(t("setting.skills.editor.validation-required"));
      return;
    }
    const toSave: SkillDto = {
      ...draft,
      id: isEdit ? draft.id : `u-${slug}`,
      source: "user",
    };
    setSaving(true);
    try {
      await onSave(toSave);
      onClose();
    } catch (e) {
      toast.error(getErrorMessage(e, t("setting.skills.editor.save-failed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("setting.skills.editor.edit") : t("setting.skills.editor.create")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("setting.skills.editor.id")}</Label>
            <Input
              value={isEdit ? draft.id : draft.id.replace(/^u-/, "")}
              onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
              disabled={isEdit}
              placeholder="my-skill"
            />
            {!isEdit && (
              <p className="text-xs text-muted-foreground">
                {t("setting.skills.editor.id-hint")}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>{t("setting.skills.editor.name")}</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("setting.skills.editor.description")}</Label>
            <Input
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("setting.skills.editor.tools")}</Label>
            <div className="flex flex-wrap gap-2">
              {KNOWN_TOOL_NAMES.map((tool) => (
                <button
                  key={tool}
                  type="button"
                  onClick={() => toggleTool(tool)}
                  className={`rounded border px-2 py-1 text-xs ${
                    draft.tools.includes(tool)
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background hover:bg-accent"
                  }`}
                >
                  {tool}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t("setting.skills.editor.body")}</Label>
            <Textarea
              value={draft.body}
              onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
              className="font-mono text-sm"
              rows={12}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SkillEditor;
