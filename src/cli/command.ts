import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { commandRegistry } from "../generated/commands.gen";

export type CommandHandler<R> = () => Effect.Effect<void, never, R>;

const globalFlags = {
  output: Flag.choice("output", ["human", "agent", "json", "quiet"]).pipe(
    Flag.withAlias("o"),
    Flag.optional,
    Flag.withDescription("Choose human, agent, JSON, or quiet output"),
  ),
  json: Flag.boolean("json").pipe(
    Flag.withDescription("Write the result as JSON"),
  ),
  quiet: Flag.boolean("quiet").pipe(
    Flag.withAlias("q"),
    Flag.withDescription("Suppress successful output"),
  ),
};

const resourceNames = new Set(commandRegistry.map((definition) => definition.resource));

export function shouldShowGroupHelp(argv: readonly string[]): boolean {
  return (
    argv.length === 1 &&
    (argv[0] === "auth" || resourceNames.has(argv[0]))
  );
}

export function makeAkuaCommand<R>(handler: CommandHandler<R>) {
  const auth = Command.make("auth", {}, handler).pipe(
    Command.withDescription("Manage browser/device authentication"),
    Command.withShortDescription("Sign in, inspect, or remove local credentials"),
    Command.withSubcommands([
      Command.make(
        "login",
        {
          noBrowser: Flag.boolean("no-browser").pipe(
            Flag.withDescription("Do not open the verification URL automatically"),
          ),
          token: Flag.string("token").pipe(
            Flag.optional,
            Flag.withDescription("Save an explicit API token for automation"),
          ),
        },
        handler,
      ).pipe(
        Command.withDescription(
          "Sign in with a browser/device flow and store only the access token",
        ),
      ),
      Command.make("status", {}, handler).pipe(
        Command.withDescription("Show the current credential source"),
      ),
      Command.make("logout", {}, handler).pipe(
        Command.withDescription("Remove the locally stored credential"),
      ),
    ]),
  );

  const commands = Command.make(
    "commands",
    {
      operationId: Flag.string("operation-id").pipe(
        Flag.optional,
        Flag.withDescription("Show one OpenAPI operation by its ID"),
      ),
      resource: Flag.string("resource").pipe(
        Flag.optional,
        Flag.withDescription("Show operations for one resource"),
      ),
      limit: Flag.integer("limit").pipe(
        Flag.optional,
        Flag.withDescription("Limit displayed operations (default: 20)"),
      ),
    },
    handler,
  ).pipe(
    Command.withDescription("List generated public OpenAPI commands"),
    Command.withShortDescription("Discover API commands before executing them"),
  );

  const pkg = Command.make("pkg", {}, handler).pipe(
    Command.withDescription("Run Akua Package commands through the embedded native toolchain"),
    Command.withShortDescription("Build, render, publish, and inspect Packages"),
  );

  const resources = [...resourceNames]
    .sort()
    .map((resource) =>
      Command.make(resource, {}, handler).pipe(
        Command.withDescription(`Run generated ${resource} API commands`),
        Command.withSubcommands(
          commandRegistry
            .filter((definition) => definition.resource === resource)
            .map((definition) =>
              Command.make(
                definition.action,
                {
                  input: Flag.string("input").pipe(
                    Flag.optional,
                    Flag.withDescription(
                      "JSON request input from stdin (-) or a file path",
                    ),
                  ),
                },
                handler,
              ).pipe(Command.withDescription(definition.summary)),
            ),
        ),
      ),
    );

  return Command.make("akua", {}, handler).pipe(
    Command.withDescription(
      "Control Akua through generated public API commands and browser/device authentication",
    ),
    Command.withSharedFlags(globalFlags),
    Command.withSubcommands([auth, commands, pkg, ...resources]),
  );
}
