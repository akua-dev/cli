import { Crypto, Data, Duration, Effect, FileSystem, Layer, Path } from 'effect';
import type * as PackageExecuteModule from '@akua-dev/sdk/execute';
import {
	HttpBody,
	HttpClient,
	HttpClientError,
	HttpClientRequest,
	HttpClientResponse
} from 'effect/http';

import { AkuaHttpClientLive } from './http-client-live';
import {
	Browser,
	BrowserFailure,
	CliClock,
	type CliServices,
	Console,
	Http,
	HttpFailure,
	Process,
	PackageCli,
	PackageCliFailure,
	PublicInput,
	PublicInputFailure,
	SecureConfig,
	SecureConfigFailure
} from './services';

const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;
const MAX_DEVICE_RESPONSE_SIZE = 16_384;

class ConfigParseFailure extends Data.TaggedError('ConfigParseFailure')<{
	readonly cause: Error;
}> {}

export function HttpLive(cliVersion: string): Layer.Layer<Http> {
	return Layer.effect(
		Http,
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;
			return {
				postJson: (request) =>
					readJsonResponse(
						HttpClientRequest.post(request.url).pipe(
							HttpClientRequest.bodyJson(request.body),
							Effect.flatMap(client.execute)
						),
						'Device response is too large.'
					)
			};
		})
	).pipe(Layer.provide(AkuaHttpClientLive(cliVersion)));
}

export const BrowserLive = Layer.succeed(Browser, {
	launch: (url) =>
		Effect.try({
			try: () => {
				const command =
					process.platform === 'darwin'
						? ['open', url]
						: process.platform === 'win32'
							? ['cmd', '/c', 'start', '', url]
							: ['xdg-open', url];
				const processHandle = Bun.spawn({
					cmd: command,
					stdout: 'ignore',
					stderr: 'ignore'
				});
				return processHandle;
			},
			catch: (cause) => new BrowserFailure({ cause })
		}).pipe(
			Effect.flatMap((processHandle) =>
				Effect.tryPromise({
					try: () => processHandle.exited,
					catch: (cause) => new BrowserFailure({ cause })
				})
			),
			Effect.flatMap((exitCode) =>
				exitCode === 0
					? Effect.void
					: Effect.fail(
							new BrowserFailure({
								cause: new Error('Browser launch failed.')
							})
						)
			)
		)
});

export const ProcessLive = Layer.succeed(Process, {
	awaitSignal: Effect.callback((resume) => {
		const cancel = () => resume(Effect.void);
		process.once('SIGINT', cancel);
		process.once('SIGTERM', cancel);
		return Effect.sync(() => {
			process.removeListener('SIGINT', cancel);
			process.removeListener('SIGTERM', cancel);
		});
	})
});

export const ConsoleLive = Layer.succeed(Console, {
	// isTTY is undefined (not false) when stdout is piped; normalize so the
	// declared boolean service contract holds at runtime.
	stdoutIsTTY: process.stdout.isTTY === true,
	writeStderr: (value) => Effect.sync(() => process.stderr.write(value)),
	writeStdout: (value) => Effect.sync(() => process.stdout.write(value))
});

export const ClockLive = Layer.succeed(CliClock, {
	currentTimeMillis: Effect.sync(Date.now),
	sleep: (duration) =>
		Effect.tryPromise({
			try: () => Bun.sleep(Duration.toMillis(duration)),
			catch: () => new Error('Clock sleep failed.')
		}).pipe(Effect.orDie)
});

