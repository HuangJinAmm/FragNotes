import dayjs from "dayjs";
import { HashIcon, type LucideIcon, SearchIcon, SparklesIcon, TypeIcon } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type MemoFilter, useMemoFilterContext } from "@/contexts/MemoFilterContext";
import { cn } from "@/lib/utils";
import { useTranslate } from "@/utils/i18n";
import MemoDisplaySettingMenu from "./MemoDisplaySettingMenu";

/** 解析 from: 日期表达式，返回 ISO 日期字符串 (YYYY-MM-DD) */
function parseFromDateExpr(expr: string): string | null {
  const lower = expr.toLowerCase();
  const now = dayjs();

  if (lower === "today") return now.format("YYYY-MM-DD");
  if (lower === "yesterday") return now.subtract(1, "day").format("YYYY-MM-DD");

  // Nd = N days ago, Nw = N weeks ago
  const matchD = lower.match(/^(\d+)d$/);
  if (matchD) return now.subtract(parseInt(matchD[1], 10), "day").format("YYYY-MM-DD");

  const matchW = lower.match(/^(\d+)w$/);
  if (matchW) return now.subtract(parseInt(matchW[1], 10), "week").format("YYYY-MM-DD");

  // YYYY-MM-DD 格式
  const parsed = dayjs(expr);
  if (parsed.isValid()) return parsed.format("YYYY-MM-DD");

  return null;
}

/** 解析搜索语法，返回结构化过滤器和剩余文本 */
function parseSearchSyntax(
  text: string,
): { filters: MemoFilter[]; remainingWords: string[] } {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  const filters: MemoFilter[] = [];
  const remainingWords: string[] = [];

  for (const token of tokens) {
    // tag:xxx
    const tagMatch = token.match(/^tag:(.+)$/i);
    if (tagMatch) {
      filters.push({ factor: "tagSearch", value: tagMatch[1] });
      continue;
    }

    // from:DATE
    const fromMatch = token.match(/^from:(.+)$/i);
    if (fromMatch) {
      const dateStr = parseFromDateExpr(fromMatch[1]);
      if (dateStr) {
        filters.push({ factor: "fromDate", value: dateStr });
      }
      continue;
    }

    // has:link|tasklist|code
    const hasMatch = token.match(/^has:(.+)$/i);
    if (hasMatch) {
      const prop = hasMatch[1].toLowerCase();
      if (prop === "link") {
        filters.push({ factor: "property.hasLink", value: "" });
      } else if (prop === "tasklist" || prop === "task") {
        filters.push({ factor: "property.hasTaskList", value: "" });
      } else if (prop === "code") {
        filters.push({ factor: "property.hasCode", value: "" });
      }
      continue;
    }

    // is:pinned
    const isMatch = token.match(/^is:(.+)$/i);
    if (isMatch) {
      const prop = isMatch[1].toLowerCase();
      if (prop === "pinned") {
        filters.push({ factor: "pinned", value: "" });
      }
      continue;
    }

    // 无前缀 → 关键词
    remainingWords.push(token);
  }

  return { filters, remainingWords };
}

/** 搜索模式优先级：标签 > 文本（关键词）> 语义 */
type SearchMode = "tag" | "keyword" | "semantic";

/** 点击模式按钮时的切换顺序，与优先级一致（标签 → 文本 → 语义） */
const MODE_CYCLE: Record<SearchMode, SearchMode> = {
  tag: "keyword",
  keyword: "semantic",
  semantic: "tag",
};

const MODE_ICON: Record<SearchMode, LucideIcon> = {
  tag: HashIcon,
  keyword: TypeIcon,
  semantic: SparklesIcon,
};

const MODE_LABEL_KEY = {
  tag: "memo.search-mode-tag",
  keyword: "memo.search-mode-keyword",
  semantic: "memo.search-mode-semantic",
} as const;

const MODE_PLACEHOLDER_KEY = {
  tag: "memo.search-placeholder-tag",
  keyword: "memo.search-placeholder",
  semantic: "memo.search-placeholder-semantic",
} as const;

