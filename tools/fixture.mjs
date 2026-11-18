// usage: node tools/fixture.mjs <sessionDir> <cutSeq> <label> [parentLabel] > out.json
// Writes the session as it stood at the next boot after the cut at <cutSeq>: every event up to the
// first activity after the cut is kept; content, tool args and ids are replaced.
import { execFileSync } from "node:child_process";
const DUMP = new URL("./dump.mjs", import.meta.url).pathname;
const [dir, cutSeqArg, label, parentLabel] = process.argv.slice(2);
const cutSeq = Number(cutSeqArg);
const lines = execFileSync("node", [DUMP, dir, "raw"], { maxBuffer: 1 << 30 }).toString().split("\n").filter(Boolean);
const header = JSON.parse(lines[0]);
const ACTIVITY = new Set(["turn/start", "agent/inbox/spliced", "agent/inbox/inserted", "agent/inbox/discarded"]);
const KEEP = new Set(["turn/start", "turn/end", "user/message", "request/header", "agent/inbox/spliced", "job/settled", "job/registered", "session/end-seed", "tool-workflow/agent-end", "tool-workflow/run-end", "assistant/message", "tool/call", "tool/result", "step/start", "step/end"]);
const src = (s) => (s ? { kind: s.kind, ...(s.form ? { form: s.form } : {}) } : undefined);
const out = [];
for (const l of lines.slice(1)) {
  const e = JSON.parse(l);
  if (e.seq > cutSeq && ACTIVITY.has(e.type)) break;
  if (!KEEP.has(e.type)) continue;
  const d = e.data ?? {};
  let data = {};
  if (e.type === "turn/start") data = { turn: d.turn };
  else if (e.type === "turn/end") data = { turn: d.turn, reason: d.reason?.kind === "error" ? { kind: "error" } : d.reason };
  else if (e.type === "user/message") data = { role: "user", source: src(d.source), content: [{ type: "text", text: "<text>" }] };
  else if (e.type === "request/header") data = { header: { config: { provider: d.header?.config?.provider, model: d.header?.config?.model } } };
  else if (e.type === "agent/inbox/spliced") data = { target: d.target, inserted: (d.inserted ?? []).map((m) => ({ source: src(m.source) })), ...(d.removedCount ? { removedCount: d.removedCount } : {}) };
  out.push({ type: e.type, seq: e.seq, time: e.time, data });
}
// collapse long middles: keep request/header, turn bounds, user messages, last 20 events
const essential = (e, i) => i >= out.length - 20 || ["turn/start", "turn/end", "user/message", "request/header", "agent/inbox/spliced"].includes(e.type);
const events = out.filter(essential);
const h = { origin: header.origin, ...(header.parentSession ? { parentSession: parentLabel ?? "parent" } : {}) };
if (!header.origin) delete h.origin;
process.stdout.write(JSON.stringify({ id: label, header: h, events }, null, 0).replace(/\},\{"type"/g, '},\n{"type"') + "\n");
