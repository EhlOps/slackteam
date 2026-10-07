import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Vault } from '../src/vault/git.js';

describe('Vault', () => {
  it('writes a validated .json/.md pair, commits and pushes to the remote', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vault-'));
    const remote = join(root, 'remote.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
    const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    Object.assign(process.env, env);
    const v = new Vault(join(root, 'work'), remote);
    await v.sync();
    expect(v.nextPrdId()).toBe('PRD-0001');
    const prd = {
      id: 'PRD-0001', title: 'T', status: 'draft', teams: ['backend'], pm: 'PM', problem: 'p', goals: ['g'],
      requirements: [{ id: 'R1', text: 't', priority: 'must' }], acceptance_criteria: ['a'], created: '2026-10-07', updated: '2026-10-07',
    };
    const { files } = await v.write('prd', prd, 'demo');
    files.forEach((f) => expect(existsSync(f)).toBe(true));
    expect(readFileSync(files[1], 'utf8')).toContain('# PRD-0001: T');
    expect(v.nextPrdId()).toBe('PRD-0002');
    // update keeps the same filename pair
    const again = await v.write('prd', { ...prd, status: 'approved' }, 'other-slug');
    expect(again.files).toEqual(files);
    expect(execFileSync('git', ['--git-dir', remote, 'log', '--oneline']).toString().trim().split('\n')).toHaveLength(2);
    await expect(v.write('prd', { ...prd, requirements: [] }, 'bad')).rejects.toThrow();
  });
});
