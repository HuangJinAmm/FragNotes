import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  CheckCircle2Icon,
  CircleDotIcon,
  CopyIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { getErrorMessage } from "@/lib/error";
import { cn } from "@/lib/utils";
import { useTranslate } from "@/utils/i18n";
import type { ProviderConfig } from "@/components/AiChat/types";
import SettingGroup from "./SettingGroup";
import { SettingList, SettingListItem } from "./SettingList";
import SettingSection from "./SettingSection";

interface LlmRunnerConfig {
  /** 用户自行填写的完整启动命令行（可执行文件 + 参数） */
  command: string;
  /** OpenAI 兼容端点 Base URL，留空回退默认值 */
  base_url: string;
  auto_start: boolean;
}

interface LlmRunnerStatus {
  running: boolean;
  pid: number | null;
  base_url: string;
  started_at: number | null;
  last_error: string | null;
  recent_logs: string[];
  config: LlmRunnerConfig;
}

interface TestConnectionResult {
  ok: boolean;
  status: number;
  body_preview: string;
  error: string | null;
}

/** 未配置 base_url 时使用的默认端点（与后端 DEFAULT_BASE_URL 保持一致） */
const DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";

const DEFAULT_CONFIG: LlmRunnerConfig = {
  command: "",
  base_url: "",
  auto_start: false,
};

/** 返回有效的 Base URL：优先使用用户配置的 base_url，为空时回退到默认值 */
const effectiveBaseUrl = (config: LlmRunnerConfig): string => {
  const trimmed = config.base_url.trim();
  if (trimmed) {
    return trimmed.replace(/\/+$/, "");
  }
  return DEFAULT_BASE_URL;
};

