import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CANONICAL_DEVELOPER_DIR, buildSettings, pathSpellings, quoteListToken } from '../src/settings.ts';

const base = { strip: true, conciseMagicFile: true, libraryEvolution: true };
const setting = (list: string[], key: string) => list.find((s) => s.startsWith(`${key}=`))?.slice(key.length + 1);

test('a root under /private is also mapped without the prefix, as Xcode spells it', () => {
	assert.deepEqual(pathSpellings('/private/tmp/does-not-exist/'), ['/private/tmp/does-not-exist', '/tmp/does-not-exist']);
	assert.deepEqual(pathSpellings('/tmp/does-not-exist'), ['/private/tmp/does-not-exist', '/tmp/does-not-exist']);
	assert.deepEqual(pathSpellings('/Users/me/src'), ['/Users/me/src']);
});

test('remaps every root spelling and a non-default Xcode, for both clang and swift', () => {
	const s = buildSettings({ ...base, root: '/private/tmp/r', developerDir: '/Applications/Xcode_26.1.app/Contents/Developer' });
	const cflags = setting(s, 'OTHER_CFLAGS')!;
	assert.ok(cflags.startsWith('$(inherited) '));
	assert.ok(cflags.includes('-ffile-prefix-map=/private/tmp/r=.'));
	assert.ok(cflags.includes('-ffile-prefix-map=/tmp/r=.'));
	assert.ok(cflags.includes(`-ffile-prefix-map=/Applications/Xcode_26.1.app/Contents/Developer=${CANONICAL_DEVELOPER_DIR}`));
	const swift = setting(s, 'OTHER_SWIFT_FLAGS')!;
	assert.ok(swift.includes('-file-prefix-map /tmp/r=.'));
	assert.ok(swift.includes('-Xfrontend -no-clang-module-breadcrumbs'));
});

test('the canonical Xcode location is not remapped onto itself', () => {
	const s = buildSettings({ ...base, root: '/r', developerDir: CANONICAL_DEVELOPER_DIR });
	assert.ok(!setting(s, 'OTHER_CFLAGS')!.includes('Xcode.app'));
});

test('quotes paths with spaces so xcodebuild keeps them as one flag', () => {
	assert.equal(quoteListToken('-ffile-prefix-map=/My Projects/x=.'), '"-ffile-prefix-map=/My Projects/x=."');
	assert.equal(quoteListToken('-ffile-prefix-map=/plain=.'), '-ffile-prefix-map=/plain=.');
	const s = buildSettings({ ...base, root: '/My Projects/x' });
	assert.ok(setting(s, 'OTHER_SWIFT_FLAGS')!.includes('-file-prefix-map "/My Projects/x=."'));
});

test('options toggle their settings', () => {
	const off = buildSettings({ root: '/r', strip: false, conciseMagicFile: false, libraryEvolution: false });
	assert.equal(setting(off, 'DEPLOYMENT_POSTPROCESSING'), undefined);
	assert.equal(setting(off, 'SWIFT_UPCOMING_FEATURE_CONCISE_MAGIC_FILE'), undefined);
	assert.equal(setting(off, 'BUILD_LIBRARY_FOR_DISTRIBUTION'), undefined);
	const on = buildSettings({ ...base, root: '/r' });
	assert.equal(setting(on, 'STRIP_STYLE'), 'debugging');
	assert.equal(setting(on, 'BUILD_LIBRARY_FOR_DISTRIBUTION'), 'YES');
});
