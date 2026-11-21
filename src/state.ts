import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { XcreproError } from './exec.ts';

/**
 * Build state: a content-addressed link between a target's source inputs and its committed
 * artifact. Answers "is the committed artifact in sync with its sources?" (check) and "can the
 * build be skipped?" (is-current) without rebuilding, for any platform (xcframework, aar, ...).
 */

export interface StateTarget {
	/** Files or directories whose content determines the artifact. */
	sources: string[];
	/** The built artifact (file or directory). */
	artifact: string;
}

export interface StateConfig {
	/** The committed state file. */
	file: string;
	/** Directory that source paths in the state are made relative to. */
	base: string;
	targets: Record<string, StateTarget>;
	/** Path segments to skip anywhere under a source (build outputs, IDE files...). */
	ignore: string[];
}

export const DEFAULT_IGNORE = ['build', 'dist', '.gradle', '.kotlin', '.idea', 'xcuserdata', 'DerivedData', 'bin', '.settings', '.project', '.DS_Store'];

const STATE_VERSION = 1;

interface RecordedTarget {
	sourceHash: string;
	artifactHash: string;
}

type StateFile = { version: number } & Record<string, RecordedTarget | number>;

export interface TargetStatus {
	target: string;
	ok: boolean;
	reason: string;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

function isSymlink(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Digest over a sorted `rel\0kind\0hash` manifest of every file and symlink under `roots`
 * (symlinks hashed by target, never followed). Missing roots are skipped. Format-compatible
 * with NativeScript core's tools/native-state.mjs.
 */
export function hashInputs(roots: string[], base: string, ignore: readonly string[] = DEFAULT_IGNORE): { digest: string; count: number } {
	const ignored = new Set(ignore);
	const entries: Array<[rel: string, kind: string, hash: string]> = [];
	const collect = (path: string) => {
		const rel = relative(base, path).split('\\').join('/');
		if (rel && rel.split('/').some((seg) => ignored.has(seg))) return;
		if (!existsSync(path) && !isSymlink(path)) return;
		const st = lstatSync(path);
		if (st.isSymbolicLink()) entries.push([rel, 'link', sha256(readlinkSync(path))]);
		else if (st.isDirectory()) for (const name of readdirSync(path).sort()) collect(join(path, name));
		else if (st.isFile()) entries.push([rel, 'file', sha256(readFileSync(path))]);
	};
	for (const r of roots) collect(r);
	entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const manifest = entries.map(([rel, kind, hash]) => `${rel}\0${kind}\0${hash}`).join('\n');
	return { digest: `sha256:${sha256(manifest)}`, count: entries.length };
}

export class BuildState {
	private readonly config: StateConfig;

	constructor(config: StateConfig) {
		this.config = config;
	}

	targets(requested: string[] = []): string[] {
		const all = Object.keys(this.config.targets);
		if (all.length === 0) throw new XcreproError('state: no targets configured');
		for (const t of requested) if (!this.config.targets[t]) throw new XcreproError(`state: unknown target "${t}" (configured: ${all.join(', ')})`);
		return requested.length ? requested : all;
	}

	sourceHash(target: string): string {
		return hashInputs(this.target(target).sources, this.config.base, this.config.ignore).digest;
	}

	artifactHash(target: string): string | undefined {
		const artifact = this.target(target).artifact;
		if (!existsSync(artifact) && !isSymlink(artifact)) return undefined;
		return hashInputs([artifact], dirname(artifact), []).digest;
	}

	/** Records current source and artifact hashes; returns them per target. */
	write(requested: string[] = []): Record<string, RecordedTarget> {
		const state = this.read();
		const written: Record<string, RecordedTarget> = {};
		for (const t of this.targets(requested)) {
			const artifactHash = this.artifactHash(t);
			if (!artifactHash) throw new XcreproError(`state: cannot record ${t}, artifact missing at ${this.target(t).artifact}`);
			state[t] = written[t] = { sourceHash: this.sourceHash(t), artifactHash };
		}
		// Configured targets first in config order, then any others already in the file, so the
		// committed file stays stable and diff-friendly.
		const ordered: Record<string, unknown> = { version: STATE_VERSION };
		const keys = [...Object.keys(this.config.targets), ...Object.keys(state).filter((k) => k !== 'version' && !this.config.targets[k])];
		for (const k of keys) {
			const v = state[k];
			if (v && typeof v === 'object') ordered[k] = { sourceHash: v.sourceHash, artifactHash: v.artifactHash };
		}
		writeFileSync(this.config.file, `${JSON.stringify(ordered, null, '\t')}\n`);
		return written;
	}

	status(target: string): TargetStatus {
		const recorded = this.read()[target];
		const result = (ok: boolean, reason: string) => ({ target, ok, reason });
		if (!recorded || typeof recorded !== 'object') return result(false, 'no recorded state (never recorded with `state write`)');
		if (recorded.sourceHash !== this.sourceHash(target)) return result(false, 'sources changed since the artifact was built');
		const artifact = this.artifactHash(target);
		if (!artifact) return result(false, 'artifact is missing');
		if (artifact !== recorded.artifactHash) return result(false, 'artifact does not match the recorded hash (modified or rebuilt without recording)');
		return result(true, 'up to date');
	}

	private target(name: string): StateTarget {
		const t = this.config.targets[name];
		if (!t) throw new XcreproError(`state: unknown target "${name}"`);
		return t;
	}

	private read(): StateFile {
		if (!existsSync(this.config.file)) return { version: STATE_VERSION };
		const state = JSON.parse(readFileSync(this.config.file, 'utf8')) as StateFile;
		if (state.version !== STATE_VERSION) throw new XcreproError(`state: ${this.config.file} has unsupported version ${String(state.version)}`);
		return state;
	}
}