const LocalLlmSection = () => {
  const t = useTranslate();
  const [config, setConfig] = useState<LlmRunnerConfig>(DEFAULT_CONFIG);
  const [original, setOriginal] = useState<LlmRunnerConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<LlmRunnerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // 加载配置 + 状态
  useEffect(() => {
    void (async () => {
      try {
        const cfg = await invoke<LlmRunnerConfig>("llm_get_config");
        setConfig(cfg);
        setOriginal(cfg);
        const st = await invoke<LlmRunnerStatus>("llm_get_status");
        setStatus(st);
      } catch (error) {
        toast.error(getErrorMessage(error, t("setting.local-llm.load-failed")));
      } finally {
        setLoading(false);
      }
    })();
  }, [t]);

  // 订阅状态变更事件
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    (async () => {
      unlisten = await listen("llm:status-changed", async () => {
        try {
          const st = await invoke<LlmRunnerStatus>("llm_get_status");
          setStatus(st);
        } catch (e) {
          console.error(e);
        }
      });
    })();
    // 兜底轮询：极端情况下事件可能丢失，每 5 秒兜底一次状态查询
    pollTimer = setInterval(() => {
      invoke<LlmRunnerStatus>("llm_get_status")
        .then(setStatus)
        .catch(() => {});
    }, 5000);
    return () => {
      unlisten?.();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, []);

  // 自动滚动日志到底部
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollTop = logEndRef.current.scrollHeight;
    }
  }, [status?.recent_logs.length]);

  const update = (partial: Partial<LlmRunnerConfig>) => {
    setConfig((prev) => ({ ...prev, ...partial }));
  };

  const isDirty = JSON.stringify(config) !== JSON.stringify(original);
  const running = Boolean(status?.running);
  const canStart = config.command.trim().length > 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await invoke<LlmRunnerConfig>("llm_update_config", { req: config });
      setConfig(saved);
      setOriginal(saved);
      toast.success(t("setting.local-llm.config-saved"));
    } catch (error) {
      toast.error(getErrorMessage(error, t("setting.local-llm.save-failed")));
    } finally {
      setSaving(false);
    }
  };

  const handleStart = async () => {
    setStarting(true);
    setTestResult(null);
    try {
      // 启动使用后端保存的配置：若表单有改动先落库，避免「改了没保存就启动」的困惑
      if (isDirty) {
        const saved = await invoke<LlmRunnerConfig>("llm_update_config", { req: config });
        setConfig(saved);
        setOriginal(saved);
      }
      const st = await invoke<LlmRunnerStatus>("llm_start");
      setStatus(st);
      if (st.running) {
        toast.success(t("setting.local-llm.started"));
      } else if (st.last_error) {
        toast.error(st.last_error);
      }
    } catch (error) {
      toast.error(getErrorMessage(error, t("setting.local-llm.start-failed")));
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    setTestResult(null);
    try {
      const st = await invoke<LlmRunnerStatus>("llm_stop");
      setStatus(st);
      toast.success(t("setting.local-llm.stopped-toast"));
    } catch (error) {
      toast.error(getErrorMessage(error, t("setting.local-llm.stop-failed")));
    } finally {
      setStopping(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    try {
      const result = await invoke<TestConnectionResult>("llm_test_connection");
      setTestResult(result);
      if (result.ok) {
        toast.success(t("setting.local-llm.test-ok"));
      } else {
        toast.error(t("setting.local-llm.test-fail"));
      }
    } catch (error) {
      toast.error(getErrorMessage(error, t("setting.local-llm.test-fail")));
    } finally {
      setTesting(false);
    }
  };

  const handleCopyUrl = async () => {
    const url = effectiveBaseUrl(config);
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("setting.local-llm.url-copied"));
    } catch {
      toast.error(t("setting.local-llm.copy-failed"));
    }
  };

  const handleAddToProviders = async () => {
    const baseUrl = effectiveBaseUrl(config);
    try {
      const existing = await invoke<ProviderConfig[]>("list_providers");
      // 已存在指向同一 baseUrl 的 provider 则提示
      if (existing.some((p) => p.base_url === baseUrl)) {
        toast.success(t("setting.local-llm.already-in-providers"));
        return;
      }
      const provider: ProviderConfig = {
        id: crypto.randomUUID(),
        name: "Local LLM",
        base_url: baseUrl,
        api_key: "",
        model: "",
      };
      const next = [...existing, provider];
      await invoke<ProviderConfig[]>("save_providers_cmd", { providers: next });
      toast.success(t("setting.local-llm.added-to-providers"));
    } catch (error) {
      toast.error(getErrorMessage(error, t("setting.local-llm.add-to-providers-failed")));
    }
  };

  if (loading) {
    return (
      <SettingSection title={t("setting.local-llm.label")}>
        <div className="px-3 py-3 text-sm text-muted-foreground">…</div>
      </SettingSection>
    );
  }

  // 服务运行中时显示后端实际返回的 base_url，否则显示按当前配置派生的 base_url
  const baseUrl = running && status?.base_url ? status.base_url : effectiveBaseUrl(config);

  return (
    <SettingSection
      title={t("setting.local-llm.label")}
      description={t("setting.local-llm.description")}
      actions={
        <div className="flex items-center gap-2">
          {running ? (
            <Button variant="destructive" size="sm" onClick={handleStop} disabled={stopping}>
              <SquareIcon className="size-4" />
              {stopping ? t("setting.local-llm.stopping") : t("setting.local-llm.stop")}
            </Button>
          ) : (
            <Button size="sm" onClick={handleStart} disabled={starting || !canStart}>
              <PlayIcon className="size-4" />
              {starting ? t("setting.local-llm.starting") : t("setting.local-llm.start")}
            </Button>
          )}
        </div>
      }
    >
      {/* 运行状态卡片 */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <Label>{t("setting.local-llm.status-title")}</Label>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span
                className={cn(
                  "size-2 rounded-full",
                  running ? "bg-green-500" : "bg-muted-foreground/40",
                )}
              />
              {running ? t("setting.local-llm.running") : t("setting.local-llm.stopped")}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTestConnection}
              disabled={testing || !running}
            >
              <ZapIcon className="size-4" />
              {testing ? t("setting.local-llm.testing") : t("setting.local-llm.test")}
            </Button>
          </div>
        </div>

        {/* base URL + 复制 + 加入 provider */}
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t("setting.local-llm.base-url")}</Label>
          <div className="flex flex-wrap gap-2">
            <code className="flex-1 min-w-0 rounded bg-muted px-2 py-1.5 text-xs font-mono truncate">
              {baseUrl}
            </code>
            <Button variant="outline" size="sm" onClick={handleCopyUrl}>
              <CopyIcon className="size-3.5" />
              {t("setting.local-llm.copy-url")}
            </Button>
            <Button variant="outline" size="sm" onClick={handleAddToProviders}>
              <PlusIcon className="size-3.5" />
              {t("setting.local-llm.add-to-providers")}
            </Button>
          </div>
        </div>

        {/* 元信息 */}
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          {status?.pid != null && (
            <span>PID: <span className="font-mono">{status.pid}</span></span>
          )}
          {status?.started_at != null && (
            <span>
              {t("setting.local-llm.started-at")}:{" "}
              <span className="font-mono">
                {new Date(status.started_at * 1000).toLocaleTimeString()}
              </span>
            </span>
          )}
        </div>

        {/* 错误 */}
        {status?.last_error && (
          <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {status.last_error}
          </div>
        )}

        {/* 测试结果 */}
        {testResult && (
          <div
            className={cn(
              "rounded border px-3 py-2 text-xs",
              testResult.ok
                ? "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400"
                : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
            )}
          >
            <div className="flex items-center gap-1.5 font-medium">
              {testResult.ok ? (
                <CheckCircle2Icon className="size-3.5" />
              ) : (
                <CircleDotIcon className="size-3.5" />
              )}
              {testResult.ok
                ? t("setting.local-llm.test-ok")
                : t("setting.local-llm.test-fail")}
              <span className="font-mono opacity-70">HTTP {testResult.status}</span>
            </div>
            {testResult.error && <div className="mt-1 opacity-80">{testResult.error}</div>}
            {testResult.body_preview && (
              <pre className="mt-1 max-h-24 overflow-auto font-mono opacity-70 whitespace-pre-wrap">
                {testResult.body_preview}
              </pre>
            )}
          </div>
        )}

        {/* 日志 */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            {t("setting.local-llm.recent-logs")}
          </Label>
          <div
            ref={logEndRef}
            className="max-h-48 overflow-auto rounded bg-zinc-950 text-zinc-100 px-3 py-2 text-xs font-mono leading-5"
          >
            {status?.recent_logs && status.recent_logs.length > 0 ? (
              status.recent_logs.map((line, i) => (
                <div key={i} className="whitespace-pre-wrap break-all">
                  {line}
                </div>
              ))
            ) : (
              <div className="text-zinc-500">{t("setting.local-llm.no-logs")}</div>
            )}
          </div>
        </div>
      </div>

      {/* 启动命令行 */}
      <SettingGroup
        title={t("setting.local-llm.command-title")}
        description={t("setting.local-llm.command-hint")}
      >
        <Textarea
          className="font-mono text-xs"
          rows={3}
          value={config.command}
          onChange={(e) => update({ command: e.target.value })}
          placeholder={t("setting.local-llm.command-placeholder")}
        />
      </SettingGroup>

      {/* 连接 */}
      <SettingGroup
        title={t("setting.local-llm.connect-title")}
        description={t("setting.local-llm.connect-description")}
        showSeparator
      >
        <SettingList>
          <SettingListItem
            label={t("setting.local-llm.base-url")}
            description={t("setting.local-llm.base-url-hint")}
          >
            <Input
              className="w-72 font-mono"
              value={config.base_url}
              onChange={(e) => update({ base_url: e.target.value })}
              placeholder={DEFAULT_BASE_URL}
            />
          </SettingListItem>
        </SettingList>
      </SettingGroup>

      {/* 自动启动 */}
      <SettingGroup showSeparator>
        <SettingList>
          <SettingListItem
            label={t("setting.local-llm.auto-start")}
            description={t("setting.local-llm.auto-start-hint")}
          >
            <Switch
              checked={config.auto_start}
              onCheckedChange={(v) => update({ auto_start: v })}
              aria-label={t("setting.local-llm.auto-start")}
            />
          </SettingListItem>
        </SettingList>
      </SettingGroup>

      {/* 保存按钮 */}
      <div className="w-full flex justify-end">
        <Button disabled={!isDirty || saving} onClick={handleSave}>
          {t("common.save")}
        </Button>
      </div>
    </SettingSection>
  );
};

export default LocalLlmSection;
