/**
 * Filesystem helpers for suites that are not yet fully on it.effect.
 * Backed by Effect FileSystem + BunServices so tests stay off node:builtins.
 */
import { Effect, FileSystem, Path } from 'effect';
import { BunServices } from '@effect/platform-bun';

const provide = <A, E>(effect: Effect.Effect<A, E>) =>
	effect.pipe(Effect.provide(BunServices.layer));

const withFsSync = <A>(body: (fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A>): A =>
	Effect.runSync(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			return yield* body(fs, path);
		}).pipe(provide)
	);

const withFs = <A>(
	body: (fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A>
): Promise<A> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			return yield* body(fs, path);
		}).pipe(provide)
	);

export const readFileStringSync = (filePath: string): string =>
	withFsSync((fs) => fs.readFileString(filePath));

export const existsSync = (filePath: string): boolean => withFsSync((fs) => fs.exists(filePath));

export const readDirSync = (dirPath: string): string[] =>
	withFsSync((fs) =>
		fs.readDirectory(dirPath).pipe(Effect.map((entries) => entries.slice().sort()))
	);

export const joinPath = (...parts: string[]): string =>
	withFsSync((_fs, path) => Effect.succeed(path.join(...parts)));

export const parsePath = (filePath: string) =>
	withFsSync((_fs, path) => Effect.succeed(path.parse(filePath)));

export const readFileString = (filePath: string): Promise<string> =>
	withFs((fs) => fs.readFileString(filePath));

export const writeFileString = (
	filePath: string,
	contents: string,
	options?: { readonly mode?: number }
): Promise<void> =>
	withFs((fs) =>
		fs.writeFileString(filePath, contents, {
			mode: options?.mode
		})
	);

export const mkdirp = (dirPath: string, options?: { readonly mode?: number }): Promise<void> =>
	withFs((fs) =>
		fs.makeDirectory(dirPath, {
			recursive: true,
			mode: options?.mode
		})
	);

export const chmodPath = (filePath: string, mode: number): Promise<void> =>
	withFs((fs) => fs.chmod(filePath, mode));

export const removePath = (
	filePath: string,
	options?: { readonly recursive?: boolean; readonly force?: boolean }
): Promise<void> =>
	withFs((fs) =>
		fs.remove(filePath, {
			recursive: options?.recursive,
			force: options?.force
		})
	);

export const statMode = (filePath: string): Promise<number> =>
	withFs((fs) =>
		fs.stat(filePath).pipe(
			Effect.map((info) => {
				const mode = info.mode;
				return typeof mode === 'number' ? mode : Number(mode);
			})
		)
	);

export const mkdtempPath = (prefix: string): Promise<string> =>
	withFs((fs) =>
		fs.makeTempDirectory({
			directory: process.cwd(),
			prefix
		})
	);

export const copyFilePath = (fromPath: string, toPath: string): Promise<void> =>
	withFs((fs) => fs.copyFile(fromPath, toPath));

export const symlinkPath = (target: string, linkPath: string): Promise<void> =>
	withFs((fs) => fs.symlink(target, linkPath));