/** 默认进入标签搜索模式（优先级最高） */
const DEFAULT_SEARCH_MODE: SearchMode = "tag";

/** 标签模式下最多展示的候选数量 */
const MAX_TAG_SUGGESTIONS = 8;
const TAG_LISTBOX_ID = "memo-search-tag-listbox";

/**
 * 标签模式候选：前缀命中优先，其次子串命中，最后按使用次数降序；
 * 未输入时按使用次数展示常用标签，便于直接浏览。
 */
function matchTagSuggestions(tagCount: Record<string, number>, query: string): [string, number][] {
  const entries = Object.entries(tagCount);
  const typed = query.replace(/^#/, "").trim().toLowerCase();
  const byCount = (a: [string, number], b: [string, number]) => b[1] - a[1] || a[0].localeCompare(b[0]);

  if (!typed) {
    return entries.sort(byCount).slice(0, MAX_TAG_SUGGESTIONS);
  }

  const prefixMatches: [string, number][] = [];
  const containsMatches: [string, number][] = [];
  for (const entry of entries) {
    const index = entry[0].toLowerCase().indexOf(typed);
    if (index < 0) continue;
    if (index === 0) {
      prefixMatches.push(entry);
    } else {
      containsMatches.push(entry);
    }
  }

  return [...prefixMatches.sort(byCount), ...containsMatches.sort(byCount)].slice(0, MAX_TAG_SUGGESTIONS);
}

interface Props {
  /** 当前用户已有标签及其数量，用于标签模式的自动补全 */
  tagCount?: Record<string, number>;
}

const SearchBar = ({ tagCount = {} }: Props) => {
  const t = useTranslate();
  const { addFilter, removeFiltersByFactor } = useMemoFilterContext();
  const [queryText, setQueryText] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>(DEFAULT_SEARCH_MODE);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  /** 高亮候选下标，-1 表示未高亮（Enter 回落到按输入内容直接添加） */
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(
    () => (searchMode === "tag" ? matchTagSuggestions(tagCount, queryText) : []),
    [searchMode, tagCount, queryText],
  );
  const showSuggestions = searchMode === "tag" && suggestionsOpen && suggestions.length > 0;

  // 候选列表变化时重置高亮：只有输入了内容才默认选中第一项（空输入仅用于浏览）
  useEffect(() => {
    setHighlightedIndex(showSuggestions && queryText.replace(/^#/, "").trim() ? 0 : -1);
  }, [showSuggestions, queryText, suggestions]);

  const onTextChange = (event: React.FormEvent<HTMLInputElement>) => {
    setQueryText(event.currentTarget.value);
    setSuggestionsOpen(true);
  };

  const applyTagFilters = useCallback(
    (raw: string) => {
      const values = raw
        .replace(/^tag:/i, "")
        .split(/[\s,]+/)
        .map((value) => value.replace(/^#/, "").trim())
        .filter((value) => value.length > 0);
      if (values.length === 0) return;

      values.forEach((value) => addFilter({ factor: "tagSearch", value }));
      setQueryText("");
      setSuggestionsOpen(false);
      setHighlightedIndex(-1);
      inputRef.current?.focus();
    },
    [addFilter],
  );

  const toggleMode = () => {
    const next = MODE_CYCLE[searchMode];
    // 仅清除搜索框自身产生的过滤器：tagSearch 也可能来自笔记标签、图谱标签树等入口，保留
    if (searchMode === "keyword") removeFiltersByFactor("contentSearch");
    if (searchMode === "semantic") removeFiltersByFactor("semanticSearch");
    setSearchMode(next);
    setSuggestionsOpen(next === "tag" && document.activeElement === inputRef.current);
    setHighlightedIndex(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (searchMode === "tag") {
      if (suggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSuggestionsOpen(true);
          setHighlightedIndex((index) => (index + 1) % suggestions.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSuggestionsOpen(true);
          setHighlightedIndex((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
          return;
        }
        if ((e.key === "Enter" || e.key === "Tab") && showSuggestions && highlightedIndex >= 0) {
          e.preventDefault();
          applyTagFilters(suggestions[highlightedIndex][0]);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSuggestionsOpen(false);
        setHighlightedIndex(-1);
        return;
      }
      if (e.key === "Enter") {
        // 标签模式下整段输入都按标签处理（支持空格/逗号分隔多个）
        e.preventDefault();
        applyTagFilters(queryText);
        return;
      }
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const trimmedText = queryText.trim();
      if (trimmedText !== "") {
        // 解析搜索语法（tag:/from:/has:/is:）
        const { filters: parsedFilters, remainingWords } = parseSearchSyntax(trimmedText);

        // 添加解析出的过滤器
        parsedFilters.forEach((filter) => addFilter(filter));

        // 处理剩余文本
        if (remainingWords.length > 0) {
          if (searchMode === "keyword") {
            remainingWords.forEach((word) => {
              addFilter({ factor: "contentSearch", value: word });
            });
          } else {
            addFilter({ factor: "semanticSearch", value: remainingWords.join(" ") });
          }
        }
        setQueryText("");
      }
    }
  };

  const ModeIcon = MODE_ICON[searchMode];
  const isTagMode = searchMode === "tag";

  return (
    <div className="relative w-full h-auto flex flex-row justify-start items-center">
      <SearchIcon className="absolute left-2 w-4 h-auto opacity-40 text-sidebar-foreground" />
      <input
        className="w-full text-sidebar-foreground leading-6 bg-sidebar border border-border text-sm rounded-lg p-1 pl-8 pr-8 outline-0"
        placeholder={t(MODE_PLACEHOLDER_KEY[searchMode])}
        value={queryText}
        onChange={onTextChange}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (isTagMode) setSuggestionsOpen(true);
        }}
        onBlur={() => {
          // 延迟关闭，保证下拉项点击先于失焦生效
          window.setTimeout(() => setSuggestionsOpen(false), 150);
        }}
        ref={inputRef}
        autoComplete="off"
        role="combobox"
        aria-expanded={showSuggestions}
        aria-controls={showSuggestions ? TAG_LISTBOX_ID : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          showSuggestions && highlightedIndex >= 0 ? `${TAG_LISTBOX_ID}-option-${highlightedIndex}` : undefined
        }
      />
      <button
        type="button"
        onClick={toggleMode}
        className={cn(
          "absolute right-8 top-1/2 -translate-y-1/2 transition-opacity",
          isTagMode ? "text-primary opacity-100" : "text-sidebar-foreground opacity-60 hover:opacity-100",
        )}
        title={t("memo.search-mode-tooltip")}
        aria-label={t(MODE_LABEL_KEY[searchMode])}
      >
        <ModeIcon className="w-4 h-4" />
      </button>
      <MemoDisplaySettingMenu className="absolute right-2 top-2 text-sidebar-foreground" />

      {showSuggestions && (
        <div
          id={TAG_LISTBOX_ID}
          role="listbox"
          className="absolute left-0 right-0 top-full z-dropdown mt-1 max-h-60 overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {suggestions.map(([tag, amount], index) => (
            <button
              key={tag}
              id={`${TAG_LISTBOX_ID}-option-${index}`}
              type="button"
              role="option"
              aria-selected={index === highlightedIndex}
              onMouseDown={(event) => {
                // 阻止输入框失焦，保证点击事件正常触发
                event.preventDefault();
              }}
              onMouseEnter={() => setHighlightedIndex(index)}
              onClick={() => applyTagFilters(tag)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-sm",
                index === highlightedIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent",
              )}
            >
              <HashIcon className="size-3.5 shrink-0 opacity-60" />
              <span className="min-w-0 flex-1 truncate">{tag}</span>
              {amount > 1 && <span className="shrink-0 text-xs opacity-60">{amount}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default SearchBar;
