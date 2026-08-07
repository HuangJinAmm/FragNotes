// 本地应用 Settings：只保留 4 个 section
import { BarChart3Icon, BookOpenIcon, CogIcon, CpuIcon, HardDriveIcon, LibraryIcon, GalleryHorizontalEndIcon, PlugIcon, RadioIcon, ServerIcon, SparklesIcon, TagsIcon, UserIcon, WrenchIcon, type LucideIcon } from "lucide-react";
import { type ComponentType } from "react";
import MemoRelatedSettings from "@/components/Settings/MemoRelatedSettings";
import MyAccountSection from "@/components/Settings/MyAccountSection";
import PreferencesSection from "@/components/Settings/PreferencesSection";
import LanShareSection from "@/components/Settings/LanShareSection";
import LocalLlmSection from "@/components/Settings/LocalLlmSection";
import McpSection from "@/components/Settings/McpSection";
import ProvidersSection from "@/components/Settings/ProvidersSection";
import ResourceStatsSection from "@/components/Settings/ResourceStatsSection";
import StorageSection from "@/components/Settings/StorageSection";
import TagsSection from "@/components/Settings/TagsSection";
import ReviewSection from "@/components/Settings/ReviewSection";
import SkillsSection from "@/components/Settings/SkillsSection";
import ToolsSection from "@/components/Settings/ToolsSection";
import WorkspaceSection from "@/components/Settings/WorkspaceSection";
import { InstanceSetting_Key } from "@/types/proto/api/v1/instance_service_pb";

export type SettingSectionKey =
  | "my-account"
  | "preference"
  | "memo"
  | "tags"
  | "storage"
  | "resource-stats"
  | "lan-share"
  | "local-llm"
  | "providers"
  | "mcp"
  | "review"
  | "skills"
  | "tools"
  | "workspace";

type SettingSectionScope = "basic" | "admin";

export interface SettingSectionDefinition {
  key: SettingSectionKey;
  scope: SettingSectionScope;
  labelKey: `setting.${SettingSectionKey}.label`;
  icon: LucideIcon;
  component: ComponentType;
  preloadSettingKeys?: InstanceSetting_Key[];
}

export const SETTINGS_SECTIONS: SettingSectionDefinition[] = [
  {
    key: "my-account",
    scope: "basic",
    labelKey: "setting.my-account.label",
    icon: UserIcon,
    component: MyAccountSection,
  },
  {
    key: "preference",
    scope: "basic",
    labelKey: "setting.preference.label",
    icon: CogIcon,
    component: PreferencesSection,
  },
  {
    key: "memo",
    scope: "admin",
    labelKey: "setting.memo.label",
    icon: LibraryIcon,
    component: MemoRelatedSettings,
  },
  {
    key: "tags",
    scope: "basic",
    labelKey: "setting.tags.label",
    icon: TagsIcon,
    component: TagsSection,
  },
  {
    key: "storage",
    scope: "admin",
    labelKey: "setting.storage.label",
    icon: HardDriveIcon,
    component: StorageSection,
  },
  {
    key: "resource-stats",
    scope: "admin",
    labelKey: "setting.resource-stats.label",
    icon: BarChart3Icon,
    component: ResourceStatsSection,
  },
  {
    key: "lan-share",
    scope: "basic",
    labelKey: "setting.lan-share.label",
    icon: RadioIcon,
    component: LanShareSection,
  },
  {
    key: "local-llm",
    scope: "basic",
    labelKey: "setting.local-llm.label",
    icon: CpuIcon,
    component: LocalLlmSection,
  },
  {
    key: "providers",
    scope: "basic",
    labelKey: "setting.providers.label",
    icon: ServerIcon,
    component: ProvidersSection,
  },
  {
    key: "mcp",
    scope: "basic",
    labelKey: "setting.mcp.label",
    icon: PlugIcon,
    component: McpSection,
  },
  {
    key: "review",
    scope: "basic",
    labelKey: "setting.review.label",
    icon: BookOpenIcon,
    component: ReviewSection,
  },
  {
    key: "skills",
    scope: "basic",
    labelKey: "setting.skills.label",
    icon: SparklesIcon,
    component: SkillsSection,
  },
  {
    key: "tools",
    scope: "basic",
    labelKey: "setting.tools.label",
    icon: WrenchIcon,
    component: ToolsSection,
  },
  {
    key: "workspace",
    scope: "basic",
    labelKey: "setting.workspace.label",
    icon: GalleryHorizontalEndIcon,
    component: WorkspaceSection,
  },
];

export const DEFAULT_SETTING_SECTION: SettingSectionKey = "my-account";

export const isSettingSectionKey = (value: string): value is SettingSectionKey => {
  return SETTINGS_SECTIONS.some((section) => section.key === value);
};
