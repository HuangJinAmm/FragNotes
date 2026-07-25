import { useState } from "react";
import toast from "react-hot-toast";
import { FolderOpenIcon, FolderPlusIcon, GalleryHorizontalEndIcon } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getErrorMessage } from "@/lib/error";
import { cn } from "@/lib/utils";
import { useCreateWorkspace, useSwitchWorkspace, useWorkspaceList } from "@/hooks/useWorkspaceQueries";
import { Routes } from "@/router";
import { useTranslate } from "@/utils/i18n";

const WorkspacePicker = () => {
  const t = useTranslate();
  const navigate = useNavigate();
  const { data: workspaces = [], isLoading } = useWorkspaceList();
  const createMut = useCreateWorkspace();
  const switchMut = useSwitchWorkspace();

  const [name, setName] = useState("");
  const [path, setPath] = useState("");

  const handleCreate = async () => {
    const trimmedName = name.trim();
    const trimmedPath = path.trim();
    if (!trimmedName || !trimmedPath) {
      toast.error(t("workspace.picker.title"));
      return;
    }
    try {
      const created = await createMut.mutateAsync({ name: trimmedName, path: trimmedPath });
      toast.success(t("common.create"));
      // 创建后自动切换到新工作空间（后端会触发重启）
      await switchMut.mutateAsync(created.id);
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const handlePickFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string" && selected) {
        setPath(selected);
        // 未填写名称时，使用文件夹名作为默认值
        if (!name.trim()) {
          const folderName = selected.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
          if (folderName) setName(folderName);
        }
      }
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const handleSwitch = async (id: string) => {
    try {
      await switchMut.mutateAsync(id);
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const switching = switchMut.isPending;
  const creating = createMut.isPending;

  return (
    <section className="mx-auto w-full max-w-2xl min-h-full flex flex-col justify-start items-start sm:pt-6 md:pt-12 pb-8 px-4 sm:px-6">
      <div className="w-full flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{t("workspace.picker.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("workspace.picker.empty")}</p>
        </div>

        {/* 已有工作空间列表 */}
        <div className="flex flex-col gap-2">
          {isLoading ? (
            <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
          ) : workspaces.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              {t("workspace.picker.empty")}
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {workspaces.map((ws) => (
                <li key={ws.id}>
                  <button
                    type="button"
                    disabled={switching}
                    onClick={() => handleSwitch(ws.id)}
                    className={cn(
                      "w-full text-left rounded-lg border p-3 transition-colors disabled:opacity-50",
                      ws.is_active
                        ? "border-accent bg-accent/40"
                        : "border-border hover:bg-muted/30",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <GalleryHorizontalEndIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="text-sm font-medium text-foreground truncate">{ws.name}</span>
                      {ws.is_active && (
                        <span className="ml-auto rounded bg-accent px-1.5 py-0.5 text-xs text-accent-foreground">
                          {t("workspace.switcher.switch")}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground font-mono break-all">{ws.path}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 新建工作空间 */}
        <div className="rounded-lg border border-border bg-background p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <FolderPlusIcon className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium text-foreground">{t("workspace.picker.new")}</h2>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="workspace-name">{t("workspace.picker.name")}</Label>
            <Input
              id="workspace-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("workspace.picker.name")}
              disabled={creating || switching}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="workspace-path">{t("workspace.picker.path")}</Label>
            <div className="flex gap-2">
              <Input
                id="workspace-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="C:\\path\\to\\workspace"
                disabled={creating || switching}
                className="font-mono"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handlePickFolder}
                disabled={creating || switching}
                type="button"
              >
                <FolderOpenIcon className="size-3.5" />
                {t("workspace.picker.selectFolder")}
              </Button>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => navigate(Routes.HOME)} disabled={creating || switching}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={creating || switching || !name.trim() || !path.trim()}>
              {creating || switching ? t("common.saving") : t("workspace.picker.create")}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
};

export default WorkspacePicker;
