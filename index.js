/**
 * @soffits/dsh-restart-resume: continue the turns a DSH restart cut off, subagents included.
 *
 * One scan per DSH process, shortly after boot. See README.md for what is resumed and what is
 * left to other plugins.
 */
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { scan } from './src/resume.js';
import { decisionLog, previousRun, recordStop, stateDir } from './src/state.js';

export const name = 'dsh-restart-resume';
export const inject = ['sessionController', 'sessionQuery', 'agents', 'sessions'];

export const Config = z.object({
	enabled: z.boolean().default(true).description('Scan for cut-off turns after DSH starts.'),
	delaySeconds: z.natural().max(600).default(60)
		.description('Seconds after start before the scan, so other plugins resume their own sessions first.'),
	maxAgeMinutes: z.natural().min(1).max(1440).default(120).description('A turn cut longer ago than this is left alone.'),
	maxResumes: z.natural().min(1).max(10).default(3)
		.description('A session cut off again this many times in a row right after a resume is left alone.'),
	skipProviders: z.array(z.string()).default(['claude-code'])
		.description('Providers whose sessions another plugin resumes (dsh-oh-my-claude resumes claude-code).'),
	resumeGoals: z.boolean().default(true).description('Arm the active goal of a resumed session again.'),
	jobMaxAgeHours: z.natural().min(1).max(168).default(24)
		.description('A session that started a background job the restart killed is looked at when it wrote within this many hours.'),
});

/** Set once a scan has started in this process: a config edit applies the row again, and a scan
 *  then would find nothing new to do but cost a read of every recent log. */
const SCANNED = Symbol.for('dsh-restart-resume.scanned');
/** When the previous DSH process started and stopped, read once per process: a config edit
 *  disposes the row, which records a stop of its own. */
const PREVIOUS_STOP = Symbol.for('dsh-restart-resume.previous-stop');
/** Applied later than this after DSH started, the plugin was installed or enabled into a running
 *  DSH: there is no restart to recover from. */
const BOOT_WINDOW_S = 300;

export function apply(ctx, config) {
	if (!config.enabled) return;
	const dir = stateDir();
	if (!(PREVIOUS_STOP in globalThis)) globalThis[PREVIOUS_STOP] = previousRun(dir);
	const bootTime = Date.now() - process.uptime() * 1000;
	// Every process records when it started and stopped, scan or not: the next one reads it.
	ctx.effect(() => () => recordStop(dir, Date.now(), bootTime));
	if (globalThis[SCANNED]) return;
	const log = decisionLog(dir);
	if (process.uptime() > BOOT_WINDOW_S) {
		void log('not at boot: no scan in this process');
		globalThis[SCANNED] = true;
		return;
	}
	const run = async () => {
		if (globalThis[SCANNED]) return;
		globalThis[SCANNED] = true;
		const result = await scan({
			config,
			log,
			now: Date.now,
			previousStop: globalThis[PREVIOUS_STOP].stop,
			previousStart: globalThis[PREVIOUS_STOP].start,
			bootTime,
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
		});
		await log(`scan done: ${result.roots.length} root(s), ${result.children.length} subagent(s) continued`);
	};
	ctx.effect(() => {
		const timer = setTimeout(() => {
			run().catch((error) => log(`scan failed: ${String(error)}`));
		}, config.delaySeconds * 1000);
		return () => clearTimeout(timer);
	});
}
