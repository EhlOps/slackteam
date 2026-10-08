import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Interactions } from '../src/slack/interactions.js';
import { handlePmMessage } from '../src/slack/router.js';
import { openDb } from '../src/workflow/db.js';

const mk = () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'st-')), 'x.sqlite'));
  const posts: any[] = [];
  let n = 0;
  const client = { chat: { postMessage: async (o: any) => (posts.push(o), { ts: `1.${++n}` }) } } as any;
  return { db, posts, client };
};
const setup = (judgeOut: unknown) => {
  const { db, posts, client } = mk();
  const interactions = new Interactions(client, db, 60_000, { judge: async () => judgeOut, pm: 'UPM' });
  const jobId = db.createJob('j', 'g');
  db.setChannel(jobId, 'CJ');
  const send = vi.fn(async () => undefined);
  const ack = vi.spyOn(interactions, 'acknowledgeClosed');
  const ctx: any = { db, interactions, runner: { send }, cfg: { env: { PM_SLACK_USER_ID: 'UPM' }, repos: [] }, client, intakeChannel: 'CI' };
  return { db, posts, interactions, send, ack, ctx, jobId };
};
const tick = () => new Promise((r) => setTimeout(r, 5));
const msg = (text: string, extra = {}) => ({ user: 'UPM', text, channel: 'CJ', ts: '5.5', ...extra });

describe('top-level PM messages', () => {
  it('closes several questions with one message, leaves the rest, acks once', async () => {
    const s = setup({ outcome: 'answers', answers: [{ id: 1, answer_excerpt: 'pg' }, { id: 2, answer_excerpt: 'yes' }] });
    const p1 = s.interactions.ask(s.jobId, 'SWE-1', 'CJ', 'db?');
    const p2 = s.interactions.ask(s.jobId, 'SWE-1', 'CJ', 'ship?');
    s.interactions.ask(s.jobId, 'SWE-1', 'CJ', 'name?');
    await tick();
    await handlePmMessage(s.ctx, msg('pg, yes'));
    expect(await p1).toBe('pg');
    expect(await p2).toBe('yes');
    expect(s.db.openQuestionsByChannel('CJ')).toHaveLength(1);
    expect(s.ack).toHaveBeenCalledTimes(1);
    expect(s.send).not.toHaveBeenCalled();
  });
  it('partial answer re-asks only the remainder and keeps it open', async () => {
    const s = setup({ outcome: 'answers', answers: [{ id: 1, answer_excerpt: 'pg' }], remaining: [{ id: 2, missing: 'which region' }] });
    s.interactions.ask(s.jobId, 'SWE-1', 'CJ', 'db?');
    s.interactions.ask(s.jobId, 'SWE-1', 'CJ', 'deploy where?');
    await tick();
    await handlePmMessage(s.ctx, msg('pg; deploy somewhere'));
    expect(s.db.openQuestionsByChannel('CJ').map((p) => p.id)).toEqual([2]);
    const re = s.posts.find((x) => x.text.includes('Still need'));
    expect(re.text).toContain('<@UPM>');
    expect(re.text).toContain('which region');
    expect(re.thread_ts).toBeDefined();
  });
  it('ambiguous closes nothing, forwards nothing', async () => {
    const s = setup({ outcome: 'ambiguous' });
    s.interactions.ask(s.jobId, 'SWE-1', 'CJ', 'a?');
    s.interactions.ask(s.jobId, 'SWE-1', 'CJ', 'b?');
    await tick();
    await handlePmMessage(s.ctx, msg('yes'));
    expect(s.db.openQuestionsByChannel('CJ')).toHaveLength(2);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.ack).not.toHaveBeenCalled();
  });
  it('unrelated request with open questions passes through, nothing closed', async () => {
    const s = setup({ outcome: 'none' });
    s.interactions.ask(s.jobId, 'SWE-1', 'CJ', 'a?');
    s.interactions.ask(s.jobId, 'SWE-1', 'CJ', 'b?');
    await tick();
    await handlePmMessage(s.ctx, msg('also add dark mode'));
    expect(s.db.openQuestionsByChannel('CJ')).toHaveLength(2);
    expect(s.send).toHaveBeenCalledWith(s.jobId, 'EM', 'PM: also add dark mode', 'CJ');
  });
  it('no open questions -> normal request (R7)', async () => {
    const s = setup({ outcome: 'answers', answers: [] });
    await handlePmMessage(s.ctx, msg('build X'));
    expect(s.send).toHaveBeenCalledWith(s.jobId, 'EM', 'PM: build X', 'CJ');
  });
  it('thread reply resolves its question and acks', async () => {
    const s = setup({ outcome: 'none' });
    const p = s.interactions.ask(s.jobId, 'SWE-1', 'CJ', 'a?');
    await new Promise((r) => setTimeout(r, 5));
    await handlePmMessage(s.ctx, msg('yes', { thread_ts: '1.1' }));
    expect(await p).toBe('yes');
    expect(s.ack).toHaveBeenCalledTimes(1);
  });
  it('orphaned question (after restart) resumes the agent', async () => {
    const s = setup({ outcome: 'answers', answers: [{ id: 1, answer_excerpt: 'pg' }] });
    s.db.addPending({ job_id: s.jobId, kind: 'question', agent: 'SWE-1', channel_id: 'CJ', message_ts: '9.9', prompt: 'db?' });
    await handlePmMessage(s.ctx, msg('pg'));
    expect(s.send).toHaveBeenCalledWith(s.jobId, 'SWE-1', expect.stringContaining('A: pg'), 'CJ');
  });
  it('R5: bots, bot acks/reminders, other users and edits never close or forward', async () => {
    const s = setup({ outcome: 'answers', answers: [{ id: 1, answer_excerpt: 'x' }] });
    s.interactions.ask(s.jobId, 'SWE-1', 'CJ', 'a?');
    await tick();
    await handlePmMessage(s.ctx, msg('x', { user: 'UOTHER' }));
    await handlePmMessage(s.ctx, msg('x', { bot_id: 'B1' }));
    await handlePmMessage(s.ctx, msg('<@UPM> reminder: still waiting', { bot_id: 'B1', user: 'UPM' })); // bot reminder mentioning the PM
    await handlePmMessage(s.ctx, msg(':white_check_mark: Closed: a?', { subtype: 'bot_message' }));
    await handlePmMessage(s.ctx, msg('x', { subtype: 'message_changed' }));
    expect(s.db.openQuestionsByChannel('CJ')).toHaveLength(1);
    expect(s.send).not.toHaveBeenCalled();
  });
  it('race: a question closed by a thread reply is not closed or acked again', async () => {
    const s = setup({ outcome: 'answers', answers: [{ id: 1, answer_excerpt: 'late' }] });
    const p = s.interactions.ask(s.jobId, 'SWE-1', 'CJ', 'a?');
    await new Promise((r) => setTimeout(r, 5));
    const [r1, r2] = await Promise.all([s.interactions.handleChannelMessage('CJ', 'late'), Promise.resolve(s.interactions.handleReply('CJ', '1.1', 'first'))]);
    expect(await p).toBeDefined();
    expect((r1.closed.length) + (r2 ? 1 : 0)).toBe(1);
  });
});
