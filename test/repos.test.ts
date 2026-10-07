import { describe, expect, it } from 'vitest';
import { openDb } from '../src/workflow/db.js';
import { addReposFromText, loadStoredRepos, parseGithubRepos } from '../src/workflow/repos.js';
import type { Repos } from '../src/config.js';

describe('parseGithubRepos', () => {
  it('handles common link shapes', () => {
    expect(parseGithubRepos('<https://github.com/acme/api>')).toEqual(['acme/api']);
    expect(parseGithubRepos('<https://github.com/acme/api|api>')).toEqual(['acme/api']);
    expect(parseGithubRepos('git@github.com:acme/api.git')).toEqual(['acme/api']);
    expect(parseGithubRepos('https://github.com/acme/api/pull/12 and https://github.com/acme/web/tree/dev')).toEqual(['acme/api', 'acme/web']);
    expect(parseGithubRepos('no links here')).toEqual([]);
  });
});

describe('addReposFromText', () => {
  const mk = () => ({ db: openDb(':memory:'), repos: [] as Repos });
  it('adds, persists, dedupes and reloads', async () => {
    const { db, repos } = mk();
    const added = await addReposFromText('look at https://github.com/acme/api', repos, db, async () => 'develop');
    expect(added).toHaveLength(1);
    expect(repos[0]).toMatchObject({ name: 'api', github: 'acme/api', default_branch: 'develop' });
    expect(await addReposFromText('https://github.com/Acme/API again', repos, db, async () => 'main')).toHaveLength(0);
    const fresh: Repos = [];
    loadStoredRepos(fresh, db);
    expect(fresh.map((r) => r.github)).toEqual(['acme/api']);
  });
  it('disambiguates name collisions', async () => {
    const { db, repos } = mk();
    repos.push({ name: 'api', github: 'acme/api', default_branch: 'main', teams: [] });
    await addReposFromText('https://github.com/other/api', repos, db, async () => 'main');
    expect(repos.map((r) => r.name)).toEqual(['api', 'other-api']);
  });
});
