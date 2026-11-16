// The scan against a fake DSH: what is resumed, through whom, in which order, and what a parent is told.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { lastCut } from '../src/detect.js';
import { CHILD_TEXT, childrenText, ROOT_TEXT, scan } from '../src/resume.js';

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
	assert.deepEqual(result, { roots: ['R'], children: ['C'] });
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
	assert.deepEqual(result, { roots: [], children: ['C'] });
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
	assert.deepEqual(await scan(deps), { roots: [], children: [] });
	assert.ok(calls.some((c) => c[0] === 'log' && c[1].includes('its parent was stopped, not shut down')));
});

test('a child cut with its shut-down parent is continued; the scheduled parent is left to its scheduler', async () => {
	const { deps, calls } = fakeDsh({
		P: session('root-scheduled-disposed'),
		C: session('child-parent-shutdown', { origin: 'subagent', parentSession: 'P' }),
	});
	assert.deepEqual(await scan(deps), { roots: [], children: ['C'] });
	assert.deepEqual(calls.filter((c) => c[0] === 'send'), [['send', 'P', 'C', [CHILD_TEXT]]]);
	assert.ok(!calls.some((c) => c[0] === 'steer'), 'an idle parent hears from its child, not from us');
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
	assert.deepEqual(await scan(deps), { roots: [], children: [] });
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
