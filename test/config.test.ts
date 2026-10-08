import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const saved = { ...process.env };
  beforeEach(() => Object.assign(process.env, { SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x', PM_SLACK_USER_ID: 'U0123456', VAULT_REPO: 'a/b' }));
  afterEach(() => { process.env = { ...saved }; });

  it('treats a missing repos.yaml as no repos', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    writeFileSync(join(dir, 'teams.yaml'), 'teams: []\n');
    writeFileSync(join(dir, 'hosts.yaml'), 'hosts: []\n');
    expect(loadConfig(dir).repos).toEqual([]);
  });
});

describe('PM_SLACK_USER_ID validation', () => {
  const base = { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1', VAULT_REPO: 'a/b' };
  const load = (extra: Record<string, string | undefined>) => {
    const saved = { ...process.env };
    process.env = { ...base, ...extra } as any;
    try { return loadConfig(); } finally { process.env = saved; }
  };
  it('fails clearly when missing or malformed', () => {
    expect(() => load({})).toThrow(/PM_SLACK_USER_ID/);
    expect(() => load({ PM_SLACK_USER_ID: '@pm' })).toThrow(/PM_SLACK_USER_ID/);
  });
  it('accepts a member id and defaults the reminder interval', () => {
    expect(load({ PM_SLACK_USER_ID: 'U0123456' }).env.QUESTION_REMINDER_MS).toBe(1_800_000);
  });
});
