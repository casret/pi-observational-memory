#!/usr/bin/env node
// Plan (default) or apply the one-time move of legacy `<project>/.memory/<sessionId>/` roots to
// the session-adjacent layout `~/.pi/agent/sessions/<slug>/<ts>_<sessionId>.memory/`.
//
//   node scripts/migrate-memory.mjs            list what would happen; changes nothing
//   node scripts/migrate-memory.mjs --apply    move MOVE entries, repoint/remove index links
//   --live-minutes N   treat sessions whose transcript changed within N minutes as live (default 30)
//   --json             machine-readable plan
//
// Never deleted or merged: conflicts (both roots exist), non-empty orphans (memory with no
// transcript), and anything that may be live (recent transcript activity or a process cwd inside
// the root). Those are listed for a human. EMPTY orphans (OM creates a root at session start even
// when Pi never persists the transcript) contain nothing and are removed with --apply. `.runs/` (transient worker IPC) is dropped when a root moves.
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const JSON_OUT = args.includes("--json");
const liveIdx = args.indexOf("--live-minutes");
const LIVE_MS = (liveIdx >= 0 ? Number(args[liveIdx + 1]) : 30) * 60_000;

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const sessionsDir = join(agentDir, "sessions");
const indexDir = join(agentDir, "om-memory");

