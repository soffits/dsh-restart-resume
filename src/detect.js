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

/** The provider the session's last model request went to, or undefined before any request. */
export function lastProvider(events) {
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const event = events[i];
		if (event.type === 'request/header') return event.data?.header?.config?.provider;
	}
	return undefined;
}

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

/**
 * What to do with one session, from its header and log alone.
 * @param {object} input
 * @param {{ parentSession?: string, origin?: string }} input.header
 * @param {readonly object[]} input.events
 * @param {number} input.now - epoch ms.
 * @param {number} input.maxAgeMs - a cut older than this is left alone.
 * @param {readonly string[]} input.skipProviders - providers whose sessions another plugin resumes.
 * @param {number} input.maxResumes - consecutive resumes after which a session is left alone.
 * @returns {{ resume: false, why: string } | { resume: true, child: boolean, parentId?: string, cut: object }}
 */
export function assess({ header, events, now, maxAgeMs, skipProviders, maxResumes }) {
	const cut = lastCut(events);
	if (cut === undefined) return { resume: false, why: 'no cut turn at the tail' };
	const child = header.origin === 'subagent' && Boolean(header.parentSession);
	if (!shutdownCut(cut.kind) && !(child && cut.kind === 'parent'))
		return { resume: false, why: `last turn ended ${cut.kind}` };
	if (now - cut.time > maxAgeMs) return { resume: false, why: 'cut too long ago' };
	if (cut.waiting.includes(NOTICE_KIND)) return { resume: false, why: 'a resume notice is already waiting' };
	// A subagent cut because its parent's turn was cut is ours on every provider: the provider only
	// sees the child's turn aborted by its parent, the same as when someone stops the parent, so it
	// cannot know a shutdown did it. Its parent's log can (see parentShutDown).
	const provider = lastProvider(events);
	if (provider !== undefined && skipProviders.includes(provider) && !(child && cut.kind === 'parent'))
		return { resume: false, why: `on ${provider}, which resumes its own sessions` };
	if (turnSources(events, cut.index).includes('schedule'))
		return { resume: false, why: 'a scheduled run, which its scheduler reruns' };
	if (resumeStreak(events) >= maxResumes)
		return { resume: false, why: `already resumed ${maxResumes} times in a row` };
	return child ? { resume: true, child, parentId: header.parentSession, cut } : { resume: true, child, cut };
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
