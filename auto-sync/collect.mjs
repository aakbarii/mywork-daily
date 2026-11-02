#!/usr/bin/env node
/**
 * Collects everything done "today" across all local projects and prints JSON.
 *
 *   node collect.mjs                 # today
 *   node collect.mjs --date 2026-10-30
 *   node collect.mjs --roots "C:/Users/amin/Desktop,C:/Users/amin/Desktop/MyWork"
 *
 * Sources
 *  1. git: commits since 00:00 of the day + uncommitted changes, per repo
 *  2. Claude Code transcripts (the .jsonl files under ~/.claude/projects):
 *     the user's prompts that day, grouped per project (cwd), with first/last message
 *     time and active spans (gap > 15 min starts a new span)
 * No network, read-only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, [])
);

const now = new Date();
const [y, m, d] = (args.date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/)?.slice(1).map(Number) ?? [
  now.getFullYear(),
  now.getMonth() + 1,
  now.getDate(),
];
const dayStart = new Date(y, m - 1, d, 0, 0, 0);
const dayEnd = new Date(y, m - 1, d + 1, 0, 0, 0);
const GAP_MS = 15 * 60 * 1000;

const home = os.homedir();
const roots = (args.roots || process.env.PROJECT_ROOTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (!roots.length) roots.push(path.join(home, "Desktop"), path.join(home, "Desktop", "MyWork"));

const norm = (p) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
const hhmm = (t) =>
  new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/* ---------- 1. git repos ---------- */
function git(cwd, ...a) {
  try {
    return execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", timeout: 30000 }).trim();
  } catch {
    return "";
  }
}

function findRepos() {
  const found = new Map();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const candidates = [root, ...fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => path.join(root, e.name))];
    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, ".git"))) found.set(norm(dir), dir);
    }
  }
  return [...found.values()];
}

const author = args.author || git(roots[0] || ".", "config", "user.name");

function repoReport(dir) {
  const commits = git(
    dir, "log", "--all", `--since=${dayStart.toISOString()}`, `--until=${dayEnd.toISOString()}`,
    "--format=%h|%ad|%an|%s", "--date=format:%H:%M"
  )
    .split("\n").filter(Boolean)
    .map((l) => {
      const [hash, time, who, ...subject] = l.split("|");
      return { hash, time, author: who, subject: subject.join("|") };
    })
    .filter((c) => !author || c.author === author);

  const status = git(dir, "status", "--porcelain")
    .split("\n").filter(Boolean)
    .map((l) => ({ state: l.slice(0, 2).trim() || "?", file: l.slice(3) }));

  // Only files really touched that day (mtime) — the tree may hold old pending work
  const touched = status
    .filter((s) => {
      try {
        const st = fs.statSync(path.join(dir, s.file.replace(/^"|"$/g, "")));
        return st.mtimeMs >= dayStart.getTime() && st.mtimeMs < dayEnd.getTime();
      } catch {
        return s.state === "D";
      }
    })
    .map((s) => `${s.state} ${s.file}`);

  return {
    name: path.basename(dir),
    path: dir,
    branch: git(dir, "branch", "--show-current"),
    commits,
    uncommittedTotal: status.length,
    touchedToday: touched.slice(0, 40),
    touchedTodayCount: touched.length,
  };
}

/* ---------- 2. Claude Code transcripts ---------- */
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c?.type === "text").map((c) => c.text).join(" ");
  }
  return "";
}

function transcriptReport() {
  const base = path.join(home, ".claude", "projects");
  const byCwd = new Map();
  if (!fs.existsSync(base)) return [];

  for (const dir of fs.readdirSync(base)) {
    const full = path.join(base, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full).filter((n) => n.endsWith(".jsonl"))) {
      const fp = path.join(full, f);
      if (fs.statSync(fp).mtimeMs < dayStart.getTime()) continue;
      for (const line of fs.readFileSync(fp, "utf8").split("\n")) {
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        const t = Date.parse(o.timestamp);
        if (!(t >= dayStart.getTime() && t < dayEnd.getTime())) continue;
        if (o.type !== "user" && o.type !== "assistant") continue;
        const key = o.cwd || dir;
        const rec = byCwd.get(key) || { cwd: key, stamps: [], prompts: [] };
        rec.stamps.push(t);
        if (o.type === "user" && !o.isMeta) {
          const txt = textOf(o.message?.content).replace(/\s+/g, " ").trim();
          if (txt && !txt.startsWith("<") && !/^\[Request interrupted/.test(txt)) {
            rec.prompts.push({ t, text: txt.slice(0, 160) });
          }
        }
        byCwd.set(key, rec);
      }
    }
  }

  return [...byCwd.values()].map((r) => {
    r.stamps.sort((a, b) => a - b);
    const spans = [];
    let s = r.stamps[0], p = r.stamps[0];
    for (const t of r.stamps.slice(1)) {
      if (t - p > GAP_MS) { spans.push([s, p]); s = t; }
      p = t;
    }
    spans.push([s, p]);
    r.prompts.sort((a, b) => a.t - b.t);
    return {
      project: path.basename(String(r.cwd).replace(/[\\/]+$/, "")),
      cwd: r.cwd,
      first: hhmm(r.stamps[0]),
      last: hhmm(r.stamps[r.stamps.length - 1]),
      spans: spans.map(([a, b]) => `${hhmm(a)}-${hhmm(b)}`),
      activeMinutes: Math.round(spans.reduce((n, [a, b]) => n + (b - a), 0) / 60000),
      promptCount: r.prompts.length,
      prompts: r.prompts.map((x) => `${hhmm(x.t)} ${x.text}`).slice(0, 60),
    };
  });
}

/* ---------- output ---------- */
const repos = findRepos().map(repoReport);
const sessions = transcriptReport();
const repoByPath = new Map(repos.map((r) => [norm(r.path), r]));

const projects = new Map();
for (const r of repos) projects.set(norm(r.path), { name: r.name, git: r, sessions: [] });
for (const s of sessions) {
  const key = norm(s.cwd);
  const hit = [...projects.keys()].find((k) => key === k || key.startsWith(k + "/")) || key;
  const entry = projects.get(hit) || { name: s.project, git: repoByPath.get(hit) || null, sessions: [] };
  entry.sessions.push(s);
  projects.set(hit, entry);
}

const result = {
  date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
  generatedAt: now.toISOString(),
  author,
  projects: [...projects.values()]
    .filter((p) => (p.git?.commits.length || p.git?.touchedTodayCount) || p.sessions.length)
    .sort((a, b) => (b.sessions.reduce((n, s) => n + s.activeMinutes, 0)) - (a.sessions.reduce((n, s) => n + s.activeMinutes, 0))),
  idleRepos: repos
    .filter((r) => !projects.get(norm(r.path)) || !(r.commits.length || r.touchedTodayCount || sessions.some((s) => norm(s.cwd).startsWith(norm(r.path)))))
    .map((r) => r.name),
};

console.log(JSON.stringify(result, null, 2));
