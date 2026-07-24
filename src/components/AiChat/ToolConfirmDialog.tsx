import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslate } from "@/utils/i18n";
import {
  PERMISSION_BADGE_COLORS,
  PERMISSION_LABELS,
  type ToolConfirmRequest,
  type ToolPermission,
} from "@/types/tool";

const CONFIRM_TIMEOUT_SECONDS = 60;

const ToolConfirmDialog = () => {
  const t = useTranslate();
  const [queue, setQueue] = useState<ToolConfirmRequest[]>([]);
  const [remainingSeconds, setRemainingSeconds] = useState(CONFIRM_TIMEOUT_SECONDS);

  const current = queue[0] ?? null;

  const handleRespond = async (approved: boolean) => {
    const cur = queue[0];
    if (!cur) return;
    const callId = cur.call_id;
    // 先从队列移除，避免 Dialog 闪现新内容
    setQueue((q) => q.slice(1));
    try {
      await invoke("tool_confirm_response", { callId, approved });
    } catch (e) {
      console.error("tool_confirm_response failed:", e);
    }
  };

  useEffect(() => {
    if (!current) return;
    setRemainingSeconds(CONFIRM_TIMEOUT_SECONDS);
    const interval = setInterval(() => {
      setRemainingSeconds((s) => {
        if (s <= 1) {
          // 超时按拒绝处理
          void handleRespond(false);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.call_id]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<ToolConfirmRequest>("tool:confirm_request", (event) => {
      setQueue((q) => [...q, event.payload]);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  if (!current) return null;
  const permission = current.permission as ToolPermission;
  const isDangerous = permission === "dangerous";

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) void handleRespond(false); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("aiChat.tool.confirm-title")}</DialogTitle>
          <DialogDescription>
            {t("aiChat.tool.confirm-description")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t("aiChat.tool.tool-name")}</span>
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">{current.tool_name}</code>
            <span className={`rounded px-1.5 py-0.5 text-xs ${PERMISSION_BADGE_COLORS[permission]}`}>
              {PERMISSION_LABELS[permission]}
            </span>
          </div>
          <div>
            <p className="mb-1 text-sm text-muted-foreground">{t("aiChat.tool.command")}</p>
            <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-all">
              {current.command}
            </pre>
          </div>
          {isDangerous && (
            <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
              ⚠️ {t("aiChat.tool.dangerous-warning")}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {t("aiChat.tool.countdown", { seconds: remainingSeconds })}
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => void handleRespond(false)}
            autoFocus
          >
            {t("aiChat.tool.deny")}
          </Button>
          <Button
            variant={isDangerous ? "destructive" : "default"}
            onClick={() => void handleRespond(true)}
          >
            {t("aiChat.tool.approve")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ToolConfirmDialog;
