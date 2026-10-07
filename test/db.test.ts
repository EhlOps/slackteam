import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Interactions } from '../src/slack/interactions.js';
import { openDb } from '../src/workflow/db.js';

const fakeClient = (() => {
  let n = 0;
  return { chat: { postMessage: async () => ({ ts: `1.${++n}` }) } } as any;
})();
const mk = () => openDb(join(mkdtempSync(join(tmpdir(), 'st-')), 'x.sqlite'));

describe('db + interactions', () => {
  it('persists jobs, sessions and workdirs', () => {
    const db = mk();
    const id = db.createJob('demo', 'goal');
    db.setChannel(id, 'C1');
    db.putSession(id, 'EM', 'sess-1');
    db.putWorkdir({ job_id: id, agent: 'SWE-1', repo: 'r', path: '/p', branch: 'b', workstream: 'w' });
    expect(db.jobByChannel('C1')?.slug).toBe('demo');
    expect(db.getSession(id, 'EM')).toBe('sess-1');
    expect(db.getWorkdir(id, 'SWE-1')?.approved).toBe(0);
    db.setApproved(id, 'SWE-1', true);
    expect(db.getWorkdir(id, 'SWE-1')?.approved).toBe(1);
  });

  it('ask() resolves when the PM replies in the thread', async () => {
    const db = mk();
    const i = new Interactions(fakeClient, db, 60_000);
    const p = i.ask(null, 'EM', 'C1', 'which db?');
    await new Promise((r) => setTimeout(r, 5));
    const hit = i.handleReply('C1', '1.1', 'postgres');
    expect(hit?.orphaned).toBe(false);
    expect(await p).toBe('postgres');
  });

  it('flags a reply as orphaned when no agent is waiting (after restart)', () => {
    const db = mk();
    db.addPending({ job_id: 1, kind: 'question', agent: 'SWE-1', channel_id: 'C1', message_ts: '9.9', prompt: 'q' });
    const i = new Interactions(fakeClient, db, 60_000);
    expect(i.handleReply('C1', '9.9', 'a')?.orphaned).toBe(true);
    expect(i.handleReply('C1', '9.9', 'again')).toBeUndefined(); // already answered
  });

  it('approval buttons resolve to boolean and time out to denied', async () => {
    const db = mk();
    const i = new Interactions(fakeClient, db, 20);
    const ok = i.approve(null, 'SWE-1', 'C1', 'rm -rf x', 'why');
    await new Promise((r) => setTimeout(r, 5));
    expect(i.handleButton('C1', '1.2', 'approve')).toBe(true);
    expect(await ok).toBe(true);
    expect(await i.approve(null, 'SWE-1', 'C1', 'sudo x', 'why')).toBe(false); // times out
  });
});
