/**
 * Reading a session log to decide whether its last turn was cut off by DSH going away.
 *
 * The tail walk (`lastCut`) follows dsh-neverdie by pinion05 (MIT): see LICENSE.
 *
 * A graceful stop (a supervisor restart) closes the running turn as `aborted` with cause
 * `disposed`; a hard death leaves the turn open and DSH closes it as `interrupted` when the log is
 * next read. A subagent cut while its parent was mid-turn ends `aborted` with cause `parent`, the
 * same cause a user stop of the parent gives it, so a child with that cause counts only when its
 * parent's own turn was cut by the same shutdown.
 */

/** Source kind of the notices this plugin sends, so a later scan can count them. */
export const NOTICE_KIND = 'restart-resume';

/** The one event after a cut that means the session has moved on: a new turn. Everything else
 *  written after it is the shutdown's own bookkeeping or input still waiting: job/settled,
 *  session/end-seed, and inbox splices such as the "subagent was stopped" notice DSH queues for a
 *  parent while it stops its children. Waiting input does not run by itself; it rides along with
 *  the resumed turn. */
const ACTIVITY = new Set(['turn/start']);

/** How the turn ended, as one word: `interrupted`, `disposed`, `parent`, `user`, `hook`, `completed`, `error`... */
export function endKind(event) {
	const reason = event?.data?.reason;
	if (reason?.kind === 'aborted') return reason.reason?.kind ?? 'aborted';
	return reason?.kind;
}

/**
 * The `turn/end` that closes the log's last turn, with how it ended, when nothing has happened in
 * the session since; undefined when a newer turn exists or the log has no turn.
 * @param {readonly object[]} events - the session's raw events, oldest first.
 * @returns {{ seq: number, time: number, turn: number, kind: string, index: number, waiting: string[] } | undefined}
 *   `waiting` holds the source kinds of the inbox input queued since.
 */
export function lastCut(events) {
	const waiting = [];
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const event = events[i];
		if (ACTIVITY.has(event.type)) return undefined;
		if (event.type === 'agent/inbox/spliced')
			for (const m of event.data?.inserted ?? []) if (m?.source?.kind) waiting.push(m.source.kind);
		if (event.type === 'turn/end')
			return { seq: event.seq, time: event.time ?? 0, turn: event.data?.turn, kind: endKind(event), index: i, waiting };
	}
	return undefined;
}

/** Whether a cut of this kind is DSH going away rather than someone stopping the turn. */
export const shutdownCut = (kind) => kind === 'interrupted' || kind === 'disposed';

/** The index of the `turn/start` that opened the turn ending at `endIndex`. */
function turnStartBefore(events, endIndex) {
	for (let i = endIndex - 1; i >= 0; i -= 1) if (events[i].type === 'turn/start') return i;
	return -1;
}

/** Source kinds of the user messages DSH adds as context to a turn; none of them is what started it. */
const CONTEXT_KINDS = new Set(['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context', 'compact-checkpoint']);

/** The source kinds of the messages that started or fed the turn ending at `endIndex`. */
export function turnSources(events, endIndex) {
	const start = turnStartBefore(events, endIndex);
	const kinds = [];
	for (let i = start + 1; i < endIndex; i += 1) {
		const event = events[i];
		if (event.type !== 'user/message') continue;
		const kind = event.data?.source?.kind;
		if (kind !== undefined && !CONTEXT_KINDS.has(kind)) kinds.push(kind);
	}
	return kinds;
}

/**
 * How many turns in a row, counting back from the last one, were opened by this plugin's notice
 * and cut again. A session that keeps taking DSH down with it stops being resumed at the cap.
 */
export function resumeStreak(events) {
	let streak = 0;
	let end = events.length;
	for (;;) {
		let endIndex = -1;
		for (let i = end - 1; i >= 0; i -= 1)
			if (events[i].type === 'turn/end') {
				endIndex = i;
				break;
			}
		if (endIndex < 0) return streak;
		if (!shutdownCut(endKind(events[endIndex]))) return streak;
		if (!turnSources(events, endIndex).includes(NOTICE_KIND)) return streak;
		streak += 1;
		end = turnStartBefore(events, endIndex);
		if (end < 0) return streak;
	}
}

