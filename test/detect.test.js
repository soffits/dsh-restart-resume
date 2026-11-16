// Detection rules against real session logs, anonymised: each fixture is a session as it stood
// when DSH next started after the cut (content, tool data and ids replaced).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assess, lastCut, parentShutDown, resumeStreak, NOTICE_KIND } from '../src/detect.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const DEFAULTS = { maxAgeMs: 120 * 60_000, maxResumes: 3 };
/** Judge a fixture a minute after its cut. */
const judge = (f, options = {}) => {
	const cut = lastCut(f.events);
	return assess({ header: f.header, events: f.events, now: (cut?.time ?? 0) + 60_000, ...DEFAULTS, ...options });
};

test('a root cut by a graceful stop is resumed, on claude-code too', () => {
	const f = fixture('root-claude-disposed');
	assert.equal(lastCut(f.events).kind, 'disposed');
	const verdict = judge(f);
	assert.equal(verdict.resume, true);
	assert.equal(verdict.child, false);
});

test('a subagent cut while DSH ran its tool call is resumed, whatever its provider', () => {
	// A claude-code child stopped mid-`bash`: the model step had ended, so no provider stream was
	// open to see the stop. Only DSH's log has it.
	const verdict = judge(fixture('child-tool-cut'));
	assert.equal(verdict.resume, true);
	assert.equal(verdict.child, true);
	assert.equal(verdict.cut.kind, 'interrupted');
});

test('a scheduled run is left to its scheduler', () => {
	const verdict = judge(fixture('root-scheduled-disposed'));
	assert.deepEqual(verdict, { resume: false, why: 'a scheduled run, which its scheduler reruns' });
});

test('a subagent cut by a hard death or a graceful stop is resumed through its parent', () => {
	for (const name of ['child-interrupted', 'child-disposed']) {
		const verdict = judge(fixture(name));
		assert.equal(verdict.resume, true, name);
		assert.equal(verdict.child, true, name);
		assert.equal(verdict.parentId, 'parent', name);
	}
});

test('a subagent cut with its parent counts only when the parent was shut down too', () => {
	const shut = fixture('child-parent-shutdown');
	const verdict = judge(shut);
	assert.equal(verdict.resume, true);
	assert.equal(verdict.cut.kind, 'parent');
	assert.equal(parentShutDown(fixture('root-scheduled-disposed').events, verdict.cut.time), true);

	const stopped = fixture('child-parent-stopped');
	assert.equal(parentShutDown(fixture('root-claude-disposed').events, lastCut(stopped.events).time), false);
	const other = fixture('child-parent-other');
	assert.equal(parentShutDown(fixture('parent-running').events, lastCut(other.events).time), false);
});

test('a subagent of an idle parent counts when the cut lies at the previous stop', () => {
	// The parent's last turn completed long before; DSH's teardown cut the child with cause parent.
	const idleParent = fixture('parent-running').events;
	const childCut = idleParent.at(-1).time + 3_600_000;
	assert.equal(parentShutDown(idleParent, childCut, undefined), false, 'no stop recorded: left alone');
	assert.equal(parentShutDown(idleParent, childCut, childCut + 1500), true, 'cut 1.5 s before the stop');
	assert.equal(parentShutDown(idleParent, childCut, childCut + 600_000), false, 'a stop ten minutes later is another event');
	// A parent turn that just completed cut nothing; the stop did.
	const completed = [...idleParent, { type: 'turn/end', seq: 1, time: childCut - 3000, data: { turn: 9, reason: { kind: 'completed' } } }];
	assert.equal(parentShutDown(completed, childCut, childCut + 400), true);
	// A parent turn ended by hand at that moment wins over a stop nearby.
	const stopped = [...idleParent, { type: 'turn/end', seq: 1, time: childCut - 200, data: { turn: 9, reason: { kind: 'aborted', reason: { kind: 'user' } } } }];
	assert.equal(parentShutDown(stopped, childCut, childCut + 1500), false);
});

test('a user stop, a fallback hand-over and a later turn are left alone', () => {
	assert.deepEqual(judge(fixture('root-user-stop')), { resume: false, why: 'last turn ended user' });
	assert.deepEqual(judge(fixture('hook-abort')), { resume: false, why: 'last turn ended hook' });
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
	assert.deepEqual(judge({ header: f.header, events: [...f.events, waiting] }), {
		resume: false,
		why: 'a resume notice is already waiting',
	});
});

test('a cut older than the window is left alone', () => {
	const f = fixture('child-disposed');
	const verdict = judge(f, { maxAgeMs: 30_000 });
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
	assert.equal(judge({ header: fixture('child-disposed').header, events: twice }).resume, true);
	const thrice = [...base, ...resumedAndCut(3)];
	assert.deepEqual(judge({ header: { origin: 'subagent', parentSession: 'parent' }, events: thrice }), {
		resume: false,
		why: 'already resumed 3 times in a row',
	});
});