function du(path) {
	let total = 0;
	let runs = 0;
	const walk = (p, inRuns) => {
		let st;
		try {
			st = lstatSync(p);
		} catch {
			return;
		}
		if (st.isDirectory()) {
			for (const e of readdirSync(p)) walk(join(p, e), inRuns || e === ".runs");
		} else {
			total += st.size;
			if (inRuns) runs += st.size;
		}
	};
	walk(path, false);
	return { total, runs };
}
const human = (n) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}M` : n > 1 << 10 ? `${(n / 1024).toFixed(0)}K` : `${n}B`);

function header(file) {
	try {
		const h = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]);
		return typeof h?.id === "string" ? h : undefined;
	} catch {
		return undefined;
	}
}

// Process cwds, to avoid moving a root an old-code session's worker is writing into.
const procCwds = [];
for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
	try {
		procCwds.push(readlinkSync(`/proc/${pid}/cwd`));
	} catch {}
}
const busyIn = (root) => procCwds.some((c) => c === root || c.startsWith(`${root}/`));

// 1. Every transcript: where its memory should be, and where legacy memory would be.
const transcripts = new Map(); // sessionId -> { file, cwd, target, legacy }
const cwds = new Set();
for (const slug of existsSync(sessionsDir) ? readdirSync(sessionsDir) : []) {
	const dir = join(sessionsDir, slug);
	let files;
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		continue;
	}
	for (const f of files) {
		const file = join(dir, f);
		const h = header(file);
		if (!h) continue;
		const cwd = typeof h.cwd === "string" ? h.cwd : undefined;
		if (cwd) cwds.add(cwd);
		transcripts.set(h.id, {
			file,
			cwd,
			target: file.replace(/\.jsonl$/, ".memory"),
			legacy: cwd ? join(cwd, ".memory", h.id) : undefined,
		});
	}
}

// 2. Index links (also reveal legacy roots in cwds with no surviving transcript).
const links = [];
for (const e of existsSync(indexDir) ? readdirSync(indexDir) : []) {
	const path = join(indexDir, e);
	try {
		if (!lstatSync(path).isSymbolicLink()) continue;
		const target = resolve(indexDir, readlinkSync(path));
		links.push({ path, target });
		const m = target.match(/^(.*)\/\.memory\/[^/]+$/);
		if (m) cwds.add(m[1]);
	} catch {}
}

// 3. Classify every legacy root found under a known cwd.
const plan = { move: [], conflict: [], live: [], orphan: [], emptyOrphan: [], danglingLinks: [], relink: [] };
const now = Date.now();
for (const cwd of cwds) {
	const base = join(cwd, ".memory");
	let entries;
	try {
		entries = readdirSync(base, { withFileTypes: true });
	} catch {
		continue;
	}
	for (const d of entries) {
		if (!d.isDirectory()) continue;
		const legacy = join(base, d.name);
		const t = transcripts.get(d.name);
		const size = du(legacy);
		const item = { legacy, sessionId: d.name, size: size.total, runs: size.runs };
		if (!t) {
			const o = { ...item, mtime: statSync(legacy).mtimeMs };
			(size.total === 0 && !busyIn(legacy) ? plan.emptyOrphan : plan.orphan).push(o);
			continue;
		}
		item.target = t.target;
		item.transcript = t.file;
		const recent = now - statSync(t.file).mtimeMs < LIVE_MS;
		if (existsSync(t.target)) plan.conflict.push(item);
		else if (recent || busyIn(legacy)) plan.live.push({ ...item, reason: busyIn(legacy) ? "process cwd inside" : "transcript active recently" });
		else plan.move.push(item);
	}
}
// New-layout roots whose transcript is gone (deleted session, or never persisted).
for (const slug of existsSync(sessionsDir) ? readdirSync(sessionsDir) : []) {
	const dir = join(sessionsDir, slug);
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		continue;
	}
	for (const d of entries) {
		if (!d.isDirectory() || !d.name.endsWith(".memory")) continue;
		const root = join(dir, d.name);
		if (existsSync(root.replace(/\.memory$/, ".jsonl"))) continue;
		const size = du(root);
		const o = { legacy: root, sessionId: d.name, size: size.total, runs: size.runs, mtime: statSync(root).mtimeMs };
		// A just-started session has no transcript yet: never treat a fresh root as an orphan.
		if (now - o.mtime < LIVE_MS || busyIn(root)) continue;
		(size.total === 0 ? plan.emptyOrphan : plan.orphan).push(o);
	}
}
const movedFrom = new Map(plan.move.map((m) => [m.legacy, m.target]));
for (const l of links) {
	if (movedFrom.has(l.target)) plan.relink.push({ ...l, to: movedFrom.get(l.target) });
	else if (!existsSync(l.target)) plan.danglingLinks.push(l);
}

if (JSON_OUT) {
	console.log(JSON.stringify({ apply: APPLY, ...plan }, null, 2));
} else {
	const sum = (xs, k) => human(xs.reduce((a, x) => a + x[k], 0));
	console.log(`${APPLY ? "APPLY" : "PLAN (dry run; pass --apply to act)"} — ${transcripts.size} transcripts, ${cwds.size} project dirs scanned\n`);
	console.log(`MOVE ${plan.move.length} (${sum(plan.move, "size")}, of which .runs ${sum(plan.move, "runs")} dropped)`);
	for (const m of plan.move) console.log(`  ${m.legacy}\n    -> ${m.target}`);
	console.log(`\nSKIP-LIVE ${plan.live.length} (session may still be running old code; /reload it or rerun later)`);
	for (const m of plan.live) console.log(`  ${m.legacy}  [${m.reason}]`);
	console.log(`\nCONFLICT ${plan.conflict.length} (both legacy and new roots exist; resolve by hand)`);
	for (const m of plan.conflict) console.log(`  ${m.legacy}\n    vs ${m.target}`);
	console.log(`\nEMPTY-ORPHAN ${plan.emptyOrphan.length} (no transcript, no files; removed with --apply)`);
	console.log(`\nORPHAN ${plan.orphan.length} (memory with no transcript; kept — decide per entry)`);
	for (const m of plan.orphan) console.log(`  ${m.legacy}  ${human(m.size)}  last ${new Date(m.mtime).toISOString().slice(0, 10)}`);
	console.log(`\nINDEX links: repoint ${plan.relink.length}, remove dangling ${plan.danglingLinks.length}`);
	for (const l of plan.danglingLinks) console.log(`  dangling ${basename(l.path)} -> ${l.target}`);
}

if (!APPLY) process.exit(0);

function move(src, dest) {
	mkdirSync(dirname(dest), { recursive: true });
	rmSync(join(src, ".runs"), { recursive: true, force: true });
	try {
		renameSync(src, dest);
		return;
	} catch (e) {
		if (e.code !== "EXDEV") throw e;
	}
	const tmp = `${dest}.migrate-tmp-${process.pid}`;
	cpSync(src, tmp, { recursive: true });
	renameSync(tmp, dest);
	rmSync(src, { recursive: true, force: true });
}

let failures = 0;
for (const m of plan.move) {
	try {
		if (existsSync(m.target)) throw new Error("target appeared");
		move(m.legacy, m.target);
		try {
			if (readdirSync(dirname(m.legacy)).length === 0) rmdirSync(dirname(m.legacy));
		} catch {}
	} catch (e) {
		failures++;
		console.error(`FAILED ${m.legacy}: ${e.message}`);
	}
}
for (const l of plan.relink) {
	try {
		unlinkSync(l.path);
		symlinkSync(l.to, l.path, "dir");
	} catch (e) {
		failures++;
		console.error(`FAILED relink ${l.path}: ${e.message}`);
	}
}
for (const o of plan.emptyOrphan) {
	try {
		rmSync(o.legacy, { recursive: true, force: true });
		if (basename(dirname(o.legacy)) === ".memory" && readdirSync(dirname(o.legacy)).length === 0) rmdirSync(dirname(o.legacy));
	} catch {}
}
for (const l of plan.danglingLinks) {
	try {
		unlinkSync(l.path);
	} catch {}
}
if (!JSON_OUT) console.log(`\ndone: moved ${plan.move.length - failures}, failures ${failures}`);
process.exit(failures ? 1 : 0);
