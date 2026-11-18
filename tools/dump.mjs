// usage: node tools/dump.mjs <session dir or file> [summary|raw]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { join } from "node:path";
let p = process.argv[2];
if (statSync(p).isDirectory()) p = join(p, readdirSync(p).find((f) => f.startsWith("session.v")));
let buf = readFileSync(p);
if (p.endsWith(".zstd")) {
  const parts = []; let off = 0;
  while (off + 5 < buf.length) {
    const start = off; off += 4; const d = buf.readUInt8(off); off += 1;
    const fcs = d >>> 6, single = (d & 32) !== 0, ck = (d & 4) !== 0, dict = d & 3;
    off += (single ? 0 : 1) + (dict === 3 ? 4 : dict) + (fcs === 0 ? (single ? 1 : 0) : 1 << fcs);
    for (;;) { const h = buf.readUIntLE(off, 3); off += 3; const t = (h >>> 1) & 3; off += t === 1 ? 1 : h >>> 3; if (h & 1) break; }
    if (ck) off += 4;
    parts.push(zstdDecompressSync(buf.subarray(start, off)));
  }
  buf = Buffer.concat(parts);
}
const lines = buf.toString("utf8").split("\n").filter(Boolean);
const mode = process.argv[3] ?? "summary";
for (const [i, l] of lines.entries()) {
  if (mode === "raw") { console.log(l); continue; }
  const e = JSON.parse(l);
  if (i === 0) { console.log("HEADER", l.slice(0, 1200)); continue; }
  const d = e.data ?? {};
  let extra = "";
  if (e.type === "turn/end" || e.type === "turn/start") extra = JSON.stringify(d).slice(0, 400);
  else if (e.type === "message/append" || e.type?.startsWith("agent/inbox")) extra = JSON.stringify(d).slice(0, 250);
  console.log(e.seq ?? i, e.time ?? e.ts ?? "", e.type, extra);
}
