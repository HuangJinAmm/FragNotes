import { HashIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
}

export default function KgTagEditor({ tags, onChange }: Props) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const trimmed = input.trim();
    if (!trimmed || tags.includes(trimmed)) return;
    onChange([...tags, trimmed]);
    setInput("");
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

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
    </div>
  );
}
