import type { WebClient } from '@slack/web-api';
import type { Db, AgentName, Pending } from '../workflow/db.js';
import { postAs } from './personas.js';
import { matchAnswer, type Judge } from './matcher.js';

export interface ChannelOutcome {
  closed: Pending[];
  /** Closed questions whose agent was no longer waiting (restart): caller must resume the agent. */
  orphaned: Set<number>;
  /** Question ids re-asked (partial answer). */
  reasked: number[];
  /** True when the message is not an answer and must be processed as a normal request. */
  passthrough: boolean;
}

type Resolver = (answer: string) => void;

/** Parks agent tool calls until the PM answers in Slack. Survives restarts: pendings live in SQLite and are re-posted. */
export class Interactions {
  private waiters = new Map<number, Resolver>();
  /** Per-channel promise chain. Single-process assumption (one app, one SQLite file); the conditional DB update guards races regardless. */
  private chains = new Map<string, Promise<unknown>>();
  constructor(private client: WebClient, private db: Db, private timeoutMs: number, private opts: { judge?: Judge; pm?: string } = {}) {}

  /** @mention of the PM (placeholder; SWE-2's TP-0003-b owns the final helper). */
  pmMention(): string {
    return this.opts.pm ? `<@${this.opts.pm}>` : '';
  }

  private wait(pendingId: number, timeoutMs?: number): Promise<string> {
    return new Promise((resolve) => {
      this.waiters.set(pendingId, resolve);
      if (timeoutMs) setTimeout(() => this.resolve(pendingId, '__timeout__'), timeoutMs).unref();
    });
  }

  /** Resolve a pending item (idempotent). */
  resolve(pendingId: number, answer: string): boolean {
    if (!this.db.answer(pendingId, answer)) return false; // already closed elsewhere: do not wake twice
    this.waiters.get(pendingId)?.(answer);
    this.waiters.delete(pendingId);
    return true;
  }

  async ask(jobId: number | null, agent: AgentName, channel: string, question: string): Promise<string> {
    const ts = await postAs(this.client, agent, { channel, text: `:question: ${question}\n_Reply in this thread._` });
    const id = this.db.addPending({ job_id: jobId, kind: 'question', agent, channel_id: channel, message_ts: ts, prompt: question });
    return this.wait(id);
  }

  async approve(jobId: number | null, agent: AgentName, channel: string, action: string, reason: string): Promise<boolean> {
    const ts = await postAs(this.client, agent, {
      channel,
      text: `Approval needed: ${action}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `:warning: *Approval needed*\n\`\`\`${action.slice(0, 2500)}\`\`\`\n*Why:* ${reason}` } },
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
    if (!this.resolve(p.id, text)) return undefined; // lost a race with another answer
    return { pending: p, orphaned };
  }

  /** A button click. Returns true if it resolved a pending approval. */
  handleButton(channel: string, messageTs: string, value: string): boolean {
    const p = this.db.pendingByMsg(channel, messageTs);
    if (!p || p.kind !== 'approval') return false;
    this.resolve(p.id, value);
    return true;
  }

  /**
   * A top-level PM message in a channel with (possibly) open questions. Serialized per channel.
   * Closes every question the message answers, re-asks only what remains, and reports passthrough
   * when the message is not an answer so the caller processes it as a normal request.
   */
  handleChannelMessage(channel: string, text: string): Promise<ChannelOutcome> {
    const prev = this.chains.get(channel) ?? Promise.resolve();
    const run = prev.then(() => this.matchAndClose(channel, text));
    this.chains.set(channel, run.catch(() => undefined));
    return run;
  }

  private async matchAndClose(channel: string, text: string): Promise<ChannelOutcome> {
    const out: ChannelOutcome = { closed: [], orphaned: new Set(), reasked: [], passthrough: false };
    const open = this.db.openQuestionsByChannel(channel);
    const m = open.length && this.opts.judge ? await matchAnswer(text, open, this.opts.judge) : ({ kind: 'none' } as const);
    if (m.kind === 'none') return { ...out, passthrough: true };
    const byId = new Map(open.map((q) => [q.id, q]));
    for (const a of m.answers) {
      const p = byId.get(a.id)!;
      const orphaned = !this.waiters.has(p.id);
      if (!this.resolve(p.id, a.answer)) continue; // closed concurrently (e.g. thread reply): not ours to ack
      out.closed.push(p);
      if (orphaned) out.orphaned.add(p.id);
    }
    const mention = this.pmMention();
    for (const r of m.remaining) {
      const p = byId.get(r.id)!;
      await postAs(this.client, p.agent, { channel, thread_ts: p.message_ts, text: `${mention} Still need an answer on: ${r.missing}`.trim() }).catch(() => undefined);
      out.reasked.push(p.id);
    }
    if (m.ambiguous) {
      const list = open.map((q) => `• ${q.prompt}`).join('\n');
      await postAs(this.client, open[0].agent, { channel, text: `${mention} I could not tell which question that answers, so I closed nothing. Please reply in the thread of the question:\n${list}`.trim() }).catch(() => undefined);
    }
    return out;
  }

  /** Placeholder for SWE-2's R8 acknowledgement (TP-0003-b); same signature. */
  async acknowledgeClosed(channel: string, closed: Pending[], pmMessageTs: string): Promise<void> {
    if (!closed.length) return;
    await postAs(this.client, 'EM', { channel, thread_ts: pmMessageTs, text: `:white_check_mark: Closed: ${closed.map((q) => q.prompt.slice(0, 80)).join('; ')}` }).catch(() => undefined);
  }
}
