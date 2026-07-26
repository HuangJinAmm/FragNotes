import { PaperclipIcon, SendIcon, SquareIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslate } from "@/utils/i18n";
import { cn } from "@/lib/utils";
import toast from "react-hot-toast";
import type { ContentPart, PendingImage } from "./types";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_IMAGES = 4;
const TEXTAREA_MAX_HEIGHT = 160; // px，超过后滚动

interface AiChatComposerProps {
  isStreaming: boolean;
  disabled: boolean;
  onSend: (content: string | ContentPart[]) => void;
  onAbort: () => void;
  /// 渲染在输入框下方的 Provider 选择器（融合在底部工具栏中）
  providerSlot?: ReactNode;
}

const fileToDataUrl = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

export function AiChatComposer({
  isStreaming,
  disabled,
  onSend,
  onAbort,
  providerSlot,
}: AiChatComposerProps) {
  const t = useTranslate();
  const [text, setText] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 自动调整 textarea 高度：随内容增长，超过最大高度后滚动
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
  }, [text]);

  // 发送后重置高度
  useEffect(() => {
    if (text === "") {
      const el = textareaRef.current;
      if (el) el.style.height = "auto";
    }
  }, [text]);

  const handleFiles = async (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_SIZE) {
        toast.error(t("aiChat.imageTooLarge"));
        continue;
      }
      if (pendingImages.length >= MAX_IMAGES) {
        toast.error(t("aiChat.tooManyImages"));
        break;
      }
      const dataUrl = await fileToDataUrl(file);
      setPendingImages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), dataUrl, name: file.name, size: file.size },
      ]);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const textContent = text.trim();
    if ((!textContent && pendingImages.length === 0) || isStreaming || disabled) return;

    let content: string | ContentPart[];
    if (pendingImages.length === 0) {
      content = textContent;
    } else {
      const parts: ContentPart[] = [];
      if (textContent) {
        parts.push({ type: "text", text: textContent });
      }
      for (const img of pendingImages) {
        parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
      }
      content = parts;
    }

    onSend(content);
    setText("");
    setPendingImages([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      handleFiles(files);
    }
  };

  const removeImage = (id: string) => {
    setPendingImages((prev) => prev.filter((p) => p.id !== id));
  };

  const canSend = (text.trim().length > 0 || pendingImages.length > 0) && !disabled;

  return (
    <form onSubmit={handleSubmit} className="border-t border-border p-2">
      {/* 融合容器：多行输入框 + 图片预览 + 底部工具栏 */}
      <div className="rounded-lg border border-input bg-background focus-within:ring-1 focus-within:ring-primary focus-within:border-primary transition-colors overflow-hidden">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={disabled ? t("aiChat.configureFirst") : t("aiChat.inputPlaceholder")}
          disabled={disabled}
          rows={1}
          className={cn(
            "block w-full resize-none bg-transparent px-3 pt-2.5 pb-1.5 text-sm leading-6",
            "min-h-[40px] focus:outline-none",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
        {pendingImages.length > 0 && (
          <div className="flex gap-2 flex-wrap px-3 pb-2">
            {pendingImages.map((img) => (
              <div key={img.id} className="relative group">
                <img
                  src={img.dataUrl}
                  alt={img.name}
                  className="size-16 object-cover rounded-md border border-border"
                />
                <button
                  type="button"
                  onClick={() => removeImage(img.id)}
                  className="absolute -top-1 -right-1 size-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {/* 底部工具栏：Provider 自适应宽度 | 附件紧邻其后 | 其余空间留白 | 发送/停止靠右 */}
        <div className="flex items-center gap-1.5 px-2 py-1.5">
          <div
            className={cn(
              "shrink-0",
              // 让嵌入的 SelectTrigger 融入容器：去掉自身边框与阴影，hover 时给个浅底色
              // 宽度根据 provider 名称自适应（SelectTrigger 默认 w-fit）
              "[&_[data-slot=select-trigger]]:border-0 [&_[data-slot=select-trigger]]:shadow-none [&_[data-slot=select-trigger]]:bg-transparent [&_[data-slot=select-trigger]]:h-8 [&_[data-slot=select-trigger]]:px-1.5 [&_[data-slot=select-trigger]]:hover:bg-muted [&_[data-slot=select-trigger]]:rounded-md",
            )}
          >
            {providerSlot}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              handleFiles(Array.from(e.target.files || []));
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            className="shrink-0 size-8 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label={t("aiChat.attachImage")}
            title={t("aiChat.attachImage")}
          >
            <PaperclipIcon className="size-4" />
          </button>
          {/* 其余空间留白 */}
          <div className="flex-1" />
          {isStreaming ? (
            <button
              type="button"
              onClick={onAbort}
              className="shrink-0 size-8 rounded-md border border-border flex items-center justify-center hover:bg-muted transition-colors"
              aria-label="Stop"
            >
              <SquareIcon className="size-4" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              className="shrink-0 size-8 rounded-md bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
              aria-label={t("aiChat.send")}
            >
              <SendIcon className="size-4" />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
