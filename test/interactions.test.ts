import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Interactions } from '../src/slack/interactions.js';
import { acknowledgeClosures, isPmMessage } from '../src/slack/router.js';
import { openDb, type Pending } from '../src/workflow/db.js';

const PM = 'U0PM1234';
const REM = 1000;

function setup(reactionsFail = false) {
  const posts: any[] = [];
  const reactions: any[] = [];
  let n = 0;
  const client: any = {
    chat: { postMessage: vi.fn(async (a: any) => (posts.push(a), { ts: `100.${++n}` })) },
    reactions: {
      add: vi.fn(async (a: any) => {
        if (reactionsFail) throw new Error('missing_scope');
        reactions.push(a);
        return {};
      }),
    },
  };
  const db = openDb(':memory:');
  const ix = new Interactions(client, db, 60 * 60_000, PM, REM);
  return { posts, reactions, client, db, ix };
}
const reminders = (posts: any[]) => posts.filter((p) => /still waiting/.test(p.text));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('R1 mentions', () => {
  it('ask starts with the PM mention', async () => {
    const { posts, ix } = setup();
    void ix.ask(null, 'SWE-2', 'C1', 'which db?');
    await vi.advanceTimersByTimeAsync(0);
    expect(posts[0].text.startsWith(`<@${PM}> `)).toBe(true);
  });
  it('approval text and block mention the PM', async () => {
    const { posts, ix } = setup();
    void ix.approve(null, 'SWE-2', 'C1', 'rm -rf x', 'cleanup');
    await vi.advanceTimersByTimeAsync(0);
    expect(posts[0].text).toContain(`<@${PM}>`);
    expect(posts[0].blocks[0].text.text.startsWith(`<@${PM}>`)).toBe(true);
  });
  it('rejects a malformed PM id instead of posting <@undefined>', () => {
    const { client, db } = setup();
    expect(() => new Interactions(client, db, 1, undefined as any)).toThrow();
    expect(() => new Interactions(client, db, 1, '@pm')).toThrow();
  });
});

describe('R4 thread replies', () => {
  it('resolve the question they are attached to only', async () => {
    const { ix } = setup();
    const p = ix.ask(null, 'SWE-2', 'C1', 'q1');
    await vi.advanceTimersByTimeAsync(0);
    expect(ix.handleReply('C1', '999.9', 'x')).toBeUndefined();
    expect(ix.handleReply('C1', '100.1', 'sqlite')?.pending.prompt).toBe('q1');
    await expect(p).resolves.toBe('sqlite');
  });
});

describe('R8 acknowledgement', () => {
  const rows = (db: any): Pending[] => [
    { id: 1, job_id: 1, kind: 'question', agent: 'SWE-2', channel_id: 'C1', message_ts: '1.1', prompt: 'first question', answer: 'a' },
    { id: 2, job_id: 1, kind: 'question', agent: 'SWE-2', channel_id: 'C1', message_ts: '1.2', prompt: 'second question', answer: 'a' },
  ];
  it('posts one message listing closed questions and reacts', async () => {
    const { posts, reactions, ix, db } = setup();
    await ix.acknowledgeClosed('C1', rows(db), '2.0');
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain('first question');
    expect(posts[0].text).toContain('second question');
    expect(reactions.map((r) => r.timestamp).sort()).toEqual(['1.1', '1.2', '2.0']);
  });
  it('still posts the message when reactions:write is missing', async () => {
    const { posts, ix, db } = setup(true);
    await expect(ix.acknowledgeClosed('C1', rows(db), '2.0')).resolves.toBeUndefined();
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain('Closed 2 questions');
  });
  it('router helper calls acknowledgeClosed once for many closed, never for none', async () => {
    const spy = vi.fn(async () => undefined);
    const { db } = setup();
    await acknowledgeClosures({ acknowledgeClosed: spy }, 'C1', rows(db), '2.0');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('C1', rows(db), '2.0');
    await acknowledgeClosures({ acknowledgeClosed: spy }, 'C1', [], '3.0');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('R9 reminders', () => {
  it('re-mentions the PM, capped at 3', async () => {
    const { posts, ix } = setup();
    void ix.ask(null, 'SWE-2', 'C1', 'q');
    await vi.advanceTimersByTimeAsync(REM * 10);
    const r = reminders(posts);
    expect(r).toHaveLength(3);
    expect(r[0].text).toContain(`<@${PM}>`);
    expect(r[0].thread_ts).toBe('100.1');
  });
  it('stops when resolved via resolve()', async () => {
    const { posts, ix } = setup();
    void ix.ask(null, 'SWE-2', 'C1', 'q');
    await vi.advanceTimersByTimeAsync(0);
    ix.resolve(1, 'done');
    await vi.advanceTimersByTimeAsync(REM * 5);
    expect(reminders(posts)).toHaveLength(0);
  });
  it('does not remind a pending closed directly in the db (matcher path)', async () => {
    const { posts, ix, db } = setup();
    void ix.ask(null, 'SWE-2', 'C1', 'q');
    await vi.advanceTimersByTimeAsync(0);
    db.answer(1, 'closed behind our back');
    await vi.advanceTimersByTimeAsync(REM * 5);
    expect(reminders(posts)).toHaveLength(0);
  });
  it('rearmReminders after restart creates no duplicate timers', async () => {
    const { posts, client, db } = setup();
    db.addPending({ job_id: null, kind: 'question', agent: 'SWE-2', channel_id: 'C1', message_ts: '5.5', prompt: 'old q' });
    const ix2 = new Interactions(client, db, 60 * 60_000, PM, REM);
    ix2.rearmReminders();
    ix2.rearmReminders();
    await vi.advanceTimersByTimeAsync(REM * 10);
    expect(reminders(posts)).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('R5 filter', () => {
  it('ignores bots, subtypes, and other users, including our own ack/reminder posts', () => {
    expect(isPmMessage({ user: PM, text: 'hi' }, PM)).toBe(true);
    expect(isPmMessage({ user: PM, text: 'hi', bot_id: 'B1' }, PM)).toBe(false);
    expect(isPmMessage({ text: 'Closed 1 question', bot_id: 'B1', subtype: 'bot_message' }, PM)).toBe(false);
    expect(isPmMessage({ user: 'U2', text: 'hi' }, PM)).toBe(false);
    expect(isPmMessage({ user: PM, text: 'hi', subtype: 'message_changed' }, PM)).toBe(false);
  });
});
