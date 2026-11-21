import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync, statSync } from 'node:fs';
import { walk } from './fsutil.ts';

export interface TreeHash {
	hash: string;
	/** rel path → per-entry digest, for diffing two trees. */
	entries: Map<string, string>;
}

/**
 * Content hash of a file or directory tree: relative paths, file bytes, the executable bit and
 * symlink targets. Timestamps, ownership and .DS_Store files are ignored.
 */
export function hashTree(root: string): TreeHash {
	const entries = new Map<string, string>();
	for (const e of walk(root)) {
		let digest: string;
		if (e.kind === 'file') {
			const exec = (statSync(e.abs).mode & 0o111) !== 0 ? 'x' : '-';
			digest = `file ${exec} ${sha256(readFileSync(e.abs))}`;
		} else if (e.kind === 'symlink') digest = `link ${readlinkSync(e.abs)}`;
		else digest = 'dir';
		entries.set(e.rel, digest);
	}
	const h = createHash('sha256');
	for (const [rel, digest] of entries) h.update(`${rel}\0${digest}\n`);
	return { hash: h.digest('hex'), entries };
}

export function diffTrees(a: TreeHash, b: TreeHash): string[] {
	const out: string[] = [];
	for (const [rel, d] of a.entries) {
		const other = b.entries.get(rel);
		if (other === undefined) out.push(`only in first: ${rel}`);
		else if (other !== d) out.push(`differs: ${rel}`);
	}
	for (const rel of b.entries.keys()) if (!a.entries.has(rel)) out.push(`only in second: ${rel}`);
	return out;
}

function sha256(buf: Buffer): string {
	return createHash('sha256').update(buf).digest('hex');
}