/** How close a job settled by DSH's own teardown must be to the recorded stop to count as killed by it. */
export const JOB_STOP_WINDOW_MS = 120_000;

/**
 * The background jobs the previous DSH process killed: registered before this process started and
 * never settled (DSH keeps its job registry in the process, so a stop leaves them open in the
 * log), or settled by DSH's teardown at the recorded stop. A job that ran out on its own, or that
 * someone killed, settled with its own status before the stop and is not one.
 * @param {readonly object[]} events - the session's raw events, oldest first.
 * Only jobs of the previous process count (registered after it started, when that is known), and
 * none a notice of this plugin already named: an older process's lost job was dealt with then.
 * @param {number} bootTime - epoch ms this DSH process started.
 * @param {number | undefined} previousStop - epoch ms the previous process stopped, if known.
 * @param {number | undefined} [previousStart] - epoch ms the previous process started, if known.
 * @returns {{ id: string, label: string }[]}
 */
export function lostJobs(events, bootTime, previousStop, previousStart) {
	const open = new Map();
	const killed = [];
	for (const event of events) {
		const data = event.data ?? {};
		if (event.type === 'user/message' && data.source?.kind === NOTICE_KIND) {
			const text = (data.content ?? []).map((part) => part?.text ?? '').join(' ');
			for (const id of [...open.keys()]) if (text.includes(id)) open.delete(id);
			continue;
		}
		if (event.type === 'job/registered' && data.jobId) open.set(data.jobId, data);
		else if (event.type === 'job/settled' && open.has(data.jobId)) {
			const job = open.get(data.jobId);
			open.delete(data.jobId);
			const atStop = previousStop !== undefined && Math.abs((data.finishedAt ?? event.time ?? 0) - previousStop) <= JOB_STOP_WINDOW_MS;
			if (data.cause === 'teardown' && atStop) killed.push(job);
		}
	}
	// A foreground tool call registers a job too; one cut with its turn belongs to that cut, and the
	// cut-turn notice covers it. A job older than an earlier cut died with that earlier stop.
	const cuts = cutTurns(events);
	const tail = lastCut(events);
	const tailCut = tail !== undefined && cuts.length > 0 && cuts[cuts.length - 1].end === tail.time ? cuts[cuts.length - 1] : undefined;
	const olderCut = Math.max(0, ...cuts.filter((c) => c !== tailCut).map((c) => c.end));
	const ofPreviousProcess = (job) => {
		const at = job.startedAt ?? 0;
		if (at >= bootTime || at < olderCut) return false;
		if (tailCut !== undefined && at >= tailCut.start && at <= tailCut.end) return false;
		return previousStart === undefined || at >= previousStart;
	};
	return [...killed, ...[...open.values()].filter(ofPreviousProcess)]
		.map((job) => ({ id: job.jobId, label: String(job.label ?? '').split(/\s+/).join(' ').trim().slice(0, 160) }));
}

/** Every turn a shutdown cut, as { start, end } in epoch ms, oldest first. */
function cutTurns(events) {
	const out = [];
	let start = 0;
	for (const event of events) {
		if (event.type === 'turn/start') start = event.time ?? 0;
		else if (event.type === 'turn/end' && (shutdownCut(endKind(event)) || endKind(event) === 'parent'))
			out.push({ start, end: event.time ?? 0 });
	}
	return out;
}

/** When the session's newest turn started (epoch ms), or 0. */
function lastTurnStart(events) {
	for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].type === 'turn/start') return events[i].time ?? 0;
	return 0;
}

/** Whether this plugin's notice already waits in the session's inbox after its last turn. */
function noticeWaiting(events) {
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const event = events[i];
		if (event.type === 'turn/start' || event.type === 'turn/end') return false;
		if (event.type === 'agent/inbox/spliced' && (event.data?.inserted ?? []).some((m) => m?.source?.kind === NOTICE_KIND)) return true;
	}
	return false;
}

