import type { AkuaCliError, NextStep } from "./errors";
import type { OutputMode } from "./mode";

export interface RenderEnvelope {
  command: string;
  status?: "ok";
  observations?: readonly string[];
  data?: unknown;
  next_steps?: readonly NextStep[];
}

export function renderSuccess(envelope: RenderEnvelope, mode: OutputMode): string {
  if (mode === "quiet") {
    return "";
  }

  const payload = { status: "ok" as const, ...envelope };
  if (mode === "json") {
    return `${JSON.stringify(payload, null, 2)}\n`;
  }
  if (mode === "agent") {
    return renderToon(payload);
  }

  return renderHuman(payload);
}

export function renderError(error: AkuaCliError, mode: OutputMode): string {
  const payload = error.toPayload();
  if (mode === "quiet") {
    return "";
  }
  if (mode === "json") {
    return `${JSON.stringify(payload, null, 2)}\n`;
  }
  if (mode === "agent") {
    return renderToon(payload);
  }

  const lines = [`Error: ${error.message}`];
  if (error.requestId) {
    lines.push(`Request ID: ${error.requestId}`);
  }
  if (error.nextSteps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of error.nextSteps) {
      lines.push(`  ${step.command}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderToon(value: unknown): string {
  return `${renderValue(value, 0).join("\n")}\n`;
}

function renderHuman(envelope: RenderEnvelope): string {
  const lines: string[] = [];
  if (envelope.observations) {
    lines.push(...envelope.observations);
  }
  if (envelope.data !== undefined) {
    if (Array.isArray(envelope.data)) {
      lines.push(...renderHumanTable(envelope.data));
    } else {
      lines.push(JSON.stringify(envelope.data, null, 2));
    }
  }
  if (envelope.next_steps && envelope.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of envelope.next_steps) {
      lines.push(`  ${step.command}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderHumanTable(rows: readonly unknown[]): string[] {
  if (rows.length === 0) {
    return ["No results."];
  }
  const objects = rows.filter(isRecord);
  if (objects.length !== rows.length) {
    return rows.map((row) => String(row));
  }
  const keys = Object.keys(objects[0] ?? {}).slice(0, 5);
  const widths = keys.map((key) => Math.max(key.length, ...objects.map((row) => String(row[key] ?? "").length)));
  const header = keys.map((key, index) => key.padEnd(widths[index])).join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");
  const body = objects.map((row) => keys.map((key, index) => String(row[key] ?? "").padEnd(widths[index])).join("  "));
  return [header, divider, ...body];
}

function renderValue(value: unknown, indent: number, key?: string): string[] {
  const prefix = " ".repeat(indent);
  if (value === undefined) {
    return [];
  }
  if (value === null || typeof value !== "object") {
    return [`${prefix}${key ? `${key}: ` : ""}${String(value)}`];
  }
  if (Array.isArray(value)) {
    return renderArray(value, indent, key);
  }

  const lines: string[] = [];
  if (key) {
    lines.push(`${prefix}${key}:`);
  }
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    lines.push(...renderValue(childValue, key ? indent + 2 : indent, childKey));
  }
  return lines;
}

function renderArray(values: readonly unknown[], indent: number, key = "items"): string[] {
  const prefix = " ".repeat(indent);
  if (values.length === 0) {
    return [`${prefix}${key}[0]:`];
  }

  if (values.every(isRecord)) {
    const rows = values as readonly Record<string, unknown>[];
    const keys = Object.keys(rows[0] ?? {}).filter((candidate) =>
      rows.every((row) => row[candidate] === undefined || row[candidate] === null || typeof row[candidate] !== "object"),
    );
    if (keys.length > 0) {
      return [
        `${prefix}${key}[${rows.length}]{${keys.join(",")}}:`,
        ...rows.map((row) => `${prefix}  ${keys.map((field) => escapeCell(row[field])).join(",")}`),
      ];
    }
  }

  return [`${prefix}${key}[${values.length}]:`, ...values.map((item) => `${prefix}  ${String(item)}`)];
}

function escapeCell(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  const text = String(value);
  if (/[\n,]/.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
