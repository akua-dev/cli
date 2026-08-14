export interface CommandDefinition<OperationId extends string = string> {
  operation_id: OperationId;
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
  body?: CommandBody;
}

export interface CommandBody {
  required: boolean;
  example: Readonly<Record<string, unknown>>;
}

export interface CommandParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
}
