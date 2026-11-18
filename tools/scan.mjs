// usage: node tools/scan.mjs <DSH_HOME>/sessions [days=4]: the distinct shapes of turn/end events, with one example each
import { readdirSync, statSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const DUMP = new URL("./dump.mjs", import.meta.url).pathname;
const root = process.argv[2]; const days = Number(process.argv[3] ?? 4);
const shapes = new Map();
for (const ws of readdirSync(root)) for (const id of readdirSync(join(root, ws))) {
  const dir = join(root, ws, id);
  try { if (Date.now() - statSync(dir).mtimeMs > days * 864e5) continue; } catch { continue; }
  let out; try { out = execFileSync("node", [DUMP, dir, "raw"], { maxBuffer: 1 << 30 }).toString(); } catch { continue; }
  for (const l of out.split("\n").filter(Boolean)) {
    const e = JSON.parse(l);
    if (e.type !== "turn/end") continue;
    const d = e.data ?? {};
    const key = JSON.stringify({ kind: d.kind, r: d.reason?.kind, rr: d.reason?.reason?.kind ?? d.reason?.cause?.kind, keys: Object.keys(d).sort(), rkeys: d.reason ? Object.keys(d.reason).sort() : [] });
    if (!shapes.has(key)) shapes.set(key, { n: 0, ex: l.slice(0, 700), id });
    shapes.get(key).n++;
  }
}
for (const [k, v] of shapes) console.log(v.n, k, "\n   ", v.id, v.ex, "\n");
