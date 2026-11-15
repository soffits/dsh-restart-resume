#!/usr/bin/env node
// End-to-end check on a real DSH, in a throwaway DSH_HOME under .e2e/ (never the live one).
//
// A scripted OpenAI-compatible model stands in for a real one, so a run costs nothing and every
// answer is known. Over ACP a root session starts a subagent; both then sit in a long `sleep`. DSH
// is stopped (SIGTERM: graceful, or SIGKILL: a hard death) and started again with this plugin. The
// check passes when the root and the child each get exactly one resume message, both answer it,
// the root's notice names the child, and a further restart resumes nothing.
//
// With `idle`, the root ends its turn after starting the child, so only the child is cut.
//
// Usage: node tools/e2e.mjs [term|kill] [idle] [--keep]
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv.includes('kill') ? 'kill' : 'term';
const keep = process.argv.includes('--keep');
const idle = process.argv.includes('idle');
const root = join(REPO, '.e2e', `run-${mode}${idle ? '-idle' : ''}-${Date.now()}`);
const home = join(root, 'home');
const state = join(root, 'state');
const work = join(root, 'work');
const modelLog = join(root, 'model.jsonl');
mkdirSync(work, { recursive: true });
mkdirSync(state, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${line}`);

// ---------------------------------------------------------------------------------------------
// The scripted model

/** Text of a chat message's content. */
const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).map((p) => p.text ?? '').join(''));

/** What the scripted model does next for one request. */
function decide(body) {
	const messages = body.messages ?? [];
	const all = messages.map((m) => textOf(m.content)).join('\n');
	const users = messages.filter((m) => m.role === 'user');
	const lastUser = textOf(users.at(-1)?.content);
	const last = messages.at(-1);
	const toolNames = (body.tools ?? []).map((t) => t.function?.name);
	if (all.includes('E2E-CHILD')) {
		if (lastUser.includes('[Restart Resume]') && last?.role === 'user') return { who: 'child', text: 'CHILD-RESUMED-OK' };
		if (!messages.some((m) => m.tool_calls?.length)) return { who: 'child', tool: ['bash', { command: 'sleep 600', description: 'wait' }] };
		return { who: 'child', text: 'child done' };
	}
	if (all.includes('E2E-ROOT')) {
		if (last?.role === 'user' && lastUser.includes('[Restart Resume]')) return { who: 'root', text: 'ROOT-RESUMED-OK' };
		if (last?.role === 'user' && lastUser.includes('CHILD-RESUMED-OK')) return { who: 'root', text: 'ROOT-SAW-CHILD' };
		const calls = messages.flatMap((m) => m.tool_calls ?? []).map((c) => c.function?.name);
		if (!calls.includes('subagent'))
			return { who: 'root', tool: ['subagent', { description: 'e2e child', prompt: 'E2E-CHILD: wait for the job, then answer.' }], toolNames };
		if (!calls.includes('bash') && !idle) return { who: 'root', tool: ['bash', { command: 'sleep 600', description: 'wait' }] };
		return { who: 'root', text: 'root idle' };
	}
	return { who: 'other', text: 'Title' };
}

/** One streamed chat completion answering `decision`. */
function stream(res, decision) {
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const chunk = (delta, finish = null) =>
		res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
	if (decision.tool) {
		const [name, args] = decision.tool;
		chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
		chunk({}, 'tool_calls');
	} else {
		chunk({ role: 'assistant', content: decision.text });
		chunk({}, 'stop');
	}
	res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
	res.end('data: [DONE]\n\n');
}

const server = createServer((req, res) => {
	let raw = '';
	req.on('data', (c) => (raw += c));
	req.on('end', () => {
		if (req.url?.endsWith('/models')) {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ data: [{ id: 'm1', object: 'model' }] }));
			return;
		}
		let body = {};
		try {
			body = JSON.parse(raw);
		} catch {
			// not JSON: answered as "other"
		}
		const decision = decide(body);
		appendFileSync(modelLog, `${JSON.stringify({ at: Date.now(), ...decision, toolNames: undefined })}\n`);
		stream(res, decision);
	});
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const modelPort = server.address().port;

// ---------------------------------------------------------------------------------------------
// The throwaway DSH

const env = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	LANG: 'C.UTF-8',
	DSH_HOME: home,
	E2E_MODEL_KEY: 'none',
	DSH_RESTART_RESUME_STATE_DIR: state,
};
execFileSync('dsh', ['--profile', 'acp', '--dump-config'], { env, stdio: 'ignore' });
const profile = join(home, 'profiles', 'acp');
const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
manifest.dsh.profile.bundles.push('@soffits/dsh-restart-resume');
writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2));
mkdirSync(join(profile, 'node_modules', '@soffits'), { recursive: true });
symlinkSync(REPO, join(profile, 'node_modules', '@soffits', 'dsh-restart-resume'));

const freePort = () =>
	new Promise((done) => {
		const s = createServer();
		s.listen(0, '127.0.0.1', () => {
			const { port } = s.address();
			s.close(() => done(port));
		});
	});
const webPort = await freePort();
const patch = join(root, 'patch.yml');
writeFileSync(
	patch,
	[
		'- id: llm-pi-ai',
		'  config:',
		'    providers:',
		'      e2e:',
		'        displayName: E2E',
		'        apiKeyEnv: E2E_MODEL_KEY',
		'        api: openai-completions',
		`        baseURL: http://127.0.0.1:${modelPort}/v1`,
		'        models:',
		'          - id: m1',
		'            name: Scripted',
		'            contextWindow: 200000',
		'            maxTokens: 8000',
		'- id: acp',
		'  config:',
		'    provider: e2e',
		'    model: m1',
		'- id: agent-default-model',
		'  config:',
		'    provider: e2e',
		'    model: m1',
		'- id: restart-resume',
		'  config:',
		'    delaySeconds: 5',
		'- insert:',
		'    - id: workspace',
		"      name: '@deepseek-ai/dsh-workspace'",
		'    - id: connection',
		"      name: '@deepseek-ai/dsh-client-connection'",
		'    - id: file-upload',
		"      name: '@deepseek-ai/dsh-client-file-upload'",
		'    - id: session-controller',
		"      name: '@deepseek-ai/dsh-api-session-controller'",
		'    - id: webserver',
		"      name: '@deepseek-ai/dsh-host-webserver'",
		'      config:',
		'        host: 127.0.0.1',
		`        port: ${webPort}`,
		'',
	].join('\n'),
);

