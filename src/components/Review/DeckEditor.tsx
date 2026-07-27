import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslate } from "@/utils/i18n";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: { id: number; name: string; tags: string[]; cards_per_memo: number } | null;
  onSubmit: (data: { name: string; tags: string[]; cards_per_memo: number }) => void;
}

const DeckEditor = ({ open, onOpenChange, initial, onSubmit }: Props) => {
  const t = useTranslate();
  const [name, setName] = useState(initial?.name ?? "");
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [cardsPerMemo, setCardsPerMemo] = useState(initial?.cards_per_memo ?? 2);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 加载已有标签
  useEffect(() => {
    if (!open) return;
    invoke<Array<{ tag: string; count: number }>>("list_tags")
      .then((rows) => setAvailableTags(rows.map((r) => r.tag).sort((a, b) => a.localeCompare(b))))
      .catch(() => setAvailableTags([]));
  }, [open]);

  // 重置状态
  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setTags(initial?.tags ?? []);
      setTagInput("");
      setCardsPerMemo(initial?.cards_per_memo ?? 2);
      setActiveSuggestion(-1);
      setShowSuggestions(false);
    }
  }, [open, initial]);

  // 根据当前输入计算建议（排除已选）
  const suggestions = useMemo(() => {
    const q = tagInput.trim().replace(/^#/, "").toLowerCase();
    if (!q) return [];
    return availableTags
      .filter((tag) => tag.toLowerCase().includes(q) && !tags.includes(tag))
      .slice(0, 8);
  }, [tagInput, availableTags, tags]);

  // 当建议列表变化时，重置选中项
  useEffect(() => {
    setActiveSuggestion(suggestions.length > 0 ? 0 : -1);
  }, [suggestions]);

  const addTag = (raw: string) => {
    const trimmed = raw.trim().replace(/^#/, "");
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed]);
    }
    setTagInput("");
    setShowSuggestions(false);
    setActiveSuggestion(-1);
    inputRef.current?.focus();
  };

  const removeTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag));
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTagInput(e.target.value);
    setShowSuggestions(true);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      setActiveSuggestion((i) => (i + 1) % suggestions.length);
      setShowSuggestions(true);
    } else if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      setActiveSuggestion((i) => (i - 1 + suggestions.length) % suggestions.length);
      setShowSuggestions(true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (showSuggestions && activeSuggestion >= 0 && suggestions[activeSuggestion]) {
        addTag(suggestions[activeSuggestion]);
      } else {
        addTag(tagInput);
      }
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      setActiveSuggestion(-1);
    }
  };

  const handleSuggestionClick = (tag: string) => {
    addTag(tag);
  };

  const handleSubmit = () => {
    if (!name.trim()) return;
    onSubmit({ name: name.trim(), tags, cards_per_memo: cardsPerMemo });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? t("review.edit-deck") : t("review.create-deck")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>{t("review.deck-name")}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("review.deck-name-placeholder")}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("review.deck-tags")}</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  ref={inputRef}
                  value={tagInput}
                  onChange={handleInputChange}
                  onKeyDown={handleInputKeyDown}
                  onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                  placeholder={t("review.deck-tags-placeholder")}
                />
                {showSuggestions && suggestions.length > 0 && (
                  <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-md max-h-56 overflow-auto">
                    {suggestions.map((tag, idx) => (
                      <button
                        key={tag}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          handleSuggestionClick(tag);
                        }}
                        onMouseEnter={() => setActiveSuggestion(idx)}
                        className={`flex w-full items-center px-3 py-2 text-sm text-left ${
                          idx === activeSuggestion ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                        }`}
                      >
                        #{tag}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <Button type="button" variant="outline" onClick={() => addTag(tagInput)} disabled={!tagInput.trim()}>
                <Plus className="size-4" />
              </Button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-sm"
                  >
                    #{tag}
                    <button onClick={() => removeTag(tag)} className="hover:text-destructive">
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Label>{t("review.cards-per-memo")}</Label>
            <Input
              type="number"
              min={1}
              max={10}
              value={cardsPerMemo}
              onChange={(e) => setCardsPerMemo(Number(e.target.value) || 1)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim()}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DeckEditor;
