import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const saved = { ...process.env };
  beforeEach(() => Object.assign(process.env, { SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x', PM_SLACK_USER_ID: 'U1', VAULT_REPO: 'a/b' }));
  afterEach(() => { process.env = { ...saved }; });

  it('treats a missing repos.yaml as no repos', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    writeFileSync(join(dir, 'teams.yaml'), 'teams: []\n');
    writeFileSync(join(dir, 'hosts.yaml'), 'hosts: []\n');
    expect(loadConfig(dir).repos).toEqual([]);
  });
});
