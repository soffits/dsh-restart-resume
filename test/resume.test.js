// The scan against a fake DSH: what is resumed, through whom, in which order, and what a parent is told.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { lastCut } from '../src/detect.js';
import { CHILD_TEXT, childrenText, cutText, ROOT_TEXT, scan } from '../src/resume.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
// The fixtures were cut on different days; the window is wide so each still counts.
const CONFIG = { maxAgeMinutes: 1440 * 3, maxResumes: 3, resumeGoals: true };

/** A fake DSH holding `sessions` ({ id: { header, events } }), none of them loaded. */
function fakeDsh(sessions, options = {}) {
	const calls = [];
	const live = new Map();
	const goalState = new Map(Object.entries(options.goals ?? {}));
	const agent = (id) => ({
		id,
		session: { id },
		status: options.running?.includes(id) ? 'running' : 'idle',
		followup: (m) => calls.push(['followup', id, m.content.map((b) => b.text), m.source.kind]),
		steer: (m) => calls.push(['steer', id, m.content.map((b) => b.text)]),
	});
	for (const id of options.running ?? []) live.set(id, agent(id));
	const cutTimes = Object.values(sessions).map((s) => lastCut(s.events)?.time ?? 0);
	const now = Math.max(...cutTimes) + 60_000;
	const deps = {
		config: { ...CONFIG, ...options.config },
		log: async (line) => calls.push(['log', line]),
		now: () => now,
		listSessions: async () =>
			Object.entries(sessions).map(([sessionId, s]) => ({
				sessionId,
				updatedAt: now - 60_000,
				running: options.running?.includes(sessionId) ?? false,
				// as DSH lists a cold subagent whose turn never finished
				blank: s.header.origin === 'subagent',
				parentSessionId: s.header.parentSession,
			})),
		readSession: async (id) => {
			if (!sessions[id]) throw new Error(`no session ${id}`);
			return { session: sessions[id].header, events: sessions[id].events };
		},
		archived: () => new Set(options.archived ?? []),
		liveAgent: (id) => live.get(id),
		resolveAgent: async (id) => {
			if (sessions[id]?.header.origin === 'subagent') throw new Error(`session "${id}" is owned by subagent routing`);
			calls.push(['resolve', id]);
			const a = agent(id);
			live.set(id, a);
			return a;
		},
		subagents: {
			sendMessage: async (sender, target, content, { signal }) => {
				assert.ok(signal instanceof AbortSignal);
				calls.push(['send', sender.id, target, content.map((b) => b.text)]);
				return 'm';
			},
		},
		goals: {
			get: (a) => goalState.get(a.id),
			resume: (a, ref) => calls.push(['goal', a.id, ref.id]),
		},
		createUserMessage: ({ content, source }) => ({ content, source }),
		flush: async () => true,
	};
	return { deps, calls };
}

/** The sessions a scan continued itself. */
const continued = (r) => ({ roots: r.roots, children: r.children });

const session = (name, header, provider) => {
	const f = fixture(name);
	const events = provider
		? f.events.map((e) => (e.type === 'request/header' ? { ...e, data: { header: { config: { provider, model: 'm' } } } } : e))
		: f.events;
	return { header: header ?? f.header, events };
};

test('children go through their parent first; a resumed parent is told of them in its own notice', async () => {
	const { deps, calls } = fakeDsh(
		{
			R: session('root-claude-disposed'),
			C: session('child-disposed', { origin: 'subagent', parentSession: 'R' }),
		},
		{ goals: { R: { id: 'g1', revision: 4, phase: 'active', activation: 'disarmed', roundsStarted: 2, maxGoalRounds: 10 } } },
	);
	const result = await scan(deps);
	assert.deepEqual(continued(result), { roots: ['R'], children: ['C'] });
	const acts = calls.filter((c) => c[0] !== 'log');
	assert.deepEqual(acts, [
		['resolve', 'R'],
		['send', 'R', 'C', [CHILD_TEXT]],
		['followup', 'R', [ROOT_TEXT, childrenText(['C'])], 'restart-resume'],
		['goal', 'R', 'g1'],
	]);
});

test('a child whose parent is already running again is continued, and the running parent is told', async () => {
	const { deps, calls } = fakeDsh(
		{
			P: session('root-claude-disposed'),
			C: session('child-interrupted', { origin: 'subagent', parentSession: 'P' }, 'openrouter'),
		},
		{ running: ['P'] },
	);
	const result = await scan(deps);
	assert.deepEqual(continued(result), { roots: [], children: ['C'] });
	assert.deepEqual(
		calls.filter((c) => c[0] === 'send' || c[0] === 'steer'),
		[
			['send', 'P', 'C', [CHILD_TEXT]],
			['steer', 'P', [childrenText(['C'])]],
		],
	);
});

test('a child cut because its parent was stopped by hand stays stopped', async () => {
	const { deps, calls } = fakeDsh({
		P: { header: {}, events: fixture('parent-running').events },
		C: session('child-parent-other', { origin: 'subagent', parentSession: 'P' }),
	});
	assert.deepEqual(continued(await scan(deps)), { roots: [], children: [] });
	assert.ok(calls.some((c) => c[0] === 'log' && c[1].includes('its parent was stopped, not shut down')));
});

