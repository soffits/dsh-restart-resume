// Background jobs a restart killed while their session waited on them. Event shapes as DSH
// 0.2.2-rc.1 writes them (`job/registered`, `job/settled`); DSH keeps its job registry in the
// process, so a stop leaves the job registered with no settlement in the log.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assess, lostJobs } from '../src/detect.js';
import { jobsText, ROOT_TEXT, scan } from '../src/resume.js';

const T = 1_794_726_717_539; // a wait job started at 07:11Z
const STOP = T + 3 * 3_600_000; // DSH stopped three hours later
const BOOT = STOP + 15_000;
const NOW = BOOT + 60_000;

const registered = (jobId, time, label) => ({
	type: 'job/registered', seq: time, time,
	data: { jobId, owner: 'S', kind: 'bash', label, startedAt: time, toolCall: { callId: 'c', rootCallId: 'c' } },
});
const settled = (jobId, time, status, cause) => ({
	type: 'job/settled', seq: time + 1, time,
	data: { jobId, owner: 'S', kind: 'bash', label: 'x', startedAt: T, finishedAt: time, status, ...(cause ? { cause } : {}) },
});
const turn = (start, end, kind = 'completed') => [
	{ type: 'turn/start', seq: start, time: start, data: { turn: 1 } },
	{ type: 'turn/end', seq: end, time: end, data: { turn: 1, reason: { kind } } },
];
const WAIT = 'until out=$(bash gate.sh) && [ "${out#eval}" != "$out" ]; do sleep 240; done;\n echo "$out"';
const idleWaiting = [...turn(T - 5_000, T + 20_000), registered('bash-wait', T, WAIT)];
const base = { now: NOW, maxAgeMs: 120 * 60_000, maxResumes: 3, bootTime: BOOT, previousStop: STOP };

test('a job registered before this process started and never settled was killed by the stop', () => {
	assert.deepEqual(lostJobs(idleWaiting, BOOT, STOP), [{ id: 'bash-wait', label: 'until out=$(bash gate.sh) && [ "${out#eval}" != "$out" ]; do sleep 240; done; echo "$out"' }]);
	const finished = [...idleWaiting, settled('bash-wait', T + 60_000, 'exited')];
	assert.deepEqual(lostJobs(finished, BOOT, STOP), [], 'a job that ran out is not lost');
	const atTurnEnd = [...idleWaiting, settled('bash-wait', T + 20_028, 'killed', 'teardown')];
	assert.deepEqual(lostJobs(atTurnEnd, BOOT, STOP), [], 'a teardown long before the stop is not the stop');
	const atStop = [...idleWaiting, settled('bash-wait', STOP + 40, 'killed', 'teardown')];
	assert.equal(lostJobs(atStop, BOOT, STOP).length, 1, 'DSH tearing it down as it stopped is');
	const fresh = [registered('bash-new', BOOT + 5_000, 'sleep 1')];
	assert.deepEqual(lostJobs(fresh, BOOT, STOP), [], 'a job of this process runs');
});

test('an idle root that was waiting on a killed job is woken on every provider', () => {
	const events = [...idleWaiting, { type: 'request/header', seq: 1, time: T - 4_000, data: { header: { config: { provider: 'claude-code' } } } }];
	const verdict = assess({ header: {}, events, ...base });
	assert.equal(verdict.resume, true);
	assert.equal(verdict.cut, undefined);
	assert.deepEqual(verdict.jobs.map((j) => j.id), ['bash-wait']);
});

test('a session that started a turn since, or already has the notice waiting, is left alone', () => {
	const moved = [...idleWaiting, ...turn(BOOT + 10_000, BOOT + 20_000)];
	assert.equal(assess({ header: {}, events: moved, ...base }).resume, false);
	const waiting = [...idleWaiting, { type: 'agent/inbox/spliced', seq: 9, time: BOOT + 1, data: { inserted: [{ source: { kind: 'restart-resume' } }] } }];
	assert.equal(assess({ header: {}, events: waiting, ...base }).resume, false);
});

