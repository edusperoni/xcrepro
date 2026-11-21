import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { build, isInside, resolveRoot, type BuildOptions, type BuildResult } from './build.ts';
import { tryCapture, XcreproError } from './exec.ts';
import { diffTrees, hashTree } from './hash.ts';

export interface VerifyResult {
	first: BuildResult;
	second: BuildResult;
	differences: string[];
}

/**
 * Builds twice: in place, then from a copy of the source root at a different absolute path
 * (with a different length, so offsets shift too). Reproducible output hashes identically.
 */
export function verify(opts: BuildOptions & { keep: boolean }): VerifyResult {
	const container = resolve((opts.project ?? opts.workspace) ?? '');
	const projectDir = dirname(container);
	const root = resolveRoot(projectDir, opts.root);
	const buildDir = resolve(opts.buildDir ?? join(projectDir, 'build', 'xcrepro'));
	const output = resolve(opts.output);

	const first = build({ ...opts, root });

	const tmp = mkdtempSync(join(tmpdir(), 'xcrepro-verify-'));
	try {
		const copyRoot = join(tmp, 'a-relocated-source-tree');
		opts.log(`copying ${root} to ${copyRoot}`);
		copySources(root, copyRoot, [buildDir, output]);
		const moved = (p: string) => join(copyRoot, relative(root, p));
		const second = build({
			...opts,
			root: copyRoot,
			project: opts.project ? moved(container) : undefined,
			workspace: opts.workspace ? moved(container) : undefined,
			buildDir: moved(buildDir),
			output: join(tmp, 'out'),
			manifest: undefined,
		});
		const differences = diffTrees(hashTree(first.xcframework), hashTree(second.xcframework));
		return { first, second, differences };
	} finally {
		if (opts.keep) opts.log(`kept ${tmp}`);
		else rmSync(tmp, { recursive: true, force: true });
	}
}

/** Copies tracked + untracked-but-not-ignored files (git), or everything except `exclude` outside git. */
function copySources(root: string, dest: string, exclude: string[]): void {
	const listed = tryCapture('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root });
	if (listed !== undefined) {
		const files = listed.split('\0').filter((f) => f && !exclude.some((x) => isInside(x, join(root, f))));
		if (files.length === 0) throw new XcreproError(`git lists no files under ${root}`);
		for (const f of files) {
			mkdirSync(dirname(join(dest, f)), { recursive: true });
			cpSync(join(root, f), join(dest, f), { verbatimSymlinks: true, recursive: true });
		}
		return;
	}
	cpSync(root, dest, {
		recursive: true,
		verbatimSymlinks: true,
		filter: (src) => !exclude.some((x) => isInside(x, src)) && !src.split('/').includes('node_modules'),
	});
}
