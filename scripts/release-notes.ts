// Prints the CHANGELOG.md section for a version (default: package.json's). Fails if there is
// none, so a release can't go out without its changelog entry.
import { readFileSync } from 'node:fs';

const version = process.argv[2]?.replace(/^v/, '') ?? (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n');
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start === -1) {
	console.error(`CHANGELOG.md has no section for ${version}; run \`npm run changelog\` (or release with \`npm version\`)`);
	process.exit(1);
}
const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
const body = lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
if (!body) {
	console.error(`CHANGELOG.md section for ${version} is empty`);
	process.exit(1);
}
console.log(body);