export const SecureConfigLive = Layer.effect(
	SecureConfig,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const crypto = yield* Crypto.Crypto;
		return {
			readToken: (configPath) =>
				readConfig(fs, configPath).pipe(
					Effect.map((config) =>
						typeof config.token === 'string' && config.token !== '' ? config.token : undefined
					),
					Effect.mapError(
						(cause) =>
							new SecureConfigFailure({
								operation: 'read',
								path: configPath,
								cause
							})
					)
				),
			saveToken: (configPath, token) =>
				readConfig(fs, configPath).pipe(
					Effect.flatMap((config) =>
						writeConfig(fs, path, crypto, configPath, { ...config, token })
					),
					Effect.mapError(
						(cause) =>
							new SecureConfigFailure({
								operation: 'write',
								path: configPath,
								cause
							})
					)
				),
			removeToken: (configPath) =>
				readConfig(fs, configPath).pipe(
					Effect.matchEffect({
						onFailure: (cause) =>
							isNotFound(cause)
								? Effect.succeed(false)
								: removeConfig(fs, configPath).pipe(Effect.as(true)),
						onSuccess: (config) => {
							if (!Object.prototype.hasOwnProperty.call(config, 'token'))
								return Effect.succeed(false);
							const hadToken = typeof config.token === 'string' && config.token !== '';
							const { token: _token, ...remaining } = config;
							return writeConfig(fs, path, crypto, configPath, remaining).pipe(Effect.as(hadToken));
						}
					}),
					Effect.mapError(
						(cause) =>
							new SecureConfigFailure({
								operation: 'remove',
								path: configPath,
								cause
							})
					)
				)
		};
	})
);

export const PublicInputLive = Layer.effect(
	PublicInput,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return {
			read: (source) =>
				source === '-'
					? Effect.tryPromise({
							try: () => Bun.stdin.text(),
							catch: () => new PublicInputFailure()
						})
					: fs.readFileString(source).pipe(Effect.mapError(() => new PublicInputFailure()))
		};
	})
);

export const PackageCliLive = Layer.effect(
	PackageCli,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const resolvePackageExecute = yield* makeResolvePackageExecute(fs, path);
		return {
			execute: (args) =>
				resolvePackageExecute.pipe(
					Effect.flatMap((execute) =>
						Effect.try({
							try: () => execute(args, { binName: 'akua pkg' }),
							catch: (cause) => new PackageCliFailure({ cause })
						})
					),
					Effect.mapError((cause) =>
						cause instanceof PackageCliFailure ? cause : new PackageCliFailure({ cause })
					)
				)
		};
	})
);

export function CliLive(
	cliVersion: string
): Layer.Layer<CliServices, never, FileSystem.FileSystem | Path.Path | Crypto.Crypto> {
	return Layer.mergeAll(
		HttpLive(cliVersion),
		BrowserLive,
		ProcessLive,
		ConsoleLive,
		SecureConfigLive,
		PublicInputLive,
		PackageCliLive,
		ClockLive
	);
}

function readJsonResponse(
	response: Effect.Effect<
		HttpClientResponse.HttpClientResponse,
		HttpClientError.HttpClientError | HttpBody.HttpBodyError
	>,
	oversizedMessage: string
): Effect.Effect<{ readonly status: number; readonly body: unknown }, HttpFailure> {
	return response.pipe(
		Effect.flatMap((value) =>
			value.text.pipe(
				Effect.flatMap((text) =>
					text.length > MAX_DEVICE_RESPONSE_SIZE
						? Effect.fail(new HttpFailure({ cause: new Error(oversizedMessage) }))
						: Effect.try({
								try: () => ({
									status: value.status,
									body: text === '' ? {} : JSON.parse(text)
								}),
								catch: (cause) => new HttpFailure({ cause })
							})
				)
			)
		),
		Effect.mapError((cause) => (cause instanceof HttpFailure ? cause : new HttpFailure({ cause })))
	);
}

