import { simpleGit } from 'simple-git';
import type { Repos } from '../config.js';
import type { Db } from './db.js';

const GH_LINK = /github\.com[/:]([\w.-]+)\/([\w.-]+)/gi;

/** Pull unique "owner/repo" slugs out of any GitHub links in a message (https, ssh, .git, /tree/..., Slack <url|label>). */
export function parseGithubRepos(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(GH_LINK)) {
    const repo = m[2]!.replace(/\.git$/i, '');
    if (repo) found.add(`${m[1]}/${repo}`);
  }
  return [...found];
}

async function defaultBranch(github: string): Promise<string> {
  try {
    const out = await simpleGit().listRemote(['--symref', `https://github.com/${github}.git`, 'HEAD']);
    return /ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(out)?.[1] ?? 'main';
  } catch {
    return 'main';
  }
}

/**
 * Register any new repos from GitHub links. Mutates `repos` in place (Worktrees and the agent prompts share this
 * array) and persists to sqlite, since config/ is mounted read-only. Returns the repos that were newly added.
 */
export async function addReposFromText(text: string, repos: Repos, db: Db, resolveBranch = defaultBranch): Promise<Repos> {
  const added: Repos = [];
  for (const github of parseGithubRepos(text)) {
    if (repos.some((r) => r.github.toLowerCase() === github.toLowerCase())) continue;
    const [owner, short] = github.split('/') as [string, string];
    const name = repos.some((r) => r.name === short) ? `${owner}-${short}` : short;
    const repo = { name, github, default_branch: await resolveBranch(github), teams: [] as string[] };
    repos.push(repo);
    db.putRepo({ name, github, default_branch: repo.default_branch });
    added.push(repo);
  }
  return added;
}

/** On startup, merge repos added via Slack into the ones from config/repos.yaml. */
export function loadStoredRepos(repos: Repos, db: Db) {
  for (const r of db.listRepos()) if (!repos.some((x) => x.name === r.name)) repos.push({ ...r, teams: [] });
}
