import { HashIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { useTagCounts } from "@/hooks/useUserQueries";

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
}

export default function KgTagEditor({ tags, onChange }: Props) {
  const [input, setInput] = useState("");
  // 拉取当前用户已有标签，用于输入补全
  const { data: tagCounts = {} } = useTagCounts(true);
  const knownTags = useMemo(
    () => Array.from(new Set([...Object.keys(tagCounts), ...tags])).sort(),
    [tagCounts, tags],
  );

  const addTag = () => {
    // 去除前导 # 与空白，与后端存储格式及笔记 #tag 提取格式对齐
    const trimmed = input.trim().replace(/^#+/, "").trim();
    if (!trimmed || tags.includes(trimmed)) return;
    onChange([...tags, trimmed]);
    setInput("");
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  const datalistId = "kg-tag-editor-known-tags";

  return (
    <div className="flex flex-wrap gap-1.5 rounded-md border border-border p-2">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          <HashIcon className="h-3 w-3" />
          {tag}
          <button type="button" onClick={() => removeTag(tag)} className="hover:text-destructive">
            <XIcon className="h-3 w-3" />
          </button>
        </span>
      ))}
      <Input
        type="text"
        list={datalistId}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addTag();
          }
        }}
        onBlur={addTag}
        placeholder="输入标签后回车"
        className="h-6 min-w-[80px] border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
      />
      <datalist id={datalistId}>
        {knownTags.filter((t) => !tags.includes(t)).map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
    </div>
  );
}
