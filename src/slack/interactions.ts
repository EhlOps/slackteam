import type { WebClient } from '@slack/web-api';
import type { Db, AgentName, Pending } from '../workflow/db.js';
import { postAs } from './personas.js';

type Resolver = (answer: string) => void;

/** Parks agent tool calls until the PM answers in Slack. Survives restarts: pendings live in SQLite and are re-posted. */
export class Interactions {
  private waiters = new Map<number, Resolver>();
  constructor(private client: WebClient, private db: Db, private timeoutMs: number) {}

  private wait(pendingId: number, timeoutMs?: number): Promise<string> {
    return new Promise((resolve) => {
      this.waiters.set(pendingId, resolve);
      if (timeoutMs) setTimeout(() => this.resolve(pendingId, '__timeout__'), timeoutMs).unref();
    });
  }

  /** Resolve a pending item (idempotent). */
  resolve(pendingId: number, answer: string) {
    this.db.answer(pendingId, answer);
    this.waiters.get(pendingId)?.(answer);
    this.waiters.delete(pendingId);
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
    this.resolve(p.id, text);
    return { pending: p, orphaned };
  }

  /** A button click. Returns true if it resolved a pending approval. */
  handleButton(channel: string, messageTs: string, value: string): boolean {
    const p = this.db.pendingByMsg(channel, messageTs);
    if (!p || p.kind !== 'approval') return false;
    this.resolve(p.id, value);
    return true;
  }

}
