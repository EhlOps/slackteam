// Creates #em-intake and the standing team context channels, and pins a context template in each.
import { WebClient } from '@slack/web-api';
import { loadConfig } from '../src/config.js';
import { ensureChannel } from '../src/slack/channels.js';

const cfg = loadConfig();
const client = new WebClient(cfg.env.SLACK_BOT_TOKEN);

const template = (key: string, desc: string) =>
  `*Context for the ${key} team* — ${desc}\nThe EM agent reads pins + recent messages here before writing PRDs. Pin/replace this with:\n• Architecture & key repos\n• Conventions (lint, tests, review rules)\n• Owners / who to ask\n• Constraints & past decisions`;

for (const name of ['em-intake', ...cfg.teams.map((t) => t.channel)]) {
  const id = await ensureChannel(client, name);
  await client.conversations.invite({ channel: id, users: cfg.env.PM_SLACK_USER_ID }).catch(() => undefined);
  const team = cfg.teams.find((t) => t.channel === name);
  if (team) {
    const pins = await client.pins.list({ channel: id });
    if (!pins.items?.length) {
      const m = await client.chat.postMessage({ channel: id, text: template(team.key, team.description) });
      await client.pins.add({ channel: id, timestamp: m.ts! });
    }
  }
  console.log(`#${name} -> ${id}`);
}
