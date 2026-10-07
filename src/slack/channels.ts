import type { WebClient } from '@slack/web-api';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);

export async function findChannel(client: WebClient, name: string): Promise<string | undefined> {
  let cursor: string | undefined;
  do {
    const r = await client.conversations.list({ types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor });
    const hit = r.channels?.find((c) => c.name === name);
    if (hit?.id) return hit.id;
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

export async function ensureChannel(client: WebClient, name: string, isPrivate = false): Promise<string> {
  const n = norm(name);
  const existing = await findChannel(client, n);
  if (existing) return existing;
  const r = await client.conversations.create({ name: n, is_private: isPrivate });
  return r.channel!.id!;
}

export async function createJobChannel(client: WebClient, jobId: number, slug: string, inviteUser: string): Promise<string> {
  const id = await ensureChannel(client, `job-${String(jobId).padStart(4, '0')}-${slug}`, true);
  await client.conversations.invite({ channel: id, users: inviteUser }).catch((e) => {
    if (e?.data?.error !== 'already_in_channel') throw e;
  });
  return id;
}

export const archiveChannel = (client: WebClient, channel: string) => client.conversations.archive({ channel });

/** Pinned messages + recent history, flattened to text for an agent to read. */
export async function readContext(client: WebClient, channel: string, limit = 40): Promise<string> {
  const pins = await client.pins.list({ channel }).catch(() => undefined);
  const pinned = (pins?.items ?? []).map((i: any) => i.message?.text).filter(Boolean) as string[];
  const hist = await client.conversations.history({ channel, limit });
  const recent = (hist.messages ?? []).map((m) => m.text).filter(Boolean).reverse() as string[];
  return `## Pinned\n${pinned.length ? pinned.join('\n---\n') : '(none)'}\n\n## Recent\n${recent.length ? recent.join('\n---\n') : '(none)'}`;
}
