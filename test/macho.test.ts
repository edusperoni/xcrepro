import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MH_DSYM, formatUuid, normalizeBinaryUuids, parseMachO, remapDsymUuids } from '../src/macho.ts';

const MH_DYLIB = 0x6;
const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;

/** Minimal 64-bit Mach-O: header, LC_UUID, one unrelated load command, then `payload`. */
function thin(opts: { cputype: number; filetype: number; uuid: number; payload: string }): Buffer {
	const header = Buffer.alloc(32);
	header.writeUInt32LE(0xfeedfacf, 0);
	header.writeInt32LE(opts.cputype, 4);
	header.writeUInt32LE(opts.filetype, 12);
	header.writeUInt32LE(2, 16);
	header.writeUInt32LE(24 + 16, 20);
	const uuidCmd = Buffer.alloc(24);
	uuidCmd.writeUInt32LE(0x1b, 0);
	uuidCmd.writeUInt32LE(24, 4);
	uuidCmd.fill(opts.uuid, 8);
	const other = Buffer.alloc(16);
	other.writeUInt32LE(0x2a, 0);
	other.writeUInt32LE(16, 4);
	return Buffer.concat([header, uuidCmd, other, Buffer.from(opts.payload)]);
}

function fat(slices: Buffer[]): Buffer {
	const align = 0x1000;
	const header = Buffer.alloc(8 + slices.length * 20);
	header.writeUInt32BE(0xcafebabe, 0);
	header.writeUInt32BE(slices.length, 4);
	const parts: Buffer[] = [header];
	let offset = align;
	slices.forEach((s, i) => {
		header.writeInt32BE(s.readInt32LE(4), 8 + i * 20);
		header.writeUInt32BE(offset, 8 + i * 20 + 8);
		header.writeUInt32BE(s.length, 8 + i * 20 + 12);
		header.writeUInt32BE(12, 8 + i * 20 + 16);
		const used = parts.reduce((n, p) => n + p.length, 0);
		parts.push(Buffer.alloc(offset - used), s);
		offset = Math.ceil((offset + s.length) / align) * align;
	});
	return Buffer.concat(parts);
}

const uuidOf = (buf: Buffer, i = 0) => {
	const s = parseMachO(buf)![i]!;
	return buf.subarray(s.uuidOffset!, s.uuidOffset! + 16).toString('hex');
};

test('parses thin and fat files and ignores non-Mach-O', () => {
	const a = thin({ cputype: CPU_ARM64, filetype: MH_DYLIB, uuid: 1, payload: 'a' });
	assert.equal(parseMachO(a)?.length, 1);
	assert.equal(parseMachO(a)?.[0]?.uuidOffset, 40);
	const f = fat([a, thin({ cputype: CPU_X86_64, filetype: MH_DYLIB, uuid: 2, payload: 'b' })]);
	assert.deepEqual(
		parseMachO(f)?.map((s) => s.cputype),
		[CPU_ARM64, CPU_X86_64],
	);
	assert.equal(parseMachO(Buffer.from('!<arch>\nnot a macho')), undefined);
});

test('UUID depends on content only, not on the UUID the linker picked', () => {
	const a = thin({ cputype: CPU_ARM64, filetype: MH_DYLIB, uuid: 0x11, payload: 'same code' });
	const b = thin({ cputype: CPU_ARM64, filetype: MH_DYLIB, uuid: 0x22, payload: 'same code' });
	const c = thin({ cputype: CPU_ARM64, filetype: MH_DYLIB, uuid: 0x11, payload: 'other code' });
	normalizeBinaryUuids(a);
	normalizeBinaryUuids(b);
	normalizeBinaryUuids(c);
	assert.equal(uuidOf(a), uuidOf(b));
	assert.notEqual(uuidOf(a), uuidOf(c));
	assert.match(formatUuid(Buffer.from(uuidOf(a), 'hex')), /^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
});

test('normalizing is idempotent', () => {
	const a = thin({ cputype: CPU_ARM64, filetype: MH_DYLIB, uuid: 0x33, payload: 'x' });
	normalizeBinaryUuids(a);
	const once = Buffer.from(a);
	normalizeBinaryUuids(a);
	assert.deepEqual(a, once);
});

test('dSYM slices follow their binary slice, per architecture', () => {
	const bin = fat([
		thin({ cputype: CPU_ARM64, filetype: MH_DYLIB, uuid: 0xa1, payload: 'arm' }),
		thin({ cputype: CPU_X86_64, filetype: MH_DYLIB, uuid: 0xb2, payload: 'x86' }),
	]);
	const dsym = fat([
		thin({ cputype: CPU_ARM64, filetype: MH_DSYM, uuid: 0xa1, payload: 'dwarf-arm' }),
		thin({ cputype: CPU_X86_64, filetype: MH_DSYM, uuid: 0xb2, payload: 'dwarf-x86' }),
	]);
	const mapping = normalizeBinaryUuids(bin);
	assert.deepEqual(remapDsymUuids(dsym, mapping), []);
	assert.equal(uuidOf(dsym, 0), uuidOf(bin, 0));
	assert.equal(uuidOf(dsym, 1), uuidOf(bin, 1));
	assert.notEqual(uuidOf(bin, 0), uuidOf(bin, 1));
});

test('reports dSYM slices with no matching binary', () => {
	const dsym = thin({ cputype: CPU_ARM64, filetype: MH_DSYM, uuid: 0xcc, payload: 'dwarf' });
	assert.deepEqual(remapDsymUuids(dsym, new Map()), ['cc'.repeat(16)]);
});

test('the code signature is excluded from the UUID (it covers the old UUID)', () => {
	const withSig = (sigFill: number) => {
		const b = thin({ cputype: CPU_ARM64, filetype: MH_DYLIB, uuid: 0x44, payload: 'code' + 'S'.repeat(16) });
		// Turn the unrelated load command into LC_CODE_SIGNATURE covering the last 16 bytes.
		b.writeUInt32LE(0x1d, 56);
		b.writeUInt32LE(b.length - 16, 64);
		b.writeUInt32LE(16, 68);
		b.fill(sigFill, b.length - 16);
		return b;
	};
	const a = withSig(0xaa);
	const b = withSig(0xbb);
	assert.deepEqual(parseMachO(a)![0]!.codeSignature, { offset: a.length - 16, size: 16 });
	normalizeBinaryUuids(a);
	normalizeBinaryUuids(b);
	assert.equal(uuidOf(a), uuidOf(b));
});
