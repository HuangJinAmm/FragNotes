import { useState } from "react";
import toast from "react-hot-toast";
import {
  CheckIcon,
  FolderOpenIcon,
  GalleryHorizontalEndIcon,   
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import dayjs from "dayjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getErrorMessage } from "@/lib/error";
import { cn } from "@/lib/utils";
import {
  useCreateWorkspace,
  useDeleteWorkspace,
  useOpenInExplorer,
  useRenameWorkspace,
  useSwitchWorkspace,
  useWorkspaceList,
} from "@/hooks/useWorkspaceQueries";
import type { WorkspaceInfo } from "@/types/workspace";
import { useTranslate } from "@/utils/i18n";
import SettingGroup from "./SettingGroup";
import { SettingList, SettingListItem } from "./SettingList";
import SettingSection from "./SettingSection";

const formatTimestamp = (ts: number): string => {
  return dayjs(ts * 1000).format("YYYY-MM-DD HH:mm");
};

const WorkspaceSection = () => {
  const t = useTranslate();
  const { data: workspaces = [], isLoading } = useWorkspaceList();
  const createMut = useCreateWorkspace();
  const switchMut = useSwitchWorkspace();
  const renameMut = useRenameWorkspace();
  const deleteMut = useDeleteWorkspace();
  const openExplorerMut = useOpenInExplorer();

  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<WorkspaceInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceInfo | null>(null);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [renameValue, setRenameValue] = useState("");

  const handleCreate = async () => {
    const trimmedName = newName.trim();
    const trimmedPath = newPath.trim();
    if (!trimmedName || !trimmedPath) return;
    try {
      await createMut.mutateAsync({ name: trimmedName, path: trimmedPath });
      toast.success(t("common.create"));
      setCreateOpen(false);
      setNewName("");
      setNewPath("");
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const handlePickFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string" && selected) {
        setNewPath(selected);
        // 未填写名称时，使用文件夹名作为默认值
        if (!newName.trim()) {
          const folderName = selected.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
          if (folderName) setNewName(folderName);
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

  const handleOpenExplorer = async (path: string) => {
    try {
      await openExplorerMut.mutateAsync(path);
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const handleRenameSubmit = async () => {
    if (!renameTarget) return;
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    try {
      await renameMut.mutateAsync({ id: renameTarget.id, newName: trimmed });
      toast.success(t("common.save"));
      setRenameTarget(null);
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const handleDeleteSubmit = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMut.mutateAsync(deleteTarget.id);
      toast.success(t("common.delete"));
      setDeleteTarget(null);
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  return (
    <SettingSection
      title={t("workspace.settings.title")}
      actions={
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <PlusIcon className="size-4" />
          {t("workspace.settings.new")}
        </Button>
      }
    >
      <SettingGroup>
        {isLoading ? (
          <div className="px-3 py-3 text-sm text-muted-foreground">{t("common.loading")}</div>
        ) : workspaces.length === 0 ? (
          <div className="px-3 py-3 text-sm text-muted-foreground">{t("workspace.picker.empty")}</div>
        ) : (
          <SettingList>
            {workspaces.map((ws) => (
              <SettingListItem
                key={ws.id}
                icon={<GalleryHorizontalEndIcon className="size-4 shrink-0 text-muted-foreground" />}
                label={
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{ws.name}</span>
                    {ws.is_active && (
                      <Badge variant="secondary" className="text-[10px]">
                        {t("workspace.switcher.switch")}
                      </Badge>
                    )}
                    {ws.status !== "valid" && (
                      <Badge variant="destructive" className="text-[10px]">
                        {t("workspace.settings.statusInvalid")}
                      </Badge>
                    )}
                  </div>
                }
                description={
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-xs break-all">{ws.path}</span>
                    <span className="text-xs">
                      {t("workspace.settings.status")}: {ws.status === "valid" ? t("workspace.settings.statusValid") : t("workspace.settings.statusInvalid")}
                      {" · "}
                      {t("common.created-at")}: {formatTimestamp(ws.created_ts)}
                    </span>
                  </div>
                }
                vertical
              >
                <div className="flex flex-wrap items-center gap-1">
                  {!ws.is_active && ws.status === "valid" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={switchMut.isPending}
                      onClick={() => handleSwitch(ws.id)}
                    >
                      <CheckIcon className="size-3.5" />
                      {t("workspace.switcher.switch")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRenameTarget(ws);
                      setRenameValue(ws.name);
                    }}
                  >
                    <PencilIcon className="size-3.5" />
                    {t("workspace.settings.rename")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={openExplorerMut.isPending}
                    onClick={() => handleOpenExplorer(ws.path)}
                  >
                    <FolderOpenIcon className="size-3.5" />
                    {t("workspace.settings.openInExplorer")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDeleteTarget(ws)}
                  >
                    <Trash2Icon className="size-3.5" />
                    {t("workspace.settings.delete")}
                  </Button>
                </div>
              </SettingListItem>
            ))}
          </SettingList>
        )}
      </SettingGroup>

      {/* 新建工作空间对话框 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent size="default">
          <DialogHeader>
            <DialogTitle>{t("workspace.settings.new")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="ws-new-name">{t("workspace.settings.name")}</Label>
              <Input
                id="ws-new-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("workspace.settings.name")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ws-new-path">{t("workspace.settings.path")}</Label>
              <div className="flex gap-2">
                <Input
                  id="ws-new-path"
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  placeholder="C:\\path\\to\\workspace"
                  className="font-mono"
                />
                <Button variant="outline" size="sm" onClick={handlePickFolder} type="button">
                  <FolderOpenIcon className="size-3.5" />
                  {t("workspace.settings.selectFolder")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t("workspace.picker.selectFolder")}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={createMut.isPending || !newName.trim() || !newPath.trim()}
            >
              {createMut.isPending ? t("common.saving") : t("workspace.picker.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名对话框 */}
      <Dialog open={!!renameTarget} onOpenChange={(o) => !o && setRenameTarget(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("workspace.settings.rename")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ws-rename">{t("workspace.settings.name")}</Label>
            <Input
              id="ws-rename"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder={t("workspace.settings.name")}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleRenameSubmit}
              disabled={renameMut.isPending || !renameValue.trim()}
            >
              {renameMut.isPending ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认对话框 */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("workspace.settings.delete")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("workspace.settings.deleteConfirm")}
          </p>
          {deleteTarget && (
            <div className={cn("rounded-md border border-border bg-muted/30 px-3 py-2 text-sm")}>
              <div className="font-medium">{deleteTarget.name}</div>
              <div className="font-mono text-xs break-all text-muted-foreground">{deleteTarget.path}</div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteSubmit}
              disabled={deleteMut.isPending}
            >
              <XIcon className="size-3.5" />
              {deleteMut.isPending ? t("common.saving") : t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingSection>
  );
};

export default WorkspaceSection;
