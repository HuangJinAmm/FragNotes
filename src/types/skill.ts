export type SkillSource = "builtin" | "user";

export interface SkillDto {
  id: string;
  name: string;
  description: string;
  tools: string[];
  body: string;
  enabled: boolean;
  source: SkillSource;
  created_ts: number;
  updated_ts: number;
}