/**
 * What to do with one session, from its header and log alone.
 * @param {object} input
 * @param {{ parentSession?: string, origin?: string }} input.header
 * @param {readonly object[]} input.events
 * @param {number} input.now - epoch ms.
 * @param {number} input.maxAgeMs - a cut older than this is left alone.
 * @param {number} input.maxResumes - consecutive resumes after which a session is left alone.
 * @param {number} [input.bootTime] - epoch ms this DSH process started.
 * @param {number} [input.previousStop] - epoch ms the previous process stopped, if known.
 * @param {number} [input.previousStart] - epoch ms the previous process started, if known.
 * @returns {{ resume: false, why: string } | { resume: true, child: boolean, parentId?: string, cut?: object,
 *   jobs: { id: string, label: string }[] }} `cut` is absent when only background jobs were lost.
 */
export function assess({ header, events, now, maxAgeMs, maxResumes, bootTime = now, previousStop, previousStart }) {
	const child = header.origin === 'subagent' && Boolean(header.parentSession);
	const jobs = lostJobs(events, bootTime, previousStop, previousStart);
	const cut = lastCut(events);
	const turnCut = cut !== undefined && (shutdownCut(cut.kind) || (child && cut.kind === 'parent'));
	if (!turnCut) {
		// An idle session whose background jobs the stop killed was still waiting on them: their
		// reports would have woken it, so nothing will now. Every provider: none resumes this.
		if (jobs.length > 0 && lastTurnStart(events) < bootTime && !noticeWaiting(events))
			return child ? { resume: true, child, parentId: header.parentSession, jobs } : { resume: true, child, jobs };
		if (cut === undefined) return { resume: false, why: 'no cut turn at the tail' };
		return { resume: false, why: `last turn ended ${cut.kind}` };
	}
	if (now - cut.time > maxAgeMs) return { resume: false, why: 'cut too long ago' };
	if (cut.waiting.includes(NOTICE_KIND)) return { resume: false, why: 'a resume notice is already waiting' };
	if (turnSources(events, cut.index).includes('schedule'))
		return { resume: false, why: 'a scheduled run, which its scheduler reruns' };
	if (resumeStreak(events) >= maxResumes)
		return { resume: false, why: `already resumed ${maxResumes} times in a row` };
	return child ? { resume: true, child, parentId: header.parentSession, cut, jobs } : { resume: true, child, cut, jobs };
}

/** How close a parent's aborted turn must be to its child's `parent` cut to be its cause; DSH
 *  cuts the children within milliseconds of the parent (25 to 100 ms in real logs). */
export const SAME_CUT_MS = 5_000;
/** How close a child's `parent` cut must be to the recorded stop of the previous DSH process. */
export const STOP_WINDOW_MS = 120_000;

/**
 * Whether a child cut with cause `parent` was cut by DSH shutting down. A user stop of the parent
 * gives its children the same cause, and those stay stopped.
 * - When the parent's own turn was cut at that moment, that turn says it: `interrupted` or
 *   `disposed` is a shutdown, a user stop or a hand-over is not. A turn that ended normally cuts
 *   no children, so it is not the cause.
 * - Otherwise the parent was idle, and DSH's teardown of the parent's tree is what cut the child,
 *   so the cut must lie at the previous process's recorded stop.
 * @param {readonly object[]} parentEvents - the parent's raw events.
 * @param {number} childCutTime - epoch ms of the child's `turn/end`.
 * @param {number | undefined} previousStop - epoch ms the previous DSH process stopped, if known.
 */
export function parentShutDown(parentEvents, childCutTime, previousStop) {
	let nearest;
	for (const event of parentEvents) {
		if (event.type !== 'turn/end') continue;
		const reason = event.data?.reason?.kind;
		if (reason !== 'aborted' && reason !== 'interrupted') continue;
		const gap = Math.abs((event.time ?? 0) - childCutTime);
		if (gap <= SAME_CUT_MS && (nearest === undefined || gap < nearest.gap)) nearest = { gap, event };
	}
	if (nearest !== undefined) return shutdownCut(endKind(nearest.event));
	return previousStop !== undefined && Math.abs(previousStop - childCutTime) <= STOP_WINDOW_MS;
}
