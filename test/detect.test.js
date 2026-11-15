// Detection rules against real session logs, anonymised: each fixture is a session as it stood
// when DSH next started after the cut (content, tool data and ids replaced).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assess, lastCut, lastProvider, parentShutDown, resumeStreak, NOTICE_KIND } from '../src/detect.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const DEFAULTS = { maxAgeMs: 120 * 60_000, skipProviders: ['claude-code'], maxResumes: 3 };
/** Judge a fixture a minute after its cut. */
const judge = (f, options = {}) => {
	const cut = lastCut(f.events);
	return assess({ header: f.header, events: f.events, now: (cut?.time ?? 0) + 60_000, ...DEFAULTS, ...options });
};

test('a root cut by a graceful stop is resumed, unless its provider resumes its own', () => {
	const f = fixture('root-claude-disposed');
	assert.equal(lastCut(f.events).kind, 'disposed');
	assert.equal(lastProvider(f.events), 'claude-code');
	assert.deepEqual(judge(f), { resume: false, why: 'on claude-code, which resumes its own sessions' });
	const verdict = judge(f, { skipProviders: [] });
	assert.equal(verdict.resume, true);
	assert.equal(verdict.child, false);
});

test('a scheduled run is left to its scheduler', () => {
	const verdict = judge(fixture('root-scheduled-disposed'), { skipProviders: [] });
	assert.deepEqual(verdict, { resume: false, why: 'a scheduled run, which its scheduler reruns' });
});

test('a subagent cut by a hard death or a graceful stop is resumed through its parent', () => {
	for (const name of ['child-interrupted', 'child-disposed']) {
		const verdict = judge(fixture(name), { skipProviders: [] });
		assert.equal(verdict.resume, true, name);
		assert.equal(verdict.child, true, name);
		assert.equal(verdict.parentId, 'parent', name);
	}
	assert.equal(judge(fixture('child-interrupted')).resume, false, 'on claude-code: dsh-oh-my-claude wakes it');
});

test('a subagent cut with its parent counts only when the parent was shut down too', () => {
	const shut = fixture('child-parent-shutdown');
	const verdict = judge(shut, { skipProviders: [] });
	assert.equal(verdict.resume, true);
	assert.equal(verdict.cut.kind, 'parent');
	assert.equal(parentShutDown(fixture('root-scheduled-disposed').events, verdict.cut.time), true);

	const stopped = fixture('child-parent-stopped');
	assert.equal(parentShutDown(fixture('root-claude-disposed').events, lastCut(stopped.events).time), false);
	const other = fixture('child-parent-other');
	assert.equal(parentShutDown(fixture('parent-running').events, lastCut(other.events).time), false);
});

test('a user stop, a fallback hand-over and a later turn are left alone', () => {
	assert.deepEqual(judge(fixture('root-user-stop'), { skipProviders: [] }), { resume: false, why: 'last turn ended user' });
	assert.deepEqual(judge(fixture('hook-abort'), { skipProviders: [] }), { resume: false, why: 'last turn ended hook' });
	assert.equal(lastCut(fixture('root-newer-turn').events)?.kind, 'completed');
	assert.equal(lastCut(fixture('parent-running').events)?.kind, 'completed');
});

test('bookkeeping and waiting input after the cut do not hide it; a new turn does', () => {
	const f = fixture('child-disposed');
	const extra = [
		{ type: 'job/settled', seq: 9001, time: 1, data: {} },
		// What DSH queues for a parent while it stops that parent's running child (seen in the e2e run).
		{ type: 'agent/inbox/spliced', seq: 9002, time: 1, data: { target: 'next-step', inserted: [{ source: { kind: 'subagent-settled', form: 'notice' } }] } },
		{ type: 'session/end-seed', seq: 9003, time: 1, data: {} },
	];
	assert.equal(lastCut([...f.events, ...extra]).kind, 'disposed');
	const turn = { type: 'turn/start', seq: 9004, time: 1, data: { turn: 9 } };
	assert.equal(lastCut([...f.events, ...extra, turn]), undefined);
});

test('a resume notice still waiting from an earlier start is not stacked', () => {
	const f = fixture('child-disposed');
	const waiting = { type: 'agent/inbox/spliced', seq: 9001, time: 1, data: { target: 'next-turn', inserted: [{ source: { kind: NOTICE_KIND } }] } };
	assert.deepEqual(judge({ header: f.header, events: [...f.events, waiting] }, { skipProviders: [] }), {
		resume: false,
		why: 'a resume notice is already waiting',
	});
});

test('a cut older than the window is left alone', () => {
	const f = fixture('child-disposed');
	const verdict = judge(f, { skipProviders: [], maxAgeMs: 30_000 });
	assert.deepEqual(verdict, { resume: false, why: 'cut too long ago' });
});

test('a session cut again after each resume stops being resumed', () => {
	const base = fixture('child-disposed').events;
	let t = base.at(-1).time;
	let seq = base.at(-1).seq;
	const resumedAndCut = (n) => {
		const out = [];
		for (let i = 0; i < n; i += 1) {
			out.push(
				{ type: 'agent/inbox/spliced', seq: ++seq, time: ++t, data: { target: 'next-turn', inserted: [{ source: { kind: NOTICE_KIND } }] } },
				{ type: 'turn/start', seq: ++seq, time: t, data: { turn: 100 + i } },
				{ type: 'user/message', seq: ++seq, time: t, data: { role: 'user', source: { kind: NOTICE_KIND, form: 'notice' } } },
				{ type: 'turn/end', seq: ++seq, time: ++t, data: { turn: 100 + i, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } },
			);
		}
		return out;
	};
	assert.equal(resumeStreak(base), 0);
	const twice = [...base, ...resumedAndCut(2)];
	assert.equal(resumeStreak(twice), 2);
	assert.equal(judge({ header: fixture('child-disposed').header, events: twice }, { skipProviders: [] }).resume, true);
	const thrice = [...base, ...resumedAndCut(3)];
	assert.deepEqual(judge({ header: { origin: 'subagent', parentSession: 'parent' }, events: thrice }, { skipProviders: [] }), {
		resume: false,
		why: 'already resumed 3 times in a row',
	});
});
