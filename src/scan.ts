import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { walk } from './fsutil.ts';
import { CANONICAL_DEVELOPER_DIR, pathSpellings } from './settings.ts';

export interface Leak {
	file: string;
	reason: string;
	/** The printable string surrounding the match. */
	context: string;
}

export interface ScanOptions {
	/** Source roots that must not appear in the output. */
	roots?: string[];
	/** Substrings to ignore when they appear in a leak's context. */
	allow?: string[];
	/** Stop collecting after this many leaks per file. */
	maxPerFile?: number;
}

const GENERIC: Array<[needle: string, reason: string]> = [
	['/Users/', 'macOS home directory'],
	['/home/', 'Linux home directory'],
	['/var/folders/', 'macOS temp directory'],
	['/Library/Developer/Xcode/DerivedData', 'Xcode DerivedData'],
	['/Volumes/', 'mounted volume path'],
];

/**
 * Scans the raw bytes of every file for machine-specific paths. Raw bytes matter: `strings`
 * skips parts of Mach-O files (e.g. the symbol table in __LINKEDIT) where paths hide.
 */
export function scanTree(root: string, opts: ScanOptions = {}): Leak[] {
	const needles: Array<[Buffer, string]> = [];
	for (const r of opts.roots ?? []) for (const s of pathSpellings(r)) needles.push([Buffer.from(s), 'source root']);
	for (const s of pathSpellings(homedir())) needles.push([Buffer.from(s), 'home directory']);
	for (const [n, reason] of GENERIC) needles.push([Buffer.from(n), reason]);

	const maxPerFile = opts.maxPerFile ?? 5;
	const leaks: Leak[] = [];
	for (const e of walk(root)) {
		if (e.kind !== 'file') continue;
		const buf = readFileSync(e.abs);
		const seen = new Set<string>();
		const add = (at: number, reason: string) => {
			const context = printableAround(buf, at);
			if (seen.has(context) || opts.allow?.some((a) => context.includes(a))) return;
			seen.add(context);
			if (seen.size <= maxPerFile) leaks.push({ file: e.rel || root, reason, context });
		};
		for (const [needle, reason] of needles) {
			for (let at = buf.indexOf(needle); at !== -1; at = buf.indexOf(needle, at + needle.length)) add(at, reason);
		}
		// Any Xcode install other than the canonical one (CI images use Xcode_<version>.app).
		const xcode = Buffer.from('/Applications/Xcode');
		const canonicalApp = CANONICAL_DEVELOPER_DIR.split('/')[2]!;
		for (let at = buf.indexOf(xcode); at !== -1; at = buf.indexOf(xcode, at + xcode.length)) {
			const end = buf.indexOf(0x2f /* / */, at + '/Applications/'.length);
			const app = buf.subarray(at + '/Applications/'.length, end === -1 ? undefined : end).toString('latin1');
			if (app !== canonicalApp) add(at, 'Xcode install path');
		}
	}
	return leaks;
}

function printableAround(buf: Buffer, at: number): string {
	const printable = (b: number) => b >= 0x20 && b < 0x7f;
	let start = at;
	while (start > 0 && at - start < 200 && printable(buf[start - 1]!)) start--;
	let end = at;
	while (end < buf.length && end - at < 300 && printable(buf[end]!)) end++;
	return buf.subarray(start, end).toString('latin1');
}
