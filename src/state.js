/** The plugin's own files: a log of every decision a scan made, and when DSH last stopped. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `DSH_RESTART_RESUME_STATE_DIR`, else `$XDG_STATE_HOME/dsh-restart-resume`, else `~/.local/state/dsh-restart-resume`. */
export function stateDir(env = process.env) {
	if (env.DSH_RESTART_RESUME_STATE_DIR) return env.DSH_RESTART_RESUME_STATE_DIR;
	return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'dsh-restart-resume');
}

/** A logger appending timestamped lines to `resume.log` in `dir`; it never throws. */
export function decisionLog(dir) {
	const file = join(dir, 'resume.log');
	return async (line) => {
		try {
			await mkdir(dir, { recursive: true });
			await appendFile(file, `${new Date().toISOString()} ${line}\n`);
		} catch {
			// a full or read-only disk must not stop a resume
		}
	};
}

/**
 * Note the moment this DSH process stops (the row's scope is disposed), and when it started, so
 * the next process knows which jobs were this one's. Synchronous, since a stopping process does
 * not wait for promises. A hard death writes nothing, and needs nothing: its turns end
 * `interrupted`, which needs no stop time to be told apart.
 */
export function recordStop(dir, now, started) {
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(`${dir}/stopped.json`, JSON.stringify(started === undefined ? { at: now } : { at: now, started }));
	} catch {
		// without it, a subagent of an idle parent cut by the stop is left alone
	}
}

/** When the previous DSH process stopped and started, each undefined when it never recorded one. */
export function previousRun(dir) {
	try {
		const { at, started } = JSON.parse(readFileSync(`${dir}/stopped.json`, 'utf8'));
		return { stop: typeof at === 'number' ? at : undefined, start: typeof started === 'number' ? started : undefined };
	} catch {
		return { stop: undefined, start: undefined };
	}
}
