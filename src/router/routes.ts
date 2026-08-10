export const ROUTES = {
  HOME: "/",
  ABOUT: "/about",
  ATTACHMENTS: "/attachments",
  ARCHIVED: "/archived",
  SETTING: "/setting",
  DISCOVER: "/discover",
  REVIEW: "/review",
  KNOWLEDGE_GRAPH: "/knowledge-graph",
  WORKSPACE_PICKER: "/workspace-picker",
} as const;

export type RouteKey = keyof typeof ROUTES;
export type RoutePath = (typeof ROUTES)[RouteKey];
