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
import { getErrorMessage } from "@/lib/error";
import { useTranslate } from "@/utils/i18n";
import {
  BUILTIN_TOOL_NAMES,
  PERMISSION_BADGE_COLORS,
  PERMISSION_LABELS,
  type ToolDto,
  type ToolPermission,
} from "@/types/tool";

interface ToolEditorProps {
  open: boolean;
  /** 编辑模式时传入原 tool；新建模式为 null */
  tool: ToolDto | null;
  onSave: (tool: ToolDto) => Promise<void>;
  onClose: () => void;
}

const emptyTool = (): ToolDto => ({
  id: "",
  name: "",
  command: "echo hello",
  permission: "read_only",
  description: "",
  timeout_ms: 30000,
  enabled: true,
  created_ts: 0,
  updated_ts: 0,
});

const PERMISSIONS: ToolPermission[] = ["read_only", "writable", "executable", "dangerous"];

const ToolEditor = ({ open, tool, onSave, onClose }: ToolEditorProps) => {
  const t = useTranslate();
  const isEdit = tool !== null;
  const [draft, setDraft] = useState<ToolDto>(emptyTool());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(tool ? { ...tool } : emptyTool());
    }
  }, [open, tool]);

  const validate = (): string | null => {
    if (!isEdit && !draft.id.trim().replace(/^u-/, "")) {
      return t("setting.tools.editor.validation-id");
    }
    if (!/^[a-z0-9_]+$/.test(draft.name)) {
      return t("setting.tools.editor.validation-name");
    }
    if (BUILTIN_TOOL_NAMES.includes(draft.name as (typeof BUILTIN_TOOL_NAMES)[number])) {
      return t("setting.tools.editor.validation-name-builtin");
    }
    if (!draft.command.trim()) {
      return t("setting.tools.editor.validation-command");
    }
    if (!draft.description.trim()) {
      return t("setting.tools.editor.validation-description");
    }
    if (draft.timeout_ms < 1000 || draft.timeout_ms > 600000) {
      return t("setting.tools.editor.validation-timeout");
    }
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }
    const toSave: ToolDto = {
      ...draft,
      id: isEdit ? draft.id : `u-${draft.id.trim().replace(/^u-/, "")}`,
    };
    setSaving(true);
    try {
      await onSave(toSave);
      onClose();
    } catch (e) {
      toast.error(getErrorMessage(e, t("setting.tools.editor.save-failed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("setting.tools.editor.edit") : t("setting.tools.editor.create")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("setting.tools.editor.id")}</Label>
            <Input
              value={isEdit ? draft.id : draft.id.replace(/^u-/, "")}
              onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
              disabled={isEdit}
              placeholder="my-tool"
            />
            {!isEdit && (
              <p className="text-xs text-muted-foreground">
                {t("setting.tools.editor.id-hint")}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>{t("setting.tools.editor.name")}</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="git_status"
            />
          </div>
          <div className="space-y-2">
            <Label>{t("setting.tools.editor.command")}</Label>
            <Input
              value={draft.command}
              onChange={(e) => setDraft((d) => ({ ...d, command: e.target.value }))}
              placeholder="git status"
            />
            <p className="text-xs text-muted-foreground">
              {t("setting.tools.editor.command-hint")}
            </p>
          </div>
          <div className="space-y-2">
            <Label>{t("setting.tools.editor.permission")}</Label>
            <div className="flex flex-wrap gap-2">
              {PERMISSIONS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, permission: p }))}
                  className={`rounded border px-3 py-1.5 text-xs ${
                    draft.permission === p
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background hover:bg-accent"
                  }`}
                >
                  <span className={`mr-1.5 inline-block rounded px-1 py-0.5 text-[10px] ${PERMISSION_BADGE_COLORS[p]}`}>
                    {PERMISSION_LABELS[p]}
                  </span>
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t("setting.tools.editor.description")}</Label>
            <Input
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder={t("setting.tools.editor.description-placeholder")}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("setting.tools.editor.timeout")}</Label>
            <Input
              type="number"
              min={1000}
              max={600000}
              step={1000}
              value={draft.timeout_ms}
              onChange={(e) => setDraft((d) => ({ ...d, timeout_ms: Number(e.target.value) }))}
            />
            <p className="text-xs text-muted-foreground">
              {t("setting.tools.editor.timeout-hint")}
            </p>
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

export default ToolEditor;
