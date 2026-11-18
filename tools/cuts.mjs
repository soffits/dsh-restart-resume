// usage: node tools/cuts.mjs <DSH_HOME>/sessions [days=4]: every turn cut by a stop, with its session, kind and the first user message's source
import { readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const DUMP = new URL("./dump.mjs", import.meta.url).pathname;
const root = process.argv[2]; const days = Number(process.argv[3] ?? 4);
const rows = [];
for (const ws of readdirSync(root)) for (const id of readdirSync(join(root, ws))) {
  const dir = join(root, ws, id);
  try { if (Date.now() - statSync(dir).mtimeMs > days * 864e5) continue; } catch { continue; }
  let out; try { out = execFileSync("node", [DUMP, dir, "raw"], { maxBuffer: 1 << 30 }).toString(); } catch { continue; }
  const ev = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const h = ev[0];
  const firstUser = ev.find((e) => e.type === "user/message");
  const src = firstUser?.data?.message?.source?.kind ?? firstUser?.data?.source?.kind;
  for (let i = 1; i < ev.length; i++) {
    const e = ev[i];
    if (e.type !== "turn/end") continue;
    const r = e.data.reason; const k = r.kind === "aborted" ? `aborted/${r.reason?.kind}` : r.kind;
    if (!["aborted/disposed", "aborted/parent", "interrupted", "aborted/user"].includes(k)) continue;
    const after = ev.slice(i + 1).map((x) => x.type);
    rows.push({ t: new Date(e.time).toISOString(), id: id.slice(0, 16), parent: h.parentSession?.slice(0, 16) ?? "-", origin: h.origin ?? "-", k, src, after: after.slice(0, 6).join(",") + (after.length > 6 ? `,+${after.length - 6}` : "") });
  }
}
rows.sort((a, b) => a.t.localeCompare(b.t));
for (const r of rows) console.log(r.t, r.id, "parent=" + r.parent, r.origin, r.k, "src=" + r.src, "| after:", r.after);
