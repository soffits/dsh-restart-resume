/**
 * @soffits/dsh-restart-resume: continue the turns a DSH restart cut off, subagents included.
 *
 * One scan per DSH process, shortly after boot. See README.md for what is resumed and what is
 * left to other plugins.
 */
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { scan } from './src/resume.js';
import { decisionLog, previousRun, recordStop, stateDir, writeScanRecord } from './src/state.js';

export const name = 'dsh-restart-resume';
export const inject = ['sessionController', 'sessionQuery', 'agents', 'sessions'];

export const Config = z.object({
	enabled: z.boolean().default(true).description('Scan for cut-off turns after DSH starts.'),
	delaySeconds: z.natural().max(600).default(10)
		.description('Seconds after start before the scan, so DSH has loaded its sessions and agents.'),
	maxAgeMinutes: z.natural().min(1).max(1440).default(120).description('A turn cut longer ago than this is left alone.'),
	maxResumes: z.natural().min(1).max(10).default(3)
		.description('A session cut off again this many times in a row right after a resume is left alone.'),
	resumeGoals: z.boolean().default(true).description('Arm the active goal of a resumed session again.'),
	resumeAfterReload: z.boolean().default(true)
		.description('Also scan when a profile reload disposed this plugin in a running DSH (the subagent runtime is reloaded with it), and continue the turns that reload cut.'),
	jobMaxAgeHours: z.natural().min(1).max(168).default(24)
		.description('A session that started a background job the restart killed is looked at when it wrote within this many hours.'),
});

/** Set once a scan has started in this process: a config edit applies the row again, and a scan
 *  then would find nothing new to do but cost a read of every recent log. */
const SCANNED = Symbol.for('dsh-restart-resume.scanned');
/** When this plugin was last disposed in this process and no scan has looked at what that cut yet. */
const UNSCANNED_SINCE = Symbol.for('dsh-restart-resume.unscanned-since');
/** A reload cuts turns a moment before or after this plugin is disposed along with the services it uses. */
const RELOAD_SLACK_MS = 30_000;
/** When the previous DSH process started and stopped, read once per process: a config edit
 *  disposes the row, which records a stop of its own. */
const PREVIOUS_STOP = Symbol.for('dsh-restart-resume.previous-stop');
/** Applied later than this after DSH started, the plugin was installed or enabled into a running
 *  DSH: there is no restart to recover from. */
const BOOT_WINDOW_S = 300;
/** Handlers of the plugins that continue the cut turns they started themselves, by the principal
 *  kind they put on their prompts. Kept on globalThis: a config edit applies the row again while
 *  claimers keep the registration they made. */
const CLAIMS = Symbol.for('dsh-restart-resume.claims');

export function apply(ctx, config) {
	if (!config.enabled) return;
	const claims = (globalThis[CLAIMS] ??= new Map());
	// `restartResume.claim(kind, handler)`: a plugin that starts turns under a principal of `kind`
	// (a scheduler) continues those itself when a restart cut them; the scan hands each such turn to
	// `handler({ sessionId, principal, cut, jobs })`, which answers `{ continued, why? }`. The return
	// value drops the claim; claim from a scope that ends with the claimer.
	ctx.provide?.('restartResume', {
		claim(kind, handler) {
			claims.set(kind, handler);
			return () => {
				if (claims.get(kind) === handler) claims.delete(kind);
			};
		},
	});
	const dir = stateDir();
	if (!(PREVIOUS_STOP in globalThis)) globalThis[PREVIOUS_STOP] = previousRun(dir);
	const bootTime = Date.now() - process.uptime() * 1000;
	// Every process records when it started and stopped, scan or not: the next one reads it.
	ctx.effect(() => () => {
		const now = Date.now();
		recordStop(dir, now, bootTime);
		globalThis[UNSCANNED_SINCE] ??= now;
	});
	const log = decisionLog(dir);
	// The deps one scan reads DSH through; `extra` says which scan it is.
	const scanDeps = (extra) => ({
		config,
		log,
		now: Date.now,
		listSessions: async () => (await ctx.sessionController.list({}, AbortSignal.timeout(120_000))).items,
		readSession: (id) => ctx.sessionQuery.readSession(id),
		archived: () => new Set(ctx.get('workspaceRegistry')?.archivedSessionIds ?? []),
		liveAgent: (id) => ctx.agents.get(id),
		resolveAgent: async (id) => {
			const found = await ctx.sessionController.resolveAgent(id);
			if ('error' in found) throw found.error;
			return found.agent;
		},
		subagents: ctx.get('subagents'),
		goals: ctx.get('goals'),
		createUserMessage,
		flush: (session) => ctx.sessions.flush(session),
		claims,
		...extra,
	});
	if (globalThis[SCANNED]) {
		// Applied again in a running process: a profile reload disposed this plugin, and the subagent
		// runtime with it, which drains every running subagent and ends the turns of the sessions it
		// owned. Nothing restarted, so the boot scan does not run; this one continues what the reload cut.
		const since = globalThis[UNSCANNED_SINCE];
		if (!config.resumeAfterReload || since === undefined) return;
		ctx.effect(() => {
			const timer = setTimeout(() => {
				globalThis[UNSCANNED_SINCE] = undefined;
				void log(`reload scan: the profile was reloaded at ${new Date(since).toISOString()}`);
				scan(scanDeps({
					cause: 'reload',
					cutNotBefore: since - RELOAD_SLACK_MS,
					previousStop: since,
					bootTime: 0, // no process started: the background jobs of other sessions are still running
				})).then((result) => log(`reload scan done: ${result.roots.length} root(s), ${result.children.length} subagent(s) continued, ${result.claimed.length} handed to their owner`))
					.catch((error) => log(`reload scan failed: ${String(error)}`));
			}, config.delaySeconds * 1000);
			return () => clearTimeout(timer);
		});
		return;
	}
	if (process.uptime() > BOOT_WINDOW_S) {
		void log('not at boot: no scan in this process');
		globalThis[SCANNED] = true;
		return;
	}
	const run = async () => {
		if (globalThis[SCANNED]) return;
		globalThis[SCANNED] = true;
		const startedAt = Date.now();
		const result = await scan(scanDeps({
			previousStop: globalThis[PREVIOUS_STOP].stop,
			previousStart: globalThis[PREVIOUS_STOP].start,
			bootTime,
		}));
		const iso = (ms) => new Date(ms).toISOString();
		writeScanRecord(dir, { boot: iso(bootTime), startedAt: iso(startedAt), doneAt: iso(Date.now()), ...result });
		await log(`scan done: ${result.roots.length} root(s), ${result.children.length} subagent(s) continued, ${result.claimed.length} handed to their owner`);
	};
	ctx.effect(() => {
		const timer = setTimeout(() => {
			run().catch((error) => log(`scan failed: ${String(error)}`));
		}, config.delaySeconds * 1000);
		return () => clearTimeout(timer);
	});
}
