import type { WebClient } from '@slack/web-api';
import type { Db, AgentName, Pending } from '../workflow/db.js';
import { postAs } from './personas.js';

const MAX_REMINDERS = 3;
type Resolver = (answer: string) => void;

/** Parks agent tool calls until the PM answers in Slack. Survives restarts: pendings live in SQLite and are re-posted. */
export class Interactions {
  private waiters = new Map<number, Resolver>();
  private reminders = new Map<number, { timer: NodeJS.Timeout; count: number }>();
  constructor(
    private client: WebClient,
    private db: Db,
    private timeoutMs: number,
    private pmUserId: string,
    private reminderMs = 30 * 60_000,
  ) {
    if (!/^[UW][A-Z0-9]{2,}$/.test(pmUserId)) throw new Error(`Invalid PM Slack user id: ${JSON.stringify(pmUserId)}`);
  }

  private get mention() {
    return `<@${this.pmUserId}>`;
  }

  /** Arm (at most one) reminder chain for a pending item; re-@mentions the PM up to MAX_REMINDERS times. */
  private armReminder(p: Pick<Pending, 'id' | 'channel_id' | 'message_ts' | 'prompt' | 'kind'>, count = 0) {
    if (this.reminders.has(p.id) && count === 0) return;
    if (count >= MAX_REMINDERS) return void this.reminders.delete(p.id);
    const timer = setTimeout(() => {
      if (!this.db.openPending().some((x) => x.id === p.id)) return void this.clearReminder(p.id); // closed elsewhere
      const what = p.kind === 'approval' ? 'approval for' : 'an answer to';
      void postAs(this.client, 'EM', {
        channel: p.channel_id,
        thread_ts: p.message_ts,
        text: `${this.mention} still waiting on ${what}: ${p.prompt.slice(0, 200)}`,
      }).catch(() => undefined);
      this.armReminder(p, count + 1);
    }, this.reminderMs);
    timer.unref();
    this.reminders.set(p.id, { timer, count });
  }

  private clearReminder(id: number) {
    const r = this.reminders.get(id);
    if (r) clearTimeout(r.timer);
    this.reminders.delete(id);
  }

  /** After a restart, re-arm reminders for open pendings (idempotent: never duplicates timers). */
  rearmReminders() {
    for (const p of this.db.openPending()) this.armReminder(p);
  }

  private wait(pendingId: number, timeoutMs?: number): Promise<string> {
    return new Promise((resolve) => {
      this.waiters.set(pendingId, resolve);
      if (timeoutMs) setTimeout(() => this.resolve(pendingId, '__timeout__'), timeoutMs).unref();
    });
  }

  /** Resolve a pending item (idempotent). */
  resolve(pendingId: number, answer: string) {
    this.db.answer(pendingId, answer);
    this.clearReminder(pendingId);
    this.waiters.get(pendingId)?.(answer);
    this.waiters.delete(pendingId);
  }

  async ask(jobId: number | null, agent: AgentName, channel: string, question: string): Promise<string> {
    const ts = await postAs(this.client, agent, { channel, text: `${this.mention} :question: ${question}\n_Reply here or in this thread._` });
    const id = this.db.addPending({ job_id: jobId, kind: 'question', agent, channel_id: channel, message_ts: ts, prompt: question });
    this.armReminder({ id, channel_id: channel, message_ts: ts, prompt: question, kind: 'question' });
    return this.wait(id);
  }

  async approve(jobId: number | null, agent: AgentName, channel: string, action: string, reason: string): Promise<boolean> {
    const ts = await postAs(this.client, agent, {
      channel,
      text: `${this.mention} Approval needed: ${action}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `${this.mention} :warning: *Approval needed*\n\`\`\`${action.slice(0, 2500)}\`\`\`\n*Why:* ${reason}` } },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: 'approve', value: 'approve' },
            { type: 'button', text: { type: 'plain_text', text: 'Deny' }, style: 'danger', action_id: 'deny', value: 'deny' },
          ],
        },
      ],
    });
    const id = this.db.addPending({ job_id: jobId, kind: 'approval', agent, channel_id: channel, message_ts: ts, prompt: action });
    this.armReminder({ id, channel_id: channel, message_ts: ts, prompt: action, kind: 'approval' });
    return (await this.wait(id, this.timeoutMs)) === 'approve';
  }

  /**
   * A thread reply from the PM. Returns the answered question, or undefined if none matched.
   * `orphaned` is true when no live agent was waiting (e.g. the container restarted); the caller
   * must then resume that agent's session with the answer as a new message.
   */
  handleReply(channel: string, threadTs: string, text: string): { pending: Pending; orphaned: boolean } | undefined {
    const p = this.db.pendingByMsg(channel, threadTs);
    if (!p || p.kind !== 'question') return undefined;
    const orphaned = !this.waiters.has(p.id);
    this.resolve(p.id, text);
    return { pending: p, orphaned };
  }

  /**
   * Acknowledge questions that were just closed by one PM message: a reaction (best effort; needs the
   * reactions:write scope) plus one short message in the thread of the first closed question. Never throws.
   */
  async acknowledgeClosed(channel: string, closed: Pending[], pmMessageTs: string): Promise<void> {
    if (!closed.length) return;
    const react = (ts: string) =>
      this.client.reactions.add({ channel, timestamp: ts, name: 'white_check_mark' }).catch(() => undefined);
    await Promise.all([pmMessageTs, ...closed.map((c) => c.message_ts)].map(react));
    const list = closed.map((c) => `• ${c.prompt.replace(/\s+/g, ' ').slice(0, 60)}${c.prompt.length > 60 ? '…' : ''}`).join('\n');
    await postAs(this.client, 'EM', {
      channel,
      thread_ts: closed[0].message_ts,
      text: `:white_check_mark: Closed ${closed.length === 1 ? '1 question' : `${closed.length} questions`}:\n${list}`,
    }).catch(() => undefined);
  }

  /** A button click. Returns true if it resolved a pending approval. */
  handleButton(channel: string, messageTs: string, value: string): boolean {
    const p = this.db.pendingByMsg(channel, messageTs);
    if (!p || p.kind !== 'approval') return false;
    this.resolve(p.id, value);
    return true;
  }

}
