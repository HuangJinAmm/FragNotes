import { Loader2Icon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
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
import { useTagCounts } from "@/hooks/useUserQueries";
import { useTranslate } from "@/utils/i18n";
import { MAX_TAG_LENGTH, TAG_CHAR_CLASS } from "@/utils/tag-grammar";

// Validates that a whole tag name consists only of characters allowed by the
// shared tag grammar (see @/utils/tag-grammar). Built once — the class is
// composed of Unicode property escapes, so the `u` flag is mandatory.
const TAG_VALIDATE_RE = new RegExp(`^${TAG_CHAR_CLASS}+$`, "u");

// Max number of autocomplete suggestions shown at once. Keeps the dropdown
// short enough to fit inside the dialog without scrolling on most screens.
const MAX_SUGGESTIONS = 8;

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
  // All tag names that already exist somewhere in the app (across the current
  // user's memos). Used to power the manual-input autocomplete so users can
  // reuse existing tags instead of retyping them.
  const { data: tagCounts = {} } = useTagCounts(true);
  const knownTags = useMemo(() => Object.keys(tagCounts).sort(), [tagCounts]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Index of the highlighted option in `autocompleteItems`, or -1 when no row
  // is highlighted. -1 lets Enter fall through to "add the typed text as-is".
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset selection when dialog reopens with new suggestions
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setSelected(new Set());
      setInputValue("");
      setError(null);
      setHighlightedIndex(-1);
      setAutocompleteOpen(false);
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
  const manualTags = useMemo(
    () => Array.from(selected).filter((tag) => !suggestedTags.includes(tag)),
    [selected, suggestedTags],
  );

  // Autocomplete candidates: existing tags that start with the typed text
  // (case-insensitive), excluding tags the user has already selected so the
  // list never offers a tag that's already been added.
  const autocompleteItems = useMemo(() => {
    const typed = inputValue.replace(/^#/, "").trim().toLowerCase();
    if (!typed) return [];
    const out: string[] = [];
    for (const tag of knownTags) {
      if (selected.has(tag)) continue;
      if (tag.toLowerCase().startsWith(typed)) {
        out.push(tag);
        if (out.length >= MAX_SUGGESTIONS) break;
      }
    }
    return out;
  }, [inputValue, knownTags, selected]);

  // Keep the highlight within bounds whenever the candidate list changes.
  useEffect(() => {
    setHighlightedIndex(autocompleteItems.length > 0 ? 0 : -1);
  }, [autocompleteItems]);

  const addManualTag = (tag?: string) => {
    // When called from the dropdown, `tag` is the chosen suggestion; otherwise
    // fall back to the current input value. Strip a leading `#` and trim.
    const raw = (tag ?? inputValue).replace(/^#/, "").trim();
    if (!raw) {
      setInputValue("");
      setAutocompleteOpen(false);
      return;
    }
    if (raw.length > MAX_TAG_LENGTH || !TAG_VALIDATE_RE.test(raw)) {
      setError(t("editor.auto-tag.invalid-tag"));
      return;
    }
    setError(null);
    setInputValue("");
    setAutocompleteOpen(false);
    setHighlightedIndex(-1);
    setSelected((prev) => {
      const next = new Set(prev);
      next.add(raw);
      return next;
    });
    // Refocus so the user can immediately type the next tag.
    inputRef.current?.focus();
  };

  const handleInputChange = (value: string) => {
    setInputValue(value);
    setError(null);
    setAutocompleteOpen(true);
  };

  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (autocompleteOpen && highlightedIndex >= 0 && highlightedIndex < autocompleteItems.length) {
        addManualTag(autocompleteItems[highlightedIndex]);
      } else {
        addManualTag();
      }
      return;
    }
    if (autocompleteItems.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAutocompleteOpen(true);
      setHighlightedIndex((i) => (i + 1) % autocompleteItems.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setAutocompleteOpen(true);
      setHighlightedIndex((i) => (i <= 0 ? autocompleteItems.length - 1 : i - 1));
    } else if (e.key === "Escape") {
      e.preventDefault();
      setAutocompleteOpen(false);
      setHighlightedIndex(-1);
    }
  };

  const handleInputBlur = () => {
    // Defer closing so a click on a dropdown row can fire before the blur
    // tears it down. The dropdown row's onMouseDown prevents default to keep
    // focus on the input, but a small timeout is a cheap safety net.
    window.setTimeout(() => setAutocompleteOpen(false), 150);
  };

  const handleConfirm = () => {
    onConfirm(Array.from(selected));
    setSelected(new Set());
    setInputValue("");
    setError(null);
    setHighlightedIndex(-1);
    setAutocompleteOpen(false);
  };

  const handleSkip = () => {
    onSkip();
    setSelected(new Set());
    setInputValue("");
    setError(null);
    setHighlightedIndex(-1);
    setAutocompleteOpen(false);
  };

  const showAutocomplete = autocompleteOpen && autocompleteItems.length > 0;

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
              <div className="relative flex gap-2">
                <Input
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => handleInputChange(e.target.value)}
                  onKeyDown={handleInputKeyDown}
                  onBlur={handleInputBlur}
                  onFocus={() => setAutocompleteOpen(true)}
                  placeholder={t("editor.auto-tag.custom-tag-placeholder")}
                  autoComplete="off"
                  aria-autocomplete="list"
                  aria-expanded={showAutocomplete}
                  aria-controls="tag-autocomplete-listbox"
                  aria-activedescendant={
                    showAutocomplete && highlightedIndex >= 0
                      ? `tag-autocomplete-option-${highlightedIndex}`
                      : undefined
                  }
                />
                {showAutocomplete && (
                  <div
                    id="tag-autocomplete-listbox"
                    role="listbox"
                    className="absolute left-0 right-0 top-full z-dropdown mt-1 max-h-48 overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
                  >
                    {autocompleteItems.map((tag, index) => (
                      <button
                        key={tag}
                        id={`tag-autocomplete-option-${index}`}
                        type="button"
                        role="option"
                        aria-selected={index === highlightedIndex}
                        onMouseDown={(e) => {
                          // Prevent the input from losing focus on click.
                          e.preventDefault();
                        }}
                        onMouseEnter={() => setHighlightedIndex(index)}
                        onClick={() => addManualTag(tag)}
                        className={
                          index === highlightedIndex
                            ? "flex w-full items-center gap-2 rounded-sm bg-accent px-2 py-1.5 text-left text-sm"
                            : "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                        }
                      >
                        <span className="text-muted-foreground">#</span>
                        <span>{tag}</span>
                      </button>
                    ))}
                  </div>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => addManualTag()}
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
