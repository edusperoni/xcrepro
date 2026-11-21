// Compiles standalone executables (no Node required) with Bun into dist-bin/.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const targets = [
	['bun-darwin-arm64', 'xcrepro-darwin-arm64'],
	['bun-darwin-x64', 'xcrepro-darwin-x64'],
] as const;

rmSync('dist-bin', { recursive: true, force: true });
mkdirSync('dist-bin');
const sums: string[] = [];
for (const [target, out] of targets) {
	execFileSync('bun', ['build', 'src/cli.ts', '--compile', '--minify', `--target=${target}`, `--outfile=dist-bin/${out}`], { stdio: 'inherit' });
	sums.push(`${createHash('sha256').update(readFileSync(`dist-bin/${out}`)).digest('hex')}  ${out}`);
}
writeFileSync('dist-bin/SHA256SUMS', `${sums.join('\n')}\n`);
console.log(sums.join('\n'));
