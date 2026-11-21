import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { capture, XcreproError } from './exec.ts';
import { walk } from './fsutil.ts';
import { formatUuid, normalizeBinaryUuids, parseMachO, remapDsymUuids } from './macho.ts';

export interface NormalizeReport {
	uuids: Array<{ file: string; from: string; to: string }>;
	removed: string[];
	relocations: string[];
	warnings: string[];
}

/**
 * Post-processes an .xcframework in place so its bytes don't depend on where or when it was built.
 * Idempotent: running it twice yields the same output.
 */
export function normalizeXcframework(xcframework: string): NormalizeReport {
	if (!existsSync(join(xcframework, 'Info.plist'))) throw new XcreproError(`${xcframework} is not an .xcframework (no Info.plist)`);
	const report: NormalizeReport = { uuids: [], removed: [], relocations: [], warnings: [] };
	removeProjectSourceInfo(xcframework, report);
	normalizeUuids(xcframework, report);
	rewriteRelocations(xcframework, report);
	normalizeInfoPlist(join(xcframework, 'Info.plist'));
	return report;
}

/**
 * `<Module>.swiftmodule/Project/` holds .swiftsourceinfo with absolute source paths. The
 * compiler puts it in `Project/` precisely so it can be left out of distributed modules.
 */
function removeProjectSourceInfo(root: string, report: NormalizeReport): void {
	for (const e of walk(root)) {
		if (e.kind === 'dir' && basename(e.rel) === 'Project' && e.rel.split('/').at(-2)?.endsWith('.swiftmodule') && existsSync(e.abs)) {
			rmSync(e.abs, { recursive: true });
			report.removed.push(e.rel);
		}
	}
}

function isMachO(path: string): boolean {
	const fd = openSync(path, 'r');
	try {
		const head = Buffer.alloc(4);
		if (readSync(fd, head, 0, 4, 0) < 4) return false;
		const be = head.readUInt32BE(0);
		const le = head.readUInt32LE(0);
		return be === 0xcafebabe || be === 0xcafebabf || le === 0xfeedface || le === 0xfeedfacf;
	} finally {
		closeSync(fd);
	}
}

/**
 * The linker hashes the binary into LC_UUID before stripping, while its debug map still holds
 * absolute paths (including the Xcode install path). Re-derive each UUID from the stripped bytes
 * and apply the same change to the matching dSYM so symbolication keeps working.
 */
function normalizeUuids(root: string, report: NormalizeReport): void {
	const machos = walk(root).filter((e) => e.kind === 'file' && isMachO(e.abs));
	const dsyms: typeof machos = [];
	const mapping = new Map<string, Buffer>();
	for (const e of machos) {
		const buf = readFileSync(e.abs);
		const slices = parseMachO(buf);
		if (!slices) continue;
		if (slices.every((s) => s.filetype === 0xa)) {
			dsyms.push(e);
			continue;
		}
		const before = Buffer.from(buf);
		const m = normalizeBinaryUuids(buf);
		for (const [from, to] of m) {
			mapping.set(from, to);
			mapping.set(to.toString('hex'), to);
			if (from !== to.toString('hex')) report.uuids.push({ file: e.rel, from: formatUuid(Buffer.from(from, 'hex')), to: formatUuid(to) });
		}
		if (!before.equals(buf)) writeFileSync(e.abs, buf);
	}
	for (const e of dsyms) {
		const buf = readFileSync(e.abs);
		const before = Buffer.from(buf);
		const unmatched = remapDsymUuids(buf, mapping);
		for (const u of unmatched) report.warnings.push(`${e.rel}: dSYM UUID ${formatUuid(Buffer.from(u, 'hex'))} matches no binary in the xcframework`);
		if (!before.equals(buf)) writeFileSync(e.abs, buf);
	}
}

/**
 * dSYM `Relocations/<arch>/*.yml` record the absolute path of the binary at link time.
 * Replace it with the binary's path inside the xcframework.
 */
function rewriteRelocations(root: string, report: NormalizeReport): void {
	for (const e of walk(root)) {
		if (e.kind !== 'file' || !e.rel.endsWith('.yml') || !e.rel.includes('/Contents/Resources/Relocations/')) continue;
		const libraryId = e.rel.split('/')[0]!;
		const text = readFileSync(e.abs, 'utf8');
		const next = text.replace(/^(binary-path:\s*)'((?:[^']|'')*)'/m, (whole, prefix: string, quoted: string) => {
			const value = quoted.replace(/''/g, "'");
			if (!value.startsWith('/')) return whole;
			const inBundle = /([^/]+\.framework\/.*)$/.exec(value)?.[1] ?? basename(value);
			return `${prefix}'${`${libraryId}/${inBundle}`.replace(/'/g, "''")}'`;
		});
		if (next !== text) {
			writeFileSync(e.abs, next);
			report.relocations.push(e.rel);
		}
	}
}

interface XcframeworkPlist {
	AvailableLibraries?: Array<{ LibraryIdentifier?: string; SupportedArchitectures?: string[] }>;
}

/**
 * xcodebuild lists AvailableLibraries in a nondeterministic order. Sort them, then let plutil
 * serialize so the layout stays byte-identical to what Apple's tools write.
 */
export function normalizeInfoPlist(file: string): void {
	const data = JSON.parse(capture('plutil', ['-convert', 'json', '-o', '-', file])) as XcframeworkPlist;
	const libs = data.AvailableLibraries ?? [];
	libs.sort((a, b) => cmp(a.LibraryIdentifier ?? '', b.LibraryIdentifier ?? ''));
	for (const lib of libs) lib.SupportedArchitectures?.sort(cmp);
	const dir = mkdtempSync(join(tmpdir(), 'xcrepro-'));
	try {
		const json = join(dir, 'Info.json');
		writeFileSync(json, JSON.stringify(data));
		capture('plutil', ['-convert', 'xml1', '-o', file, json]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Locale-independent ordering, so the result doesn't depend on the builder's locale. */
function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
