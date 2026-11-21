import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { capture, run, tryCapture, XcreproError } from './exec.ts';
import { hashTree } from './hash.ts';
import { normalizeXcframework, type NormalizeReport } from './normalize.ts';
import { productsDir, resolvePlatforms } from './platforms.ts';
import { scanTree, type Leak } from './scan.ts';
import { BUILD_ENV, buildSettings } from './settings.ts';
import { VERSION } from './version.ts';

export interface BuildOptions {
	project?: string;
	workspace?: string;
	scheme: string;
	/** Framework (product) name; defaults to the scheme. */
	name?: string;
	configuration: string;
	platforms: string[];
	/** Directory that receives `<name>.xcframework`. */
	output: string;
	/** Source root that paths are made relative to; defaults to the git top-level of the project. */
	root?: string;
	/** Intermediate build directory; must be inside `root`. Defaults to `<project dir>/build/xcrepro`. */
	buildDir?: string;
	/** Extra `KEY=VALUE` build settings, applied after (and overriding) xcrepro's. */
	settings: string[];
	strip: boolean;
	conciseMagicFile: boolean;
	libraryEvolution: boolean;
	scan: boolean;
	/** Substrings of leak contexts to tolerate. */
	allow: string[];
	/** Write a JSON manifest (hash, Xcode version, ...) here. */
	manifest?: string;
	verbose: boolean;
	log: (msg: string) => void;
}

export interface BuildResult {
	xcframework: string;
	hash: string;
	xcode: string;
	leaks: Leak[];
	report: NormalizeReport;
}

export function resolveRoot(projectDir: string, root?: string): string {
	if (root) return resolve(root);
	return tryCapture('git', ['rev-parse', '--show-toplevel'], { cwd: projectDir }) ?? projectDir;
}

export function xcodeVersion(): string {
	return capture('xcodebuild', ['-version']).split('\n').join(' ');
}

export function build(opts: BuildOptions): BuildResult {
	if (!opts.project === !opts.workspace) throw new XcreproError('pass exactly one of --project or --workspace');
	const container = resolve((opts.project ?? opts.workspace)!);
	if (!existsSync(container)) throw new XcreproError(`${container} does not exist`);
	const projectDir = dirname(container);
	const root = resolveRoot(projectDir, opts.root);
	const buildDir = resolve(opts.buildDir ?? join(projectDir, 'build', 'xcrepro'));
	if (!isInside(root, buildDir)) {
		throw new XcreproError(`build dir ${buildDir} must be inside the source root ${root}, or intermediate paths can't be remapped`);
	}
	const name = opts.name ?? opts.scheme;
	const platforms = resolvePlatforms(opts.platforms);
	const developerDir = process.env.DEVELOPER_DIR ?? capture('xcode-select', ['-p']);
	const xcode = xcodeVersion();
	const derivedData = join(buildDir, 'DerivedData');

	opts.log(`xcrepro ${VERSION} · ${xcode}`);
	opts.log(`root: ${root}`);
	rmSync(buildDir, { recursive: true, force: true });
	mkdirSync(buildDir, { recursive: true });

	const settings = [
		...buildSettings({ root, developerDir, strip: opts.strip, conciseMagicFile: opts.conciseMagicFile, libraryEvolution: opts.libraryEvolution }),
		...opts.settings,
	];
	const env = { ...process.env, ...BUILD_ENV };
	const frameworkArgs: string[] = [];
	for (const platform of platforms) {
		opts.log(`building ${name} for ${platform.id}`);
		run(
			'xcodebuild',
			[
				opts.project ? '-project' : '-workspace',
				container,
				'-scheme',
				opts.scheme,
				'-configuration',
				opts.configuration,
				'-destination',
				platform.destination,
				'-derivedDataPath',
				derivedData,
				...(opts.verbose ? [] : ['-quiet']),
				'build',
				...settings,
			],
			{ cwd: projectDir, env },
		);
		const products = productsDir(derivedData, opts.configuration, platform);
		const framework = join(products, `${name}.framework`);
		const dsym = `${framework}.dSYM`;
		if (!existsSync(framework)) throw new XcreproError(`expected ${framework} after building ${platform.id}; is --name right?`);
		frameworkArgs.push('-framework', framework);
		if (existsSync(dsym)) frameworkArgs.push('-debug-symbols', dsym);
	}

	const staged = join(buildDir, `${name}.xcframework`);
	opts.log(`creating ${name}.xcframework`);
	run('xcodebuild', ['-create-xcframework', ...frameworkArgs, '-output', staged], { env });

	const report = normalizeXcframework(staged);
	for (const w of report.warnings) opts.log(`warning: ${w}`);

	const leaks = opts.scan ? scanTree(staged, { roots: [root, buildDir], allow: opts.allow }) : [];

	const outDir = resolve(opts.output);
	const xcframework = join(outDir, `${name}.xcframework`);
	mkdirSync(outDir, { recursive: true });
	rmSync(xcframework, { recursive: true, force: true });
	cpSync(staged, xcframework, { recursive: true, verbatimSymlinks: true });

	const { hash } = hashTree(xcframework);
	if (opts.manifest) {
		const manifest = { name, hash, xcode, xcrepro: VERSION, platforms: platforms.map((p) => p.id), configuration: opts.configuration };
		writeFileSync(resolve(opts.manifest), `${JSON.stringify(manifest, null, 2)}\n`);
	}
	return { xcframework, hash, xcode, leaks, report };
}

export function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
