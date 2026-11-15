/**
 * The boot scan: find the sessions whose last turn DSH's own shutdown cut off, and continue them.
 *
 * Roots get a follow-up message in their own session (and an active goal is armed again, since DSH
 * disarms goals when it loads a session). Subagents cannot be resumed that way (DSH answers
 * "owned by subagent routing"), so each one gets its message from its parent through
 * `subagents.sendMessage`, which cold-resumes it on its own model and preset; the child reports
 * to the parent when it finishes, as it would have. Children go first, and a parent that is
 * resumed too, or is mid-turn already, is told which of its children were continued so it does not
 * hand them the work again.
 */
import { assess, NOTICE_KIND, parentShutDown } from './detect.js';

export const ROOT_TEXT = '[Restart Resume] DSH restarted while this turn was running, and the turn was cut off. '
	+ 'Continue the task from where it stopped. A tool call that was cut off may or may not have taken effect: '
	+ 'check its effects before running it again.';

export const CHILD_TEXT = '[Restart Resume] DSH restarted while you were working, and your turn was cut off. '
	+ 'Continue your task from where it stopped and report to your parent as before. A tool call that was cut off '
	+ 'may or may not have taken effect: check its effects before running it again.';

/** The line a parent gets about the children continued through it. */
export function childrenText(ids) {
	const one = ids.length === 1;
	return `[Restart Resume] DSH also continued ${one ? 'this subagent' : 'these subagents'} of yours where `
		+ `${one ? 'it' : 'they'} stopped: ${ids.join(', ')}. ${one ? 'Its result comes' : 'Their results come'} back `
		+ 'to you as a message when finished; do not send the task again.';
}

/**
 * Run one scan.
 * @param {object} deps - DSH's services, narrowed (see index.js), plus `now`, `log` and the config.
 * @returns {Promise<{ roots: string[], children: string[] }>} the sessions continued.
 */
export async function scan(deps) {
	const { config, log } = deps;
	const now = deps.now();
	const maxAgeMs = config.maxAgeMinutes * 60_000;
	// Not filtered on `blank`: DSH reports a cold subagent whose turn never finished as blank.
	const listed = await deps.listSessions();
	const summaries = listed.filter((s) => !s.running && now - (s.updatedAt ?? 0) <= maxAgeMs + 5 * 60_000);
	const stop = deps.previousStop === undefined ? 'unknown' : new Date(deps.previousStop).toISOString();
	await log(`scan: ${summaries.length} of ${listed.length} sessions changed recently; previous DSH stop ${stop}`);
	const archived = deps.archived();
	const plan = [];
	for (const summary of summaries) {
		const id = summary.sessionId;
		if (summary.parentSessionId === undefined && archived.has(id)) continue;
		let snapshot;
		try {
			snapshot = await deps.readSession(id);
		} catch (error) {
			await log(`skip ${id}: log unreadable: ${String(error)}`);
			continue;
		}
		const verdict = assess({
			header: snapshot.session,
			events: snapshot.events,
			now,
			maxAgeMs,
			skipProviders: config.skipProviders,
			maxResumes: config.maxResumes,
		});
		if (!verdict.resume) {
			if (verdict.why !== 'no cut turn at the tail' && !verdict.why.startsWith('last turn ended completed'))
				await log(`skip ${id}: ${verdict.why}`);
			continue;
		}
		if (verdict.child && verdict.cut.kind === 'parent') {
			let parent;
			try {
				parent = await deps.readSession(verdict.parentId);
			} catch (error) {
				await log(`skip ${id}: parent ${verdict.parentId} unreadable: ${String(error)}`);
				continue;
			}
			if (!parentShutDown(parent.events, verdict.cut.time, deps.previousStop)) {
				await log(`skip ${id}: its parent was stopped, not shut down`);
				continue;
			}
		}
		plan.push({ id, ...verdict });
	}

	const continuedByParent = new Map();
	const children = [];
	for (const item of plan.filter((p) => p.child)) {
		if (await resumeChild(deps, item)) {
			children.push(item.id);
			continuedByParent.set(item.parentId, [...(continuedByParent.get(item.parentId) ?? []), item.id]);
		}
	}
	const roots = [];
	for (const item of plan.filter((p) => !p.child)) {
		const told = continuedByParent.get(item.id);
		if (await resumeRoot(deps, item, told)) {
			roots.push(item.id);
			continuedByParent.delete(item.id);
		}
	}
	for (const [parentId, ids] of continuedByParent) await tellParent(deps, parentId, ids);
	return { roots, children };
}

