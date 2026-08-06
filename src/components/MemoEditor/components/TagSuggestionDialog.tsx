import { Loader2Icon, PlusIcon, XIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTranslate } from "@/utils/i18n";
import { MAX_TAG_LENGTH, TAG_CHAR_CLASS } from "@/utils/tag-grammar";

// Validates that a whole tag name consists only of characters allowed by the
// shared tag grammar (see @/utils/tag-grammar). Built once — the class is
// composed of Unicode property escapes, so the `u` flag is mandatory.
const TAG_VALIDATE_RE = new RegExp(`^${TAG_CHAR_CLASS}+$`, "u");

interface TagSuggestionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading: boolean;
  suggestedTags: string[];
  existingTags: string[];
  onConfirm: (selectedTags: string[]) => void;
  onSkip: () => void;
}

const TagSuggestionDialog = ({
  open,
  onOpenChange,
  loading,
  suggestedTags,
  existingTags,
  onConfirm,
  onSkip,
}: TagSuggestionDialogProps) => {
  const t = useTranslate();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset selection when dialog reopens with new suggestions
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setSelected(new Set());
      setInputValue("");
      setError(null);
    }
    onOpenChange(next);
  };

  const toggleTag = (tag: string) => {
    setError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  };

  const removeTag = (tag: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(tag);
      return next;
    });
  };

  // Manually-entered tags that don't appear in the AI suggestion list — shown as
  // removable chips. A manual tag that matches a suggestion reuses the checkbox
  // above, so it isn't duplicated here.
  const manualTags = Array.from(selected).filter(
    (tag) => !suggestedTags.includes(tag),
  );

  const addManualTag = () => {
    // Strip a leading `#` and surrounding whitespace before validating, so users
    // can type either "#foo" or "foo".
    const normalized = inputValue.replace(/^#/, "").trim();
    if (!normalized) {
      setInputValue("");
      return;
    }
    if (normalized.length > MAX_TAG_LENGTH || !TAG_VALIDATE_RE.test(normalized)) {
      setError(t("editor.auto-tag.invalid-tag"));
      return;
    }
    setError(null);
    setInputValue("");
    setSelected((prev) => {
      const next = new Set(prev);
      next.add(normalized);
      return next;
    });
  };

  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addManualTag();
    }
  };

  const handleConfirm = () => {
    onConfirm(Array.from(selected));
    setSelected(new Set());
    setInputValue("");
    setError(null);
  };

  const handleSkip = () => {
    onSkip();
    setSelected(new Set());
    setInputValue("");
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("editor.auto-tag.dialog-title")}</DialogTitle>
          <DialogDescription>{t("editor.auto-tag.dialog-description")}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            <span className="text-sm">{t("editor.auto-tag.suggesting")}</span>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {existingTags.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {t("editor.auto-tag.existing-tags")}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {existingTags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {t("editor.auto-tag.suggested-tags")}
              </p>
              {suggestedTags.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("editor.auto-tag.no-suggestions")}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {suggestedTags.map((tag) => (
                    <label
                      key={tag}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent cursor-pointer"
                    >
                      <Checkbox
                        checked={selected.has(tag)}
                        onCheckedChange={() => toggleTag(tag)}
                      />
                      <span className="text-sm">#{tag}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {t("editor.auto-tag.custom-tags")}
              </p>
              {manualTags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {manualTags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => removeTag(tag)}
                      className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary transition-colors hover:bg-primary/20"
                    >
                      #{tag}
                      <XIcon className="size-3" />
                    </button>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleInputKeyDown}
                  placeholder={t("editor.auto-tag.custom-tag-placeholder")}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addManualTag}
                  disabled={!inputValue.trim()}
                >
                  <PlusIcon className="size-4" />
                  {t("editor.auto-tag.add-tag")}
                </Button>
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <DialogClose asChild>
            <Button variant="ghost" onClick={handleSkip}>
              {t("editor.auto-tag.save-without-tags")}
            </Button>
          </DialogClose>
          {!loading && (
            <Button onClick={handleConfirm} disabled={selected.size === 0}>
              {t("editor.auto-tag.add-and-save")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default TagSuggestionDialog;
