#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build, type BuildOptions } from './build.ts';
import { XcreproError } from './exec.ts';
import { hashTree } from './hash.ts';
import { normalizeXcframework } from './normalize.ts';
import { PLATFORMS } from './platforms.ts';
import { scanTree, type Leak } from './scan.ts';
import { BuildState, DEFAULT_IGNORE, type StateConfig } from './state.ts';
import { xcconfig } from './settings.ts';
import { verify } from './verify.ts';
import { VERSION } from './version.ts';

const HELP = `xcrepro ${VERSION}: reproducible, path-independent XCFramework builds

Usage:
  xcrepro build     [options]           Build an .xcframework reproducibly
  xcrepro verify    [options]           Build twice from different paths and compare
  xcrepro normalize <xcframework>       Post-process an existing .xcframework in place
  xcrepro scan      <path> [--root dir] Report machine-specific paths in build output
  xcrepro hash      <path>              Print the content hash of a file or directory
  xcrepro xcconfig                      Print the build settings as an .xcconfig
  xcrepro state write [target...]       Record source + artifact hashes in the state file
  xcrepro state check [target...]       Fail if artifacts are out of sync with their sources
  xcrepro state is-current <target>     Exit 0 if the target's build can be skipped (silent)

Build options (also read from xcrepro.config.json, or --config <file>):
  --project <path> | --workspace <path>
  --scheme <name>             Scheme to build (required)
  --name <name>               Framework name (default: scheme)
  --platforms <list>          Comma-separated: ${PLATFORMS.map((p) => p.id).join(', ')}
  --configuration <name>      Default: Release
  -o, --output <dir>          Where <name>.xcframework goes (default: build)
  --root <dir>                Source root (default: git top-level of the project)
  --build-dir <dir>           Intermediates, inside the root (default: <project dir>/build/xcrepro)
  --setting KEY=VALUE         Extra build setting; repeatable, overrides xcrepro's
  --manifest <file>           Write hash, Xcode version and platforms as JSON
  --allow <text>              Ignore leaks whose context contains <text>; repeatable
  --no-strip                  Keep debug stabs in the binary (output is then path-dependent)
  --no-concise-magic-file     Keep Swift #file as an absolute path
  --no-library-evolution      Don't set BUILD_LIBRARY_FOR_DISTRIBUTION
  --no-scan                   Skip the leak scan
  --keep                      verify: keep the relocated copy
  -v, --verbose               Show full xcodebuild output

State targets are configured under "state" in xcrepro.config.json; see the README.
`;

type ConfigFile = Partial<
	Pick<BuildOptions, 'project' | 'workspace' | 'scheme' | 'name' | 'configuration' | 'platforms' | 'output' | 'root' | 'buildDir' | 'settings' | 'allow' | 'strip' | 'conciseMagicFile' | 'libraryEvolution'>
> & {
	state?: Partial<Omit<StateConfig, 'targets'>> & { targets?: StateConfig['targets'] };
	/** Directory of the config file; state paths are relative to it. */
	dir?: string;
};

const PATH_KEYS = ['project', 'workspace', 'output', 'root', 'buildDir'] as const;

function loadConfig(explicit?: string): ConfigFile {
	const file = resolve(explicit ?? 'xcrepro.config.json');
	if (!existsSync(file)) {
		if (explicit) throw new XcreproError(`config file ${file} not found`);
		return {};
	}
	const config = JSON.parse(readFileSync(file, 'utf8')) as ConfigFile;
	for (const key of PATH_KEYS) {
		const value = config[key];
		if (typeof value === 'string') config[key] = resolve(dirname(file), value);
	}
	config.dir = dirname(file);
	return config;
}

function stateConfig(config: ConfigFile): StateConfig {
	const s = config.state;
	if (!s?.targets || !config.dir) throw new UsageError('no "state.targets" in xcrepro.config.json (or the file given with --config)');
	const dir = config.dir;
	const targets: StateConfig['targets'] = {};
	for (const [name, t] of Object.entries(s.targets)) {
		if (!Array.isArray(t.sources) || typeof t.artifact !== 'string') throw new UsageError(`state target "${name}" needs "sources" (array) and "artifact"`);
		targets[name] = { sources: t.sources.map((p) => resolve(dir, p)), artifact: resolve(dir, t.artifact) };
	}
	return {
		file: resolve(dir, s.file ?? 'xcrepro.state.json'),
		base: resolve(dir, s.base ?? '.'),
		ignore: s.ignore ?? DEFAULT_IGNORE,
		targets,
	};
}