test('a child cut with its shut-down parent is continued; the scheduled parent goes to its scheduler', async () => {
	const { deps, calls } = fakeDsh({
		P: session('root-scheduled-disposed'),
		C: session('child-parent-shutdown', { origin: 'subagent', parentSession: 'P' }),
	});
	const handed = [];
	deps.claims = new Map([['cron-job', async (turn) => {
		handed.push([turn.sessionId, turn.principal.id, turn.cut.kind]);
		return { continued: true };
	}]]);
	const result = await scan(deps);
	assert.deepEqual(continued(result), { roots: [], children: ['C'] });
	assert.deepEqual(result.claimed, ['P']);
	assert.deepEqual(handed, [['P', 'job-1', 'disposed']]);
	assert.deepEqual(calls.filter((c) => c[0] === 'send'), [['send', 'P', 'C', [CHILD_TEXT]]]);
	assert.ok(!calls.some((c) => c[0] === 'followup' || c[0] === 'steer'), 'the scheduler continues its run; no notice from here');
});

test('a scheduled run nobody claims gets a notice like any root; a refused one is recorded', async () => {
	const { deps, calls } = fakeDsh({ P: session('root-scheduled-disposed') });
	assert.deepEqual(continued(await scan(deps)), { roots: ['P'], children: [] });
	assert.ok(calls.some((c) => c[0] === 'followup' && c[1] === 'P'));

	const again = fakeDsh({ P: session('root-scheduled-disposed') });
	again.deps.claims = new Map([['cron-job', async () => ({ continued: false, why: 'the next run is due soon' })]]);
	const result = await scan(again.deps);
	assert.deepEqual(result.claimed, []);
	assert.deepEqual(result.skipped, [{ id: 'P', why: 'its cron-job owner did not continue it: the next run is due soon' }]);
	assert.ok(!again.calls.some((c) => c[0] === 'followup'));
});

test('a subagent whose list entry still shows its first prompt is read and continued', async () => {
	// The 19:22Z restart: DSH lists a subagent's `updatedAt` as its creation or last prompt, so a
	// child working for an hour looked older than the previous process and was never read.
	const { deps, calls } = fakeDsh({
		C: session('child-tool-cut', { origin: 'subagent', parentSession: 'P' }),
		P: session('parent-running'),
	});
	const listSessions = deps.listSessions;
	deps.listSessions = async () => (await listSessions()).map((s) => ({ ...s, updatedAt: deps.now() - 3_600_000 }));
	deps.previousStart = deps.now() - 300_000;
	assert.deepEqual(continued(await scan(deps)), { roots: [], children: ['C'] });
	assert.ok(calls.some((c) => c[0] === 'send' && c[2] === 'C'));
});

test('archived roots, running sessions and stopped turns are left alone', async () => {
	const { deps, calls } = fakeDsh(
		{
			A: session('root-claude-disposed'),
			U: session('root-user-stop'),
			H: session('hook-abort', {}),
		},
		{ archived: ['A'] },
	);
	assert.deepEqual(continued(await scan(deps)), { roots: [], children: [] });
	assert.equal(calls.filter((c) => c[0] !== 'log').length, 0);
});

test('a failed resume is logged and the scan goes on', async () => {
	const { deps, calls } = fakeDsh({
		R1: session('root-claude-disposed'),
		R2: session('root-claude-disposed'),
	});
	let first = true;
	const resolve = deps.resolveAgent;
	deps.resolveAgent = async (id) => {
		if (first) {
			first = false;
			throw new Error('log refused');
		}
		return resolve(id);
	};
	const result = await scan(deps);
	assert.equal(result.roots.length, 1);
	assert.ok(calls.some((c) => c[0] === 'log' && c[1].includes('failed: Error: log refused')));
});

test('a child someone continued after the scan read it is left alone', async () => {
	// The scan lists and reads first; a parent or a person may re-prompt the child before its turn
	// comes. That turn already carries the work, so no notice joins it.
	const { deps, calls } = fakeDsh({
		C: session('child-tool-cut', { origin: 'subagent', parentSession: 'P' }),
		P: session('parent-running'),
	});
	deps.liveAgent = (id) => (id === 'C' ? { id, status: 'running' } : undefined);
	const result = await scan(deps);
	assert.deepEqual(result.children, []);
	assert.equal(calls.filter((c) => c[0] === 'send').length, 0);
	assert.ok(calls.some((c) => c[0] === 'log' && c[1] === 'skip C: a turn already runs'));
});

test('a scan after a reload says the reload cut the turn, not a restart', async () => {
	const sessions = { R: session('root-claude-disposed'), C: session('child-disposed', { origin: 'subagent', parentSession: 'R' }) };
	const { deps, calls } = fakeDsh(sessions);
	const cut = lastCut(sessions.R.events).time;
	const result = await scan({ ...deps, cause: 'reload', cutNotBefore: cut - 30_000, bootTime: 0 });
	assert.deepEqual(continued(result), { roots: ['R'], children: ['C'] });
	const sent = calls.filter((c) => c[0] === 'send' || c[0] === 'followup').flatMap((c) => c.flat(2));
	assert.ok(sent.some((text) => typeof text === 'string' && text.includes('part of DSH was reloaded')));
	assert.ok(!sent.includes(ROOT_TEXT) && !sent.includes(CHILD_TEXT));
	assert.equal(cutText('reload', true).includes('Continue your task'), true);
});

test('a scan after a reload leaves a turn cut before the reload alone', async () => {
	const sessions = { R: session('root-claude-disposed') };
	const { deps, calls } = fakeDsh(sessions);
	const cut = lastCut(sessions.R.events).time;
	const result = await scan({ ...deps, cause: 'reload', cutNotBefore: cut + 1_000, bootTime: 0 });
	assert.deepEqual(continued(result), { roots: [], children: [] });
	assert.ok(calls.some((c) => c[0] === 'log' && c[1].includes('cut before the reload')));
});
