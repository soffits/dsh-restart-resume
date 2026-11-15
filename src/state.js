/** The plugin's own file: a log of every decision a scan made. */
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
