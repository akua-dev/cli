import { commandRegistry } from "../generated/commands.gen";
import type { RenderEnvelope } from "../runtime/render";

export function buildHomeView(): RenderEnvelope {
  const byTag = new Map<string, number>();
  for (const command of commandRegistry) {
    byTag.set(command.tag, (byTag.get(command.tag) ?? 0) + 1);
  }

  const topTags = [...byTag.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([tag, count]) => ({ tag, operations: count }));

  return {
    command: "akua",
    observations: [
      "Akua Cloud CLI.",
      `${commandRegistry.length} executable public OpenAPI operations are available as generated commands.`,
    ],
    data: topTags,
    next_steps: [
      { command: "akua commands" },
      { command: "akua commands --json" },
      { command: "akua pkg --help" },
      { command: "akua workspaces list --input -" },
    ],
  };
}
