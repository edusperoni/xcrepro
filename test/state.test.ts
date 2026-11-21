import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BuildState, DEFAULT_IGNORE, hashInputs } from '../src/state.ts';

const tmp = mkdtempSync(join(tmpdir(), 'xcrepro-state-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function fixture(name: string) {
	const root = join(tmp, name);
	const put = (rel: string, content: string) => {
		mkdirSync(join(root, rel, '..'), { recursive: true });
		writeFileSync(join(root, rel), content);
	};
	put('ios/build.sh', 'xcodebuild ...');
	put('ios/Lib/Lib.m', 'code');
	put('ios/Lib/build/Lib.o', 'ignored output');
	put('out/Lib.xcframework/Info.plist', 'plist');
	put('android/widgets/A.java', 'java');
	put('out/widgets.aar', 'aar');
	const state = new BuildState({
		file: join(root, 'state.json'),
		base: root,
		ignore: DEFAULT_IGNORE,
		targets: {
			ios: { sources: [join(root, 'ios')], artifact: join(root, 'out/Lib.xcframework') },
			android: { sources: [join(root, 'android/widgets')], artifact: join(root, 'out/widgets.aar') },
		},
	});
	return { root, put, state };
}

test('digest is sha256 over a sorted rel\\0kind\\0hash manifest (core native-state format)', () => {
	const { root } = fixture('format');
	const h = (s: string) => createHash('sha256').update(s).digest('hex');
	const manifest = [`ios/Lib/Lib.m\0file\0${h('code')}`, `ios/build.sh\0file\0${h('xcodebuild ...')}`].join('\n');
	assert.deepEqual(hashInputs([join(root, 'ios')], root), { digest: `sha256:${h(manifest)}`, count: 2 });
});

test('write records every target; check passes until sources or artifacts change', () => {
	const { root, put, state } = fixture('drift');
	assert.deepEqual(state.status('ios'), { target: 'ios', ok: false, reason: 'no recorded state (never recorded with `state write`)' });
	state.write();
	const file = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
	assert.deepEqual(Object.keys(file), ['version', 'ios', 'android']);
	assert.ok(state.status('ios').ok && state.status('android').ok);

	put('ios/Lib/build/Lib.o', 'rebuilt output');
	assert.ok(state.status('ios').ok, 'ignored segments do not count as source changes');

	put('ios/Lib/Lib.m', 'changed code');
	assert.equal(state.status('ios').reason, 'sources changed since the artifact was built');
	assert.ok(state.status('android').ok, 'targets are independent');

	state.write(['ios']);
	assert.ok(state.status('ios').ok);
	put('out/Lib.xcframework/Info.plist', 'hand-edited');
	assert.match(state.status('ios').reason, /^artifact does not match/);
	rmSync(join(root, 'out/Lib.xcframework'), { recursive: true });
	assert.equal(state.status('ios').reason, 'artifact is missing');
});

test('write refuses a missing artifact and rejects unknown targets', () => {
	const { root, state } = fixture('errors');
	rmSync(join(root, 'out/widgets.aar'));
	assert.throws(() => state.write(['android']), /artifact missing/);
	assert.throws(() => state.targets(['web']), /unknown target "web"/);
});

test('the file is tab-indented with a trailing newline and stable across rewrites', () => {
	const { root, state } = fixture('stable');
	state.write();
	const first = readFileSync(join(root, 'state.json'), 'utf8');
	assert.ok(first.startsWith('{\n\t"version": 1,') && first.endsWith('}\n'));
	state.write(['android']);
	assert.equal(readFileSync(join(root, 'state.json'), 'utf8'), first);
});
