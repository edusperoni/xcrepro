import { execFileSync, spawnSync } from 'node:child_process';

export class XcreproError extends Error {}

export function capture(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
	try {
		return execFileSync(cmd, args, { cwd: opts.cwd, env: opts.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim();
	} catch (e) {
		const err = e as { stderr?: string; message: string };
		throw new XcreproError(`${cmd} ${args.join(' ')} failed: ${err.stderr?.trim() || err.message}`);
	}
}

export function tryCapture(cmd: string, args: string[], opts: { cwd?: string } = {}): string | undefined {
	try {
		return capture(cmd, args, opts);
	} catch {
		return undefined;
	}
}

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
	const res = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: 'inherit' });
	if (res.error) throw new XcreproError(`${cmd}: ${res.error.message}`);
	if (res.status !== 0) throw new XcreproError(`${cmd} exited with code ${res.status ?? res.signal}`);
}
