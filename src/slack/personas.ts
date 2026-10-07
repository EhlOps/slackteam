import type { WebClient } from '@slack/web-api';
import type { AgentName } from '../workflow/db.js';

export const PERSONAS: Record<AgentName, { username: string; icon_emoji: string }> = {
  EM: { username: 'EM', icon_emoji: ':compass:' },
  'SWE-1': { username: 'SWE-1', icon_emoji: ':hammer_and_wrench:' },
  'SWE-2': { username: 'SWE-2', icon_emoji: ':wrench:' },
};

export interface PostOpts {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: any[];
}

/** Post as an agent persona. Returns the message ts. */
export async function postAs(client: WebClient, agent: AgentName, o: PostOpts): Promise<string> {
  const r = await client.chat.postMessage({
    channel: o.channel,
    text: o.text,
    thread_ts: o.thread_ts,
    blocks: o.blocks,
    ...PERSONAS[agent],
  });
  if (!r.ts) throw new Error('chat.postMessage returned no ts');
  return r.ts;
}