/** The live Agent of a session, loading it when DSH has not. Throws when DSH refuses it. */
async function agentOf(deps, id) {
	const live = deps.liveAgent(id);
	if (live !== undefined) return live;
	return deps.resolveAgent(id);
}

function notice(deps, texts) {
	return deps.createUserMessage({
		content: texts.map((text) => ({ type: 'text', text })),
		source: { kind: NOTICE_KIND, form: 'notice', summary: texts[0] },
	});
}

async function resumeRoot(deps, item, children) {
	const { log } = deps;
	try {
		const agent = await agentOf(deps, item.id);
		const message = notice(deps, children ? [ROOT_TEXT, childrenText(children)] : [ROOT_TEXT]);
		// A turn may have started meanwhile: a child continued a moment ago that already reported
		// back. That turn still needs to know its own task was cut, so the notice joins it.
		const running = agent.status === 'running';
		if (running) agent.steer(message);
		else agent.followup(message);
		if (deps.flush && !(await deps.flush(agent.session))) throw new Error('the session log did not take the notice');
		await log(`resumed ${item.id}${running ? ' (into its running turn)' : ''} (turn ${item.cut.turn} ended ${item.cut.kind})${children ? `, told of ${children.join(', ')}` : ''}`);
		rearmGoal(deps, agent, item.id);
		return true;
	} catch (error) {
		await log(`resume ${item.id} failed: ${String(error)}`);
		return false;
	}
}

async function resumeChild(deps, item) {
	const { log } = deps;
	if (deps.subagents === undefined) {
		await log(`skip ${item.id}: no subagent service to reach it through`);
		return false;
	}
	try {
		const parent = await agentOf(deps, item.parentId);
		await deps.subagents.sendMessage(parent, item.id, [{ type: 'text', text: CHILD_TEXT }], { signal: AbortSignal.timeout(30_000) });
		await log(`resumed ${item.id} through parent ${item.parentId} (turn ${item.cut.turn} ended ${item.cut.kind})`);
		return true;
	} catch (error) {
		await log(`resume ${item.id} through parent ${item.parentId} failed: ${String(error)}`);
		return false;
	}
}

/** A parent not resumed here: a running one (another plugin resumed it) is told at once; an idle
 *  one needs nothing, since its children's reports wake it with the facts. */
async function tellParent(deps, parentId, ids) {
	const agent = deps.liveAgent(parentId);
	if (agent?.status !== 'running') return;
	try {
		agent.steer(notice(deps, [childrenText(ids)]));
		await deps.log(`told running parent ${parentId} of ${ids.join(', ')}`);
	} catch (error) {
		await deps.log(`telling parent ${parentId} failed: ${String(error)}`);
	}
}

/**
 * Arm a resumed session's active goal again: activation is per process, so the restart disarmed
 * it, and `goals.resume` is DSH's path for that session-start edge. Paused, blocked, finished or
 * spent goals are left as they are.
 */
function rearmGoal(deps, agent, id) {
	const goals = deps.goals;
	if (goals === undefined || !deps.config.resumeGoals) return;
	try {
		const goal = goals.get(agent);
		if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'disarmed') return;
		if (goal.roundsStarted >= goal.maxGoalRounds) return;
		goals.resume(agent, { id: goal.id, revision: goal.revision });
		void deps.log(`re-armed goal ${goal.id} of ${id}`);
	} catch (error) {
		void deps.log(`goal re-arm for ${id} failed: ${String(error)}`);
	}
}
