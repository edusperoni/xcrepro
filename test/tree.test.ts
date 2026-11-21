import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { diffTrees, hashTree } from '../src/hash.ts';
import { normalizeXcframework } from '../src/normalize.ts';
import { scanTree } from '../src/scan.ts';

const tmp = mkdtempSync(join(tmpdir(), 'xcrepro-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function tree(name: string, files: Record<string, string>): string {
	const root = join(tmp, name);
	for (const [rel, content] of Object.entries(files)) {
		mkdirSync(join(root, rel, '..'), { recursive: true });
		writeFileSync(join(root, rel), content);
	}
	return root;
}

test('hash ignores timestamps and .DS_Store but not content or symlink targets', () => {
	const a = tree('ha', { 'x/y.txt': 'hello', '.DS_Store': 'junk' });
	const b = tree('hb', { 'x/y.txt': 'hello' });
	utimesSync(join(a, 'x/y.txt'), 1, 1);
	assert.equal(hashTree(a).hash, hashTree(b).hash);
	symlinkSync('y.txt', join(a, 'x/link'));
	symlinkSync('other', join(b, 'x/link'));
	assert.deepEqual(diffTrees(hashTree(a), hashTree(b)), ['differs: x/link']);
});

test('scan finds machine paths anywhere in the bytes, including Swift #filePath', () => {
	const root = '/Users/someone/work/plugin';
	const binary = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]), Buffer.from(`${root}/Sources/A.swift\0`), Buffer.from([0, 1, 2])]);
	const dir = tree('scan', { 'ok.txt': 'Sample/SampleSwift.swift', 'canonical.txt': '/Applications/Xcode.app/Contents/Developer/x.h' });
	writeFileSync(join(dir, 'bin'), binary);
	writeFileSync(join(dir, 'ci.txt'), '/Applications/Xcode_26.1.app/Contents/Developer/x.h');
	const leaks = scanTree(dir, { roots: [root] });
	assert.deepEqual([...new Set(leaks.map((l) => l.file))].sort(), ['bin', 'ci.txt']);
	assert.ok(leaks.some((l) => l.file === 'bin' && l.reason === 'source root' && l.context === `${root}/Sources/A.swift`));
	assert.ok(leaks.some((l) => l.file === 'ci.txt' && l.reason === 'Xcode install path'));
	assert.deepEqual(scanTree(dir, { roots: [root], allow: ['/Sources/A.swift', 'Xcode_26.1'] }), []);
});

const PLIST = (ids: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AvailableLibraries</key>
	<array>${ids
		.map(
			(id) => `
		<dict>
			<key>LibraryIdentifier</key>
			<string>${id}</string>
			<key>SupportedArchitectures</key>
			<array>
				<string>x86_64</string>
				<string>arm64</string>
			</array>
		</dict>`,
		)
		.join('')}
	</array>
	<key>CFBundlePackageType</key>
	<string>XFWK</string>
	<key>XCFrameworkFormatVersion</key>
	<string>1.0</string>
</dict>
</plist>
`;

test('normalize sorts the plist, drops Project/ sourceinfo and relativizes relocation maps', () => {
	const yml = `---\ntriple: 'arm64-apple-darwin'\nbinary-path: '/Users/me/p/build/DerivedData/Build/Products/Release-iphoneos/A.framework/A'\nrelocations: []\n`;
	const x = tree('A.xcframework', {
		'Info.plist': PLIST(['ios-arm64_x86_64-simulator', 'ios-arm64']),
		'ios-arm64/A.framework/Modules/A.swiftmodule/Project/arm64-apple-ios.swiftsourceinfo': '/Users/me/p/A.swift',
		'ios-arm64/A.framework/Modules/A.swiftmodule/arm64-apple-ios.swiftinterface': '// swift-interface',
		'ios-arm64/dSYMs/A.framework.dSYM/Contents/Resources/Relocations/aarch64/A.yml': yml,
	});
	const report = normalizeXcframework(x);
	assert.deepEqual(report.removed, ['ios-arm64/A.framework/Modules/A.swiftmodule/Project']);
	assert.match(readFileSync(join(x, 'ios-arm64/dSYMs/A.framework.dSYM/Contents/Resources/Relocations/aarch64/A.yml'), 'utf8'), /^binary-path: 'ios-arm64\/A.framework\/A'$/m);
	const plist = readFileSync(join(x, 'Info.plist'), 'utf8');
	assert.ok(plist.indexOf('ios-arm64<') < plist.indexOf('ios-arm64_x86_64-simulator<'));
	assert.ok(plist.indexOf('<string>arm64</string>') < plist.indexOf('<string>x86_64</string>'));
	assert.ok(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist') && plist.endsWith('</dict>\n</plist>\n'));
	const first = hashTree(x).hash;
	normalizeXcframework(x);
	assert.equal(hashTree(x).hash, first, 'idempotent');
});
