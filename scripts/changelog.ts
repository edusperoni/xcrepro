// Regenerates CHANGELOG.md from the git history, labelling unreleased commits as the
// package.json version (run from the `version` lifecycle, before the tag exists).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
execFileSync('npx', ['--no-install', 'git-cliff', '--tag', `v${version}`, '--output', 'CHANGELOG.md'], { stdio: 'inherit' });
