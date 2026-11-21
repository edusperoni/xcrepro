import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Entry {
	/** Path relative to the walk root, always `/`-separated. */
	rel: string;
	abs: string;
	kind: 'file' | 'dir' | 'symlink';
}

const IGNORED = new Set(['.DS_Store']);

/** Depth-first walk in sorted order; symlinks are reported, never followed. */
export function walk(root: string): Entry[] {
	const out: Entry[] = [];
	const visit = (abs: string, rel: string) => {
		for (const name of readdirSync(abs).sort()) {
			if (IGNORED.has(name)) continue;
			const childAbs = join(abs, name);
			const childRel = rel ? `${rel}/${name}` : name;
			const st = lstatSync(childAbs);
			if (st.isSymbolicLink()) out.push({ rel: childRel, abs: childAbs, kind: 'symlink' });
			else if (st.isDirectory()) {
				out.push({ rel: childRel, abs: childAbs, kind: 'dir' });
				visit(childAbs, childRel);
			} else if (st.isFile()) out.push({ rel: childRel, abs: childAbs, kind: 'file' });
		}
	};
	const st = lstatSync(root);
	if (st.isDirectory()) visit(root, '');
	else out.push({ rel: '', abs: root, kind: st.isSymbolicLink() ? 'symlink' : 'file' });
	return out;
}
