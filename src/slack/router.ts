import type { App } from '@slack/bolt';
import type { Ctx } from '../ctx.js';
import { postAs } from './personas.js';
import type { Interactions } from './interactions.js';
import type { AgentName, Pending } from '../workflow/db.js';
import { addReposFromText } from '../workflow/repos.js';

/** Pure routing decision for a message inside a job channel. */
export function routeJobMessage(text: string): { agent: AgentName; text: string } {
  const m = /^\s*(swe-?([12]))\s*[:,]\s*([\s\S]*)$/i.exec(text);
  return m ? { agent: `SWE-${m[2]}` as AgentName, text: m[3] } : { agent: 'EM', text };
}

/** R5: only the PM's human messages count; bot/persona posts (incl. our own acks and reminders) never do. */
export function isPmMessage(e: { user?: string; text?: string; bot_id?: string; subtype?: string }, pm: string): boolean {
  return !e.bot_id && !e.subtype && !!e.text && e.user === pm;
}

/** Acknowledge all questions closed by one PM message: exactly one call, none when nothing closed. */
export async function acknowledgeClosures(interactions: Pick<Interactions, 'acknowledgeClosed'>, channel: string, closed: Pending[], pmMessageTs: string) {
  if (closed.length) await interactions.acknowledgeClosed(channel, closed, pmMessageTs);
}

export function registerHandlers(app: App, ctx: Ctx) {
  const { db, interactions, runner, cfg, client } = ctx;
  const pm = cfg.env.PM_SLACK_USER_ID;
  const teamChannels = new Set<string>();
  const loadTeamChannels = async () => {
    const { findChannel } = await import('./channels.js');
    for (const t of cfg.teams) {
      const id = await findChannel(client, t.channel);
      if (id) teamChannels.add(id);
    }
  };
  void loadTeamChannels();

  app.event('message', async ({ event }) => {
    const e = event as { user?: string; text?: string; channel: string; ts: string; thread_ts?: string; bot_id?: string; subtype?: string; channel_type?: string };
    if (!isPmMessage(e, pm)) return; // only the PM can direct the team
    const text = e.text!;

    if (e.thread_ts) {
      const hit = interactions.handleReply(e.channel, e.thread_ts, text);
      if (hit) {
        void acknowledgeClosures(interactions, e.channel, [hit.pending], e.ts);
        // Agent process died (restart) before the answer: resume its session with the answer.
        if (hit.orphaned && hit.pending.job_id !== null) {
          void runner.send(hit.pending.job_id, hit.pending.agent, `The PM answered your earlier question.\nQ: ${hit.pending.prompt}\nA: ${text}`, e.channel);
        } else if (hit.orphaned) {
          void runner.send(0, hit.pending.agent, `The PM answered your earlier question.\nQ: ${hit.pending.prompt}\nA: ${text}`, e.channel);
        }
        return;
      }
    }

    const job = db.jobByChannel(e.channel);
    if (job || e.channel_type === 'im' || e.channel === ctx.intakeChannel) {
      const added = await addReposFromText(text, cfg.repos, db).catch(() => []);
      if (added.length) {
        const list = added.map((r) => `\`${r.name}\` (${r.github}@${r.default_branch})`).join(', ');
        await postAs(client, 'EM', { channel: e.channel, thread_ts: e.thread_ts, text: `:link: Added ${list} to the repos I can work on.` }).catch(() => undefined);
      }
    }
    if (job) {
      const r = routeJobMessage(text);
      void runner.send(job.id, r.agent, `PM: ${r.text}`, e.channel);
    } else if (e.channel_type === 'im' || e.channel === ctx.intakeChannel) {
      void runner.send(0, 'EM', `PM: ${text}`, e.channel);
    }
  });

  // @mention in a team context channel: talk to the EM about that team without starting a job.
  app.event('app_mention', async ({ event }) => {
    if (event.user !== pm || db.jobByChannel(event.channel) || event.channel === ctx.intakeChannel) return;
    if (!teamChannels.has(event.channel)) await loadTeamChannels();
    if (!teamChannels.has(event.channel)) return;
    void runner.send(0, 'EM', `PM (in a team channel, reply here): ${event.text}`, event.channel);
  });

  const onButton = (value: 'approve' | 'deny') => async ({ ack, body, client: c }: any) => {
    await ack();
    if (body.user.id !== pm) return;
    const channel = body.channel.id as string;
    const ts = body.message.ts as string;
    const live = interactions.handleButton(channel, ts, value);
    await c.chat.update({
      channel, ts, text: `${value === 'approve' ? 'Approved' : 'Denied'} by <@${body.user.id}>`, blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `${value === 'approve' ? ':white_check_mark: Approved' : ':no_entry: Denied'} by <@${body.user.id}>${live ? '' : ' (the agent is no longer waiting; ask it to retry)'}` } },
      ],
    });
  };
  app.action('approve', onButton('approve'));
  app.action('deny', onButton('deny'));
}

export { postAs };
