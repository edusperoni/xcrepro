import { createHash } from 'node:crypto';

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const LC_UUID = 0x1b;
export const MH_DSYM = 0xa;

export interface MachOSlice {
	offset: number;
	size: number;
	cputype: number;
	cpusubtype: number;
	filetype: number;
	/** Absolute file offset of the 16 LC_UUID bytes, if the slice has one. */
	uuidOffset?: number;
}

/** Returns the slices of a thin or fat Mach-O file, or undefined if `buf` isn't one. */
export function parseMachO(buf: Buffer): MachOSlice[] | undefined {
	if (buf.length < 8) return undefined;
	const beMagic = buf.readUInt32BE(0);
	if (beMagic === FAT_MAGIC || beMagic === FAT_MAGIC_64) {
		const is64 = beMagic === FAT_MAGIC_64;
		const n = buf.readUInt32BE(4);
		// 0xcafebabe is also the Java class file magic; real fat files have only a handful of slices.
		if (n === 0 || n > 32) return undefined;
		const entrySize = is64 ? 32 : 20;
		if (buf.length < 8 + n * entrySize) return undefined;
		const slices: MachOSlice[] = [];
		for (let i = 0; i < n; i++) {
			const at = 8 + i * entrySize;
			const offset = is64 ? Number(buf.readBigUInt64BE(at + 8)) : buf.readUInt32BE(at + 8);
			const size = is64 ? Number(buf.readBigUInt64BE(at + 16)) : buf.readUInt32BE(at + 12);
			const thin = parseThin(buf, offset, size);
			if (!thin) return undefined;
			slices.push(thin);
		}
		return slices;
	}
	const thin = parseThin(buf, 0, buf.length);
	return thin ? [thin] : undefined;
}

function parseThin(buf: Buffer, offset: number, size: number): MachOSlice | undefined {
	if (offset + 28 > buf.length || offset + size > buf.length) return undefined;
	const magic = buf.readUInt32LE(offset);
	if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) return undefined;
	const headerSize = magic === MH_MAGIC_64 ? 32 : 28;
	const slice: MachOSlice = {
		offset,
		size,
		cputype: buf.readInt32LE(offset + 4),
		cpusubtype: buf.readInt32LE(offset + 8),
		filetype: buf.readUInt32LE(offset + 12),
	};
	const ncmds = buf.readUInt32LE(offset + 16);
	let at = offset + headerSize;
	for (let i = 0; i < ncmds && at + 8 <= offset + size; i++) {
		const cmd = buf.readUInt32LE(at);
		const cmdsize = buf.readUInt32LE(at + 4);
		if (cmd === LC_UUID && cmdsize >= 24) {
			slice.uuidOffset = at + 8;
			break;
		}
		if (cmdsize < 8) break;
		at += cmdsize;
	}
	return slice;
}

/** A UUID derived from the slice's bytes with its own UUID zeroed, so identical content gets an identical UUID. */
export function contentUuid(buf: Buffer, slice: MachOSlice): Buffer {
	if (slice.uuidOffset === undefined) throw new Error('slice has no LC_UUID');
	const copy = Buffer.from(buf.subarray(slice.offset, slice.offset + slice.size));
	copy.fill(0, slice.uuidOffset - slice.offset, slice.uuidOffset - slice.offset + 16);
	const uuid = createHash('sha256').update(copy).digest().subarray(0, 16);
	uuid[6] = (uuid[6]! & 0x0f) | 0x50; // RFC 4122 version 5 (name-based, SHA)
	uuid[8] = (uuid[8]! & 0x3f) | 0x80; // RFC 4122 variant
	return uuid;
}

export function formatUuid(uuid: Buffer): string {
	const h = uuid.toString('hex').toUpperCase();
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Rewrites LC_UUID of every non-dSYM slice in `buf` to its content UUID.
 * Returns old→new UUID (hex) for each slice; `buf` is modified in place.
 */
export function normalizeBinaryUuids(buf: Buffer): Map<string, Buffer> {
	const mapping = new Map<string, Buffer>();
	for (const slice of parseMachO(buf) ?? []) {
		if (slice.filetype === MH_DSYM || slice.uuidOffset === undefined) continue;
		const old = buf.subarray(slice.uuidOffset, slice.uuidOffset + 16).toString('hex');
		const next = contentUuid(buf, slice);
		next.copy(buf, slice.uuidOffset);
		mapping.set(old, next);
	}
	return mapping;
}

/** Applies an old→new UUID mapping to the dSYM slices in `buf`. Returns the old UUIDs that had no mapping. */
export function remapDsymUuids(buf: Buffer, mapping: ReadonlyMap<string, Buffer>): string[] {
	const unmatched: string[] = [];
	for (const slice of parseMachO(buf) ?? []) {
		if (slice.filetype !== MH_DSYM || slice.uuidOffset === undefined) continue;
		const old = buf.subarray(slice.uuidOffset, slice.uuidOffset + 16).toString('hex');
		const next = mapping.get(old);
		if (next) next.copy(buf, slice.uuidOffset);
		else unmatched.push(old);
	}
	return unmatched;
}