test('the scan wakes an idle root and a subagent (through its parent) that lost their jobs', async () => {
	const calls = [];
	const sessions = {
		R: { header: {}, events: idleWaiting },
		C: { header: { origin: 'subagent', parentSession: 'P' }, events: idleWaiting },
		P: { header: {}, events: turn(T - 9_000, T - 8_000) },
	};
	const agent = (id) => ({ id, session: { id }, status: 'idle', followup: (m) => calls.push(['followup', id, m.content.map((b) => b.text)]), steer: () => {} });
	const deps = {
		config: { maxAgeMinutes: 120, maxResumes: 3, resumeGoals: false, jobMaxAgeHours: 24 },
		log: async (line) => calls.push(['log', line]),
		now: () => NOW,
		bootTime: BOOT,
		previousStop: STOP,
		// The waiting sessions last wrote three hours before the restart: outside the turn window, inside the job one.
		listSessions: async () => Object.entries(sessions).map(([sessionId, s]) => ({ sessionId, updatedAt: T + 20_000, running: false, parentSessionId: s.header.parentSession })),
		readSession: async (id) => ({ session: sessions[id].header, events: sessions[id].events }),
		archived: () => new Set(),
		liveAgent: () => undefined,
		resolveAgent: async (id) => agent(id),
		subagents: { sendMessage: async (sender, target, content) => calls.push(['send', sender.id, target, content.map((b) => b.text)]) },
		createUserMessage: ({ content, source }) => ({ content, source }),
		flush: async () => true,
	};
	assert.deepEqual(await scan(deps), { roots: ['R'], children: ['C'] });
	const jobs = [{ id: 'bash-wait', label: 'until out=$(bash gate.sh) && [ "${out#eval}" != "$out" ]; do sleep 240; done; echo "$out"' }];
	assert.deepEqual(calls.filter((c) => c[0] !== 'log'), [
		['send', 'P', 'C', [jobsText(jobs, true)]],
		['followup', 'R', [jobsText(jobs, false)]],
	]);
	assert.ok(calls.some((c) => c[0] === 'log' && c[1] === 'resumed R (lost job(s) bash-wait)'));
	assert.ok(!jobsText(jobs, false).includes(ROOT_TEXT));
});

test('a job lost by an earlier restart is not lost again by the next one', () => {
	// The third start: the job was lost two processes ago and already named in a notice.
	const named = [...idleWaiting,
		{ type: 'user/message', seq: 1, time: STOP + 70_000, data: { source: { kind: 'restart-resume' }, content: [{ type: 'text', text: '[Restart Resume] ... killed it: bash-wait (until ...)' }] } },
		...turn(STOP + 70_001, STOP + 80_000)];
	const later = STOP + 3_600_000;
	assert.deepEqual(lostJobs(named, later + 10_000, later), []);
	// Not named (a cut turn's notice, say), but registered before the previous process started.
	assert.deepEqual(lostJobs(idleWaiting, later + 10_000, later, BOOT), []);
	assert.equal(lostJobs(idleWaiting, BOOT, STOP, T - 60_000).length, 1, 'registered in the previous process: lost');
});

test('a tool call cut with its turn is the cut turn, and jobs older than an earlier cut are gone', () => {
	const cutTurn = [
		{ type: 'turn/start', seq: 1, time: T, data: { turn: 1 } },
		registered('bash-fg', T + 100, 'sleep 600'),
		{ type: 'turn/end', seq: 2, time: T + 101, data: { turn: 1, reason: { kind: 'interrupted' } } },
	];
	assert.deepEqual(lostJobs(cutTurn, BOOT, STOP), []);
	const waitThenCut = [...idleWaiting,
		{ type: 'turn/start', seq: 3, time: T + 30_000, data: { turn: 2 } },
		{ type: 'turn/end', seq: 4, time: STOP, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } }];
	assert.deepEqual(lostJobs(waitThenCut, BOOT, STOP).map((j) => j.id), ['bash-wait'], 'a wait started before the cut turn is lost too');
	const verdict = assess({ header: {}, events: waitThenCut, ...base });
	assert.ok(verdict.cut && verdict.jobs.length === 1);
	const resumedSince = [...cutTurn, ...turn(T + 200, T + 300)];
	assert.deepEqual(lostJobs(resumedSince, BOOT + 3_600_000, STOP + 3_600_000), [], 'the cut was an earlier stop');
});