/** One DSH process speaking ACP on stdio. */
class Dsh {
	constructor(tag) {
		this.child = spawn('dsh', ['--profile', 'acp', '--patch', patch], { env, cwd: work, stdio: ['pipe', 'pipe', 'pipe'] });
		this.next = 1;
		this.waiting = new Map();
		const errFile = join(root, `dsh-${tag}.stderr`);
		this.child.stderr.on('data', (c) => appendFileSync(errFile, c));
		let buffered = '';
		this.child.stdout.on('data', (c) => {
			buffered += c;
			for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
				const line = buffered.slice(0, at);
				buffered = buffered.slice(at + 1);
				if (line.trim()) this.receive(line);
			}
		});
		this.exited = new Promise((r) => this.child.once('exit', (code, signal) => r({ code, signal })));
	}
	receive(line) {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (msg.method === undefined && msg.id !== undefined) {
			const w = this.waiting.get(msg.id);
			this.waiting.delete(msg.id);
			if (msg.error) w?.fail(new Error(JSON.stringify(msg.error)));
			else w?.done(msg.result ?? {});
		} else if (msg.method === 'session/request_permission' && msg.id !== undefined) {
			const allow = msg.params?.options?.find((o) => o.kind?.startsWith('allow'));
			this.send({ jsonrpc: '2.0', id: msg.id, result: { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } } });
		} else if (msg.id !== undefined) {
			this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } });
		}
	}
	send(msg) {
		this.child.stdin.write(`${JSON.stringify(msg)}\n`);
	}
	request(method, params, timeoutMs = 120_000) {
		const id = this.next++;
		return new Promise((done, fail) => {
			const t = setTimeout(() => fail(new Error(`${method}: no answer`)), timeoutMs);
			this.waiting.set(id, {
				done: (r) => (clearTimeout(t), done(r)),
				fail: (e) => (clearTimeout(t), fail(e)),
			});
			this.send({ jsonrpc: '2.0', id, method, params });
		});
	}
	async stop(signal) {
		this.child.kill(signal);
		const timeout = sleep(30_000).then(() => 'timeout');
		if ((await Promise.race([this.exited, timeout])) === 'timeout') {
			this.child.kill('SIGKILL');
			await this.exited;
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Reading the logs

/** The events of every session log under the throwaway home, by session id. */
function sessionLogs() {
	const out = new Map();
	const dir = join(home, 'sessions');
	for (const ws of readdirSync(dir)) {
		for (const id of readdirSync(join(dir, ws))) {
			const sdir = join(dir, ws, id);
			if (!statSync(sdir).isDirectory()) continue;
			const file = readdirSync(sdir).find((f) => f.startsWith('session.v'));
			if (!file) continue;
			let buf = readFileSync(join(sdir, file));
			if (file.endsWith('.zstd')) buf = decodeFrames(buf);
			const lines = buf.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
			out.set(lines[0].id, lines);
		}
	}
	return out;
}

/** DSH writes its zstd logs as one frame per append; Node's one-shot decoder reads only the first. */
function decodeFrames(buf) {
	const parts = [];
	let off = 0;
	while (off + 5 < buf.length) {
		const start = off;
		off += 4;
		const d = buf.readUInt8(off);
		off += 1;
		const fcs = d >>> 6;
		const single = (d & 32) !== 0;
		const dict = d & 3;
		off += (single ? 0 : 1) + (dict === 3 ? 4 : dict) + (fcs === 0 ? (single ? 1 : 0) : 1 << fcs);
		for (;;) {
			if (off + 3 > buf.length) return Buffer.concat(parts);
			const h = buf.readUIntLE(off, 3);
			off += 3;
			off += ((h >>> 1) & 3) === 1 ? 1 : h >>> 3;
			if (h & 1) break;
		}
		if (d & 4) off += 4;
		if (off > buf.length) break;
		parts.push(zstdDecompressSync(buf.subarray(start, off)));
	}
	return Buffer.concat(parts);
}

const userTexts = (events) => events.filter((e) => e.type === 'user/message').map((e) => ({ kind: e.data?.source?.kind, text: textOf(e.data?.content) }));
const turnEnds = (events) => events.filter((e) => e.type === 'turn/end').map((e) => (e.data.reason.kind === 'aborted' ? `aborted/${e.data.reason.reason?.kind}` : e.data.reason.kind));
const modelLines = () => readFileSync(modelLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function until(what, check, timeoutMs = 90_000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const v = check();
		if (v) return v;
		await sleep(1000);
	}
	throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------------------------
// The run

const failures = [];
const expect = (ok, line) => {
	say(`${ok ? 'PASS' : 'FAIL'} ${line}`);
	if (!ok) failures.push(line);
};

try {
	say(`home ${home}, model on :${modelPort}, mode ${mode}`);
	const first = new Dsh('1');
	await first.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
	const { sessionId: rootId } = await first.request('session/new', { cwd: work, mcpServers: [] });
	say(`root session ${rootId}`);
	first.request('session/prompt', { sessionId: rootId, prompt: [{ type: 'text', text: 'E2E-ROOT: start one subagent, then wait.' }] }, 3_600_000).catch(() => {});
	await until('root and child both sleeping', () => {
		const lines = existsSafe(modelLog) ? modelLines() : [];
		const rootWaiting = idle ? lines.some((l) => l.who === 'root' && l.text === 'root idle') : lines.some((l) => l.who === 'root' && l.tool?.[0] === 'bash');
		return rootWaiting && lines.some((l) => l.who === 'child' && l.tool?.[0] === 'bash');
	});
	await sleep(3000);
	say(`stopping DSH with ${mode === 'kill' ? 'SIGKILL' : 'SIGTERM'}`);
	await first.stop(mode === 'kill' ? 'SIGKILL' : 'SIGTERM');

	let logs = sessionLogs();
	const childId = [...logs.keys()].find((id) => logs.get(id)[0].parentSession === rootId);
	expect(Boolean(childId), `a child of the root exists (${childId})`);
	say(`after stop: root ends ${JSON.stringify(turnEnds(logs.get(rootId)))}, child ends ${JSON.stringify(turnEnds(logs.get(childId) ?? []))}`);

	const second = new Dsh('2');
	const beforeSecond = modelLines().length;
	await until('both resumed answers', () => {
		const lines = modelLines().slice(beforeSecond);
		return (idle || lines.some((l) => l.text === 'ROOT-RESUMED-OK')) && lines.some((l) => l.text === 'CHILD-RESUMED-OK') && lines.some((l) => l.text === 'ROOT-SAW-CHILD');
	}, 120_000).catch((e) => say(String(e)));
	await sleep(5000);
	await second.stop('SIGTERM');

	logs = sessionLogs();
	const rootMsgs = userTexts(logs.get(rootId));
	const childMsgs = userTexts(logs.get(childId));
	const rootNotices = rootMsgs.filter((m) => m.text.includes('[Restart Resume]'));
	const childNotices = childMsgs.filter((m) => m.text.includes('[Restart Resume]'));
	if (idle) expect(rootNotices.length === 0, `the idle root got no resume message (got ${rootNotices.length})`);
	else {
		expect(rootNotices.length === 1, `root got one resume message (got ${rootNotices.length}, source ${rootNotices[0]?.kind})`);
		expect(rootNotices[0]?.text.includes(childId), 'the root notice names the child');
	}
	expect(childNotices.length === 1, `child got one resume message (got ${childNotices.length}, source ${childNotices[0]?.kind})`);
	const after = modelLines().slice(beforeSecond);
	expect(after.filter((l) => l.text === 'ROOT-RESUMED-OK').length === (idle ? 0 : 1), 'the root answered a resume only if it was cut');
	expect(after.filter((l) => l.text === 'CHILD-RESUMED-OK').length === 1, 'the child answered the resume once');
	expect(after.some((l) => l.text === 'ROOT-SAW-CHILD'), "the root got the child's result");

	say('third start: nothing left to resume');
	const beforeThird = modelLines().length;
	const third = new Dsh('3');
	await sleep(20_000);
	await third.stop('SIGTERM');
	const third_lines = modelLines().slice(beforeThird).filter((l) => l.who !== 'other');
	expect(third_lines.length === 0, `no model call for root or child after the third start (got ${third_lines.length})`);
	const resumeLog = readFileSync(join(state, 'resume.log'), 'utf8');
	say(`resume.log:\n${resumeLog}`);
} catch (error) {
	failures.push(String(error?.stack ?? error));
	say(`error: ${error?.stack ?? error}`);
} finally {
	server.close();
	if (!keep && failures.length === 0) rmSync(root, { recursive: true, force: true });
	else say(`kept ${root}`);
}
say(failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);

function existsSafe(path) {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}
