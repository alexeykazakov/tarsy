export interface QueryRequest {
  prompt: string;
  system_prompt?: string;
  max_turns?: number;
  allowed_tools?: string[];
  setting_sources?: string[];
  workspace_dir?: string;
  env?: Record<string, string>;
}
