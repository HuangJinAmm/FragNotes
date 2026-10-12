import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getErrorMessage } from "@/lib/error";
import { useTranslate } from "@/utils/i18n";
import { MEMORY_KINDS, type AiMemoryDto, type MemoryKind } from "@/types/memory";

interface MemoryEditorProps {
  open: boolean;
  /** 编辑模式传入原记忆；新建模式为 null */
  memory: AiMemoryDto | null;
  onSave: (draft: { kind: MemoryKind; content: string; importance: number }) => Promise<void>;
  onClose: () => void;
}

const IMPORTANCE_LEVELS = [1, 2, 3, 4, 5];

const MemoryEditor = ({ open, memory, onSave, onClose }: MemoryEditorProps) => {
  const t = useTranslate();
  const isEdit = memory !== null;
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [content, setContent] = useState("");
  const [importance, setImportance] = useState(3);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKind(memory?.kind ?? "fact");
    setContent(memory?.content ?? "");
    setImportance(memory?.importance ?? 3);
  }, [open, memory]);

  const handleSave = async () => {
    if (!content.trim()) {
      toast.error(t("setting.memory.editor.validation-required"));
      return;
    }
    setSaving(true);
    try {
      await onSave({ kind, content: content.trim(), importance });
      onClose();
    } catch (e) {
      toast.error(getErrorMessage(e, t("setting.memory.editor.save-failed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("setting.memory.editor.edit") : t("setting.memory.editor.create")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("setting.memory.editor.kind")}</Label>
            <div className="flex flex-wrap gap-2">
              {MEMORY_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`rounded border px-2 py-1 text-xs ${
                    kind === k
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background hover:bg-accent"
                  }`}
                >
                  {t(`setting.memory.kind.${k}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t("setting.memory.editor.content")}</Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={3}
              placeholder={t("setting.memory.editor.content-placeholder")}
            />
            <p className="text-xs text-muted-foreground">{t("setting.memory.editor.content-hint")}</p>
          </div>
          <div className="space-y-2">
            <Label>{t("setting.memory.editor.importance")}</Label>
            <div className="flex flex-wrap gap-2">
              {IMPORTANCE_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => setImportance(level)}
                  className={`h-8 w-8 rounded border text-xs ${
                    importance === level
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background hover:bg-accent"
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("setting.memory.editor.importance-hint")}</p>
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

export default MemoryEditor;
