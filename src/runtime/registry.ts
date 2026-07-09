export interface CommandDefinition {
  operation_id: string;
  command: string;
  resource: string;
  action: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  visibility: "PUBLIC";
  requires_auth: boolean;
  parameters: readonly CommandParameter[];
}

export interface CommandParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
}
