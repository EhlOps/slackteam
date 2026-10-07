import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { Repos } from '../config.js';

export class Worktrees {
  constructor(private dataDir: string, private repos: Repos) {}

  repo(name: string) {
    const r = this.repos.find((x) => x.name === name);
    if (!r) throw new Error(`Unknown repo "${name}". Known: ${this.repos.map((x) => x.name).join(', ')}`);
    return r;
  }

  /** Clone (or fetch) the main checkout, then add a worktree on a fresh branch for one SWE. */
  async create(repoName: string, jobId: number, swe: string, slug: string): Promise<{ path: string; branch: string }> {
    const r = this.repo(repoName);
    const main = join(this.dataDir, 'repos', r.name);
    if (!existsSync(join(main, '.git'))) {
      mkdirSync(join(this.dataDir, 'repos'), { recursive: true });
      await simpleGit().clone(`https://github.com/${r.github}.git`, main);
    } else {
      await simpleGit(main).fetch('origin');
    }
    const path = join(this.dataDir, 'worktrees', String(jobId), `${swe.toLowerCase()}-${r.name}`);
    const branch = `job-${String(jobId).padStart(4, '0')}/${swe.toLowerCase()}-${slug}`;
    if (!existsSync(path)) {
      mkdirSync(join(this.dataDir, 'worktrees', String(jobId)), { recursive: true });
      await simpleGit(main).raw(['worktree', 'add', '-b', branch, path, `origin/${r.default_branch}`]);
    }
    return { path, branch };
  }

  async remove(repoName: string, path: string) {
    await simpleGit(join(this.dataDir, 'repos', repoName)).raw(['worktree', 'remove', '--force', path]).catch(() => undefined);
  }
}
