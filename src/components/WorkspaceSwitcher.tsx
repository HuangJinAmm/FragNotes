import { CheckIcon, ChevronDownIcon, GalleryHorizontalEndIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getErrorMessage } from "@/lib/error";
import { cn } from "@/lib/utils";
import { useSwitchWorkspace, useWorkspaceList } from "@/hooks/useWorkspaceQueries";
import { Routes } from "@/router";
import { useTranslate } from "@/utils/i18n";

interface Props {
  collapsed?: boolean;
}

const WorkspaceSwitcher = ({ collapsed }: Props) => {
  const t = useTranslate();
  const navigate = useNavigate();
  const { data: workspaces = [], isLoading } = useWorkspaceList();
  const switchMut = useSwitchWorkspace();
  const [open, setOpen] = useState(false);

  const activeWorkspace = workspaces.find((ws) => ws.is_active);
  const switching = switchMut.isPending;

  const handleSwitch = async (id: string) => {
    setOpen(false);
    try {
      await switchMut.mutateAsync(id);
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const handleManage = () => {
    setOpen(false);
    navigate(Routes.SETTING);
  };

  const handleNew = () => {
    setOpen(false);
    navigate(Routes.WORKSPACE_PICKER);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={switching}
          className={cn(
            "w-full rounded-lg border border-transparent hover:bg-accent hover:text-accent-foreground transition-colors text-sm",
            collapsed ? "px-2 py-2 flex items-center justify-center" : "px-3 py-2 flex items-center gap-2",
            switching && "opacity-60",
          )}
          title={activeWorkspace?.name ?? t("workspace.picker.title")}
        >
          <GalleryHorizontalEndIcon className="w-6 h-auto shrink-0" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left truncate">
                {switching ? t("workspace.switcher.switching") : (activeWorkspace?.name ?? t("workspace.picker.title"))}
              </span>
              <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="w-64">
        <DropdownMenuLabel>{t("workspace.picker.title")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {isLoading ? (
          <DropdownMenuItem disabled>{t("common.loading")}</DropdownMenuItem>
        ) : workspaces.length === 0 ? (
          <DropdownMenuItem disabled>{t("workspace.picker.empty")}</DropdownMenuItem>
        ) : (
          workspaces.map((ws) => (
            <DropdownMenuItem
              key={ws.id}
              onSelect={(e) => {
                e.preventDefault();
                if (!ws.is_active) void handleSwitch(ws.id);
              }}
              disabled={switching}
              className="flex items-center gap-2"
            >
              <CheckIcon className={cn("size-4 shrink-0", ws.is_active ? "opacity-100" : "opacity-0")} />
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate">{ws.name}</div>
                <div className="text-xs text-muted-foreground font-mono truncate">{ws.path}</div>
              </div>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleNew}>
          <PlusIcon className="size-4 shrink-0" />
          <span>{t("workspace.switcher.new")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleManage}>
          <SettingsIcon className="size-4 shrink-0" />
          <span>{t("workspace.switcher.manage")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default WorkspaceSwitcher;
