import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type JobState = 'intake' | 'okr_prd' | 'planning' | 'review' | 'implementing' | 'pr' | 'done' | 'cancelled';
export type AgentName = 'EM' | 'SWE-1' | 'SWE-2';

export interface Job {
  id: number;
  slug: string;
  channel_id: string | null;
  state: JobState;
  prd_id: string | null;
  goal: string;
  created_at: string;
}
export interface Workdir {
  job_id: number;
  agent: AgentName;
  repo: string;
  path: string;
  branch: string;
  workstream: string;
  tp_id: string | null;
  approved: number;
  pr: string | null;
}
export interface Pending {
  id: number;
  job_id: number | null;
  kind: 'question' | 'approval';
  agent: AgentName;
  channel_id: string;
  message_ts: string;
  prompt: string;
  answer: string | null;
}

export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, channel_id TEXT, state TEXT NOT NULL DEFAULT 'intake',
      prd_id TEXT, goal TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sessions (
      job_id INTEGER NOT NULL, agent TEXT NOT NULL, session_id TEXT, PRIMARY KEY (job_id, agent));
    CREATE TABLE IF NOT EXISTS pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER, kind TEXT NOT NULL, agent TEXT NOT NULL,
      channel_id TEXT NOT NULL, message_ts TEXT NOT NULL, prompt TEXT NOT NULL, answer TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS workdirs (
      job_id INTEGER NOT NULL, agent TEXT NOT NULL, repo TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL,
      workstream TEXT NOT NULL, tp_id TEXT, approved INTEGER NOT NULL DEFAULT 0, pr TEXT, PRIMARY KEY (job_id, agent));
    CREATE TABLE IF NOT EXISTS repos (
      name TEXT PRIMARY KEY, github TEXT NOT NULL, default_branch TEXT NOT NULL DEFAULT 'main');
    CREATE INDEX IF NOT EXISTS pending_msg ON pending (channel_id, message_ts);
  `);

  const q = {
    createJob: db.prepare('INSERT INTO jobs (slug, goal) VALUES (?, ?)'),
    getJob: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    jobByChannel: db.prepare('SELECT * FROM jobs WHERE channel_id = ?'),
    activeJobs: db.prepare("SELECT * FROM jobs WHERE state NOT IN ('done','cancelled')"),
    setChannel: db.prepare('UPDATE jobs SET channel_id = ? WHERE id = ?'),
    setState: db.prepare('UPDATE jobs SET state = ? WHERE id = ?'),
    setPrd: db.prepare('UPDATE jobs SET prd_id = ? WHERE id = ?'),
    getSession: db.prepare('SELECT session_id FROM sessions WHERE job_id = ? AND agent = ?'),
    putSession: db.prepare(
      'INSERT INTO sessions (job_id, agent, session_id) VALUES (?, ?, ?) ON CONFLICT (job_id, agent) DO UPDATE SET session_id = excluded.session_id'),
    addPending: db.prepare(
      'INSERT INTO pending (job_id, kind, agent, channel_id, message_ts, prompt) VALUES (?, ?, ?, ?, ?, ?)'),
    pendingByMsg: db.prepare('SELECT * FROM pending WHERE channel_id = ? AND message_ts = ? AND answer IS NULL'),
    openPending: db.prepare('SELECT * FROM pending WHERE answer IS NULL'),
    answer: db.prepare('UPDATE pending SET answer = ? WHERE id = ?'),
    putWorkdir: db.prepare(
      'INSERT OR REPLACE INTO workdirs (job_id, agent, repo, path, branch, workstream) VALUES (?, ?, ?, ?, ?, ?)'),
    getWorkdir: db.prepare('SELECT * FROM workdirs WHERE job_id = ? AND agent = ?'),
    jobWorkdirs: db.prepare('SELECT * FROM workdirs WHERE job_id = ?'),
    setTp: db.prepare('UPDATE workdirs SET tp_id = ? WHERE job_id = ? AND agent = ?'),
    setApproved: db.prepare('UPDATE workdirs SET approved = ? WHERE job_id = ? AND agent = ?'),
    setPr: db.prepare('UPDATE workdirs SET pr = ? WHERE job_id = ? AND agent = ?'),
    putRepo: db.prepare('INSERT OR REPLACE INTO repos (name, github, default_branch) VALUES (?, ?, ?)'),
    listRepos: db.prepare('SELECT name, github, default_branch FROM repos'),
  };

  return {
    raw: db,
    createJob: (slug: string, goal: string) => Number(q.createJob.run(slug, goal).lastInsertRowid),
    getJob: (id: number) => q.getJob.get(id) as Job | undefined,
    jobByChannel: (ch: string) => q.jobByChannel.get(ch) as Job | undefined,
    activeJobs: () => q.activeJobs.all() as Job[],
    setChannel: (id: number, ch: string) => void q.setChannel.run(ch, id),
    setState: (id: number, s: JobState) => void q.setState.run(s, id),
    setPrd: (id: number, prd: string) => void q.setPrd.run(prd, id),
    getSession: (job: number, agent: AgentName) => (q.getSession.get(job, agent) as { session_id: string | null } | undefined)?.session_id ?? undefined,
    putSession: (job: number, agent: AgentName, sid: string) => void q.putSession.run(job, agent, sid),
    addPending: (p: Omit<Pending, 'id' | 'answer'>) =>
      Number(q.addPending.run(p.job_id, p.kind, p.agent, p.channel_id, p.message_ts, p.prompt).lastInsertRowid),
    pendingByMsg: (ch: string, ts: string) => q.pendingByMsg.get(ch, ts) as Pending | undefined,
    openPending: () => q.openPending.all() as Pending[],
    answer: (id: number, a: string) => void q.answer.run(a, id),
    putWorkdir: (w: Omit<Workdir, 'tp_id' | 'approved' | 'pr'>) =>
      void q.putWorkdir.run(w.job_id, w.agent, w.repo, w.path, w.branch, w.workstream),
    getWorkdir: (job: number, agent: AgentName) => q.getWorkdir.get(job, agent) as Workdir | undefined,
    jobWorkdirs: (job: number) => q.jobWorkdirs.all(job) as Workdir[],
    setTp: (job: number, agent: AgentName, tp: string) => void q.setTp.run(tp, job, agent),
    setApproved: (job: number, agent: AgentName, ok: boolean) => void q.setApproved.run(ok ? 1 : 0, job, agent),
    setPr: (job: number, agent: AgentName, pr: string) => void q.setPr.run(pr, job, agent),
    putRepo: (r: { name: string; github: string; default_branch: string }) => void q.putRepo.run(r.name, r.github, r.default_branch),
    listRepos: () => q.listRepos.all() as { name: string; github: string; default_branch: string }[],
  };
}
export type Db = ReturnType<typeof openDb>;