function main(argv: string[]): number {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			project: { type: 'string' },
			workspace: { type: 'string' },
			scheme: { type: 'string' },
			name: { type: 'string' },
			platforms: { type: 'string' },
			configuration: { type: 'string' },
			output: { type: 'string', short: 'o' },
			root: { type: 'string' },
			'build-dir': { type: 'string' },
			setting: { type: 'string', multiple: true },
			manifest: { type: 'string' },
			allow: { type: 'string', multiple: true },
			config: { type: 'string' },
			'no-strip': { type: 'boolean' },
			'no-concise-magic-file': { type: 'boolean' },
			'no-library-evolution': { type: 'boolean' },
			'no-scan': { type: 'boolean' },
			keep: { type: 'boolean' },
			verbose: { type: 'boolean', short: 'v' },
			help: { type: 'boolean', short: 'h' },
			version: { type: 'boolean' },
		},
	});
	const [command, ...rest] = positionals;
	if (values.version) {
		console.log(VERSION);
		return 0;
	}
	if (values.help || !command) {
		console.log(HELP);
		return values.help ? 0 : 2;
	}
	const log = (msg: string) => console.error(`[xcrepro] ${msg}`);

	switch (command) {
		case 'build':
		case 'verify': {
			const opts = buildOptions(values, loadConfig(values.config), log);
			if (command === 'build') {
				const result = build(opts);
				printLeaks(result.leaks);
				console.log(`${result.xcframework}\n${result.hash}`);
				return result.leaks.length > 0 ? 1 : 0;
			}
			const { first, second, differences } = verify({ ...opts, keep: !!values.keep });
			printLeaks(first.leaks);
			if (differences.length > 0) {
				log(`NOT reproducible: ${first.hash} vs ${second.hash}`);
				for (const d of differences) log(`  ${d}`);
				return 1;
			}
			log(`reproducible: both builds hash to ${first.hash}`);
			console.log(first.hash);
			return first.leaks.length > 0 ? 1 : 0;
		}
		case 'normalize': {
			const target = requireArg(rest, 'normalize <xcframework>');
			const report = normalizeXcframework(resolve(target));
			for (const u of report.uuids) log(`uuid ${u.file}: ${u.from} -> ${u.to}`);
			for (const r of report.removed) log(`removed ${r}`);
			for (const r of report.relocations) log(`rewrote ${r}`);
			for (const w of report.warnings) log(`warning: ${w}`);
			console.log(hashTree(resolve(target)).hash);
			return 0;
		}
		case 'scan': {
			const target = requireArg(rest, 'scan <path>');
			const leaks = scanTree(resolve(target), { roots: values.root ? [resolve(values.root)] : [], allow: values.allow });
			printLeaks(leaks);
			if (leaks.length === 0) log('no machine-specific paths found');
			return leaks.length > 0 ? 1 : 0;
		}
		case 'hash':
			console.log(hashTree(resolve(requireArg(rest, 'hash <path>'))).hash);
			return 0;
		case 'xcconfig':
			process.stdout.write(xcconfig());
			return 0;
		case 'state': {
			const [sub, ...targets] = rest;
			const state = new BuildState(stateConfig(loadConfig(values.config)));
			switch (sub) {
				case 'write':
					for (const [t, h] of Object.entries(state.write(targets))) log(`recorded ${t}: source ${h.sourceHash.slice(7, 19)}… artifact ${h.artifactHash.slice(7, 19)}…`);
					return 0;
				case 'check': {
					const results = state.targets(targets).map((t) => state.status(t));
					for (const r of results) log(`${r.target}: ${r.ok ? 'OK' : 'OUT OF SYNC'} (${r.reason})`);
					if (results.every((r) => r.ok)) return 0;
					log('rebuild the out-of-sync targets, then run `xcrepro state write` and commit the artifacts with the state file');
					return 1;
				}
				case 'is-current': {
					if (targets.length !== 1) throw new UsageError('usage: xcrepro state is-current <target>');
					return state.status(state.targets(targets)[0]!).ok ? 0 : 1;
				}
				default:
					throw new UsageError('usage: xcrepro state <write|check|is-current> [target...]');
			}
		}
		default:
			throw new UsageError(`unknown command "${command}"`);
	}
}

class UsageError extends XcreproError {}

function requireArg(rest: string[], usage: string): string {
	if (!rest[0]) throw new UsageError(`usage: xcrepro ${usage}`);
	return rest[0];
}

function buildOptions(values: Record<string, string | string[] | boolean | undefined>, config: ConfigFile, log: (m: string) => void): BuildOptions {
	const str = (k: string) => values[k] as string | undefined;
	const list = (k: string) => (values[k] as string[] | undefined) ?? [];
	const scheme = str('scheme') ?? config.scheme;
	if (!scheme) throw new UsageError('--scheme is required');
	const project = str('project') ?? (str('workspace') ? undefined : config.project);
	const workspace = str('workspace') ?? (str('project') ? undefined : config.workspace);
	return {
		project,
		workspace,
		scheme,
		name: str('name') ?? config.name,
		configuration: str('configuration') ?? config.configuration ?? 'Release',
		platforms: str('platforms')?.split(',').map((s) => s.trim()).filter(Boolean) ?? config.platforms ?? [],
		output: str('output') ?? config.output ?? 'build',
		root: str('root') ?? config.root,
		buildDir: str('build-dir') ?? config.buildDir,
		settings: [...(config.settings ?? []), ...list('setting')],
		allow: [...(config.allow ?? []), ...list('allow')],
		manifest: str('manifest'),
		strip: values['no-strip'] ? false : (config.strip ?? true),
		conciseMagicFile: values['no-concise-magic-file'] ? false : (config.conciseMagicFile ?? true),
		libraryEvolution: values['no-library-evolution'] ? false : (config.libraryEvolution ?? true),
		scan: !values['no-scan'],
		verbose: !!values.verbose,
		log,
	};
}

function printLeaks(leaks: Leak[]): void {
	if (leaks.length === 0) return;
	console.error(`[xcrepro] ${leaks.length} machine-specific path(s) in the output:`);
	for (const l of leaks) console.error(`  ${l.file} (${l.reason}): ${l.context}`);
}

try {
	process.exitCode = main(process.argv.slice(2));
} catch (e) {
	if (e instanceof XcreproError) {
		console.error(`[xcrepro] error: ${e.message}`);
		process.exitCode = e instanceof UsageError ? 2 : 1;
	} else throw e;
}