function readConfig(
	fs: FileSystem.FileSystem,
	configPath: string
): Effect.Effect<Record<string, unknown>, unknown> {
	return fs.readFileString(configPath).pipe(
		Effect.catch((cause) => (isNotFound(cause) ? Effect.succeed('{}') : Effect.fail(cause))),
		Effect.flatMap((raw) =>
			Effect.try({
				try: (): unknown => JSON.parse(raw),
				catch: (cause) => cause
			}).pipe(
				Effect.flatMap((value) =>
					isRecord(value)
						? Effect.succeed(value)
						: Effect.fail(
								new ConfigParseFailure({
									cause: new Error('Akua config must be a JSON object.')
								})
							)
				)
			)
		)
	);
}

function writeConfig(
	fs: FileSystem.FileSystem,
	path: Path.Path,
	crypto: Crypto.Crypto,
	configPath: string,
	config: Record<string, unknown>
): Effect.Effect<void, unknown> {
	return Effect.gen(function* () {
		const directory = path.dirname(configPath);
		const uuid = yield* crypto.randomUUIDv4;
		const temporary = path.join(directory, `.config.json.${uuid}.tmp`);
		const cleanup = fs.remove(temporary, { force: true }).pipe(Effect.ignore);
		yield* Effect.gen(function* () {
			yield* fs.makeDirectory(directory, {
				recursive: true,
				mode: CONFIG_DIR_MODE
			});
			yield* fs.chmod(directory, CONFIG_DIR_MODE);
			yield* fs.writeFileString(temporary, `${JSON.stringify(config, null, 2)}\n`, {
				mode: CONFIG_FILE_MODE,
				flag: 'wx'
			});
			yield* fs.chmod(temporary, CONFIG_FILE_MODE);
			yield* fs.rename(temporary, configPath);
			yield* fs.chmod(configPath, CONFIG_FILE_MODE);
		}).pipe(Effect.ensuring(cleanup));
	});
}

function removeConfig(fs: FileSystem.FileSystem, configPath: string): Effect.Effect<void, unknown> {
	return fs.remove(configPath, { force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
	if (typeof error !== 'object' || error === null || !('reason' in error)) {
		return false;
	}
	const reason = (error as { reason?: { _tag?: string } }).reason;
	return reason?._tag === 'NotFound';
}

// `bun build --compile` cannot statically bundle @akua-dev/sdk/execute: it
// transitively loads @akua-dev/native's platform .node binding, which is a
// real binary file, not JS the bundler can inline. Marking the package
// --external (release-host-live.ts) makes the compiled binary keep a real
// runtime import instead of inlining it, but a compiled executable resolves
// bare specifiers against its own embedded virtual filesystem ($bunfs), not
// the real one — so it never sees the sidecar node_modules staged next to
// it on disk. process.execPath, unlike module-resolution base paths, does
// resolve to the executable's real filesystem location even when compiled,
// so an absolute dynamic import from there reaches the sidecar package.
// This is the one place in the CLI that needs a dynamic import for that
// reason; dev/test/build (no compiled sidecar present) fall back to normal
// package resolution. The result is cached for the process lifetime via
// Effect.cached rather than a hand-rolled mutable variable.
function makeResolvePackageExecute(
	fs: FileSystem.FileSystem,
	path: Path.Path
): Effect.Effect<Effect.Effect<typeof PackageExecuteModule.execute, PackageCliFailure>> {
	return Effect.cached(
		Effect.sync(() =>
			path.join(
				path.dirname(process.execPath),
				'node_modules',
				'@akua-dev',
				'sdk',
				'dist',
				'execute.js'
			)
		).pipe(
			Effect.flatMap((sidecarPath) =>
				fs.exists(sidecarPath).pipe(
					Effect.mapError((cause) => new PackageCliFailure({ cause })),
					Effect.map((exists) => (exists ? sidecarPath : '@akua-dev/sdk/execute'))
				)
			),
			Effect.flatMap((specifier) =>
				Effect.tryPromise({
					try: () => import(specifier),
					catch: (cause) => new PackageCliFailure({ cause })
				})
			),
			Effect.map((loaded: typeof PackageExecuteModule) => loaded.execute)
		)
	);
}
