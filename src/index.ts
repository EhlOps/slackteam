import { join } from 'node:path';
import { App } from '@slack/bolt';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentRunner } from './agents/runner.js';
import { loadConfig } from './config.js';
import type { Ctx } from './ctx.js';
import { ensureChannel } from './slack/channels.js';
import { Interactions } from './slack/interactions.js';
import { claudeJudge } from './slack/matcher.js';
import { postAs } from './slack/personas.js';
import { registerHandlers } from './slack/router.js';
import { Vault } from './vault/git.js';
import { openDb } from './workflow/db.js';
import { loadStoredRepos } from './workflow/repos.js';
import { Worktrees } from './workflow/worktrees.js';

async function checkClaudeAuth(): Promise<string | undefined> {
  try {
    for await (const m of query({ prompt: 'Reply with OK.', options: { maxTurns: 1, settingSources: [], allowedTools: [] } })) {
      if (m.type === 'result' && m.subtype !== 'success') return m.subtype;
    }
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function main() {
  const cfg = loadConfig();
  const app = new App({ token: cfg.env.SLACK_BOT_TOKEN, appToken: cfg.env.SLACK_APP_TOKEN, socketMode: true });
  const client = app.client;
  const db = openDb(join(cfg.env.DATA_DIR, 'slackteam.sqlite'));
  loadStoredRepos(cfg.repos, db);
  const vault = new Vault(join(cfg.env.DATA_DIR, 'vault'), `https://github.com/${cfg.env.VAULT_REPO}.git`);
  await vault.sync();

  const runner = new AgentRunner();
  const ctx: Ctx = {
    client, cfg, db, vault, runner,
    interactions: new Interactions(client, db, cfg.env.APPROVAL_TIMEOUT_MIN * 60_000, { judge: claudeJudge(cfg.env.JUDGE_MODEL, cfg.env.JUDGE_TIMEOUT_MS), pm: cfg.env.PM_SLACK_USER_ID, reminderMs: cfg.env.QUESTION_REMINDER_MS }),
    worktrees: new Worktrees(cfg.env.DATA_DIR, cfg.repos),
    intakeChannel: await ensureChannel(client, 'em-intake'),
  };
  runner.ctx = ctx;
  registerHandlers(app, ctx);
  ctx.interactions.rearmReminders();
  await app.start();

  const authErr = await checkClaudeAuth();
  if (authErr) {
    await postAs(client, 'EM', { channel: ctx.intakeChannel, text: `:rotating_light: Claude auth check failed (${authErr.slice(0, 200)}). Run \`claude setup-token\`, update \`CLAUDE_CODE_OAUTH_TOKEN\` in \`.env\`, then \`docker compose up -d\`.` });
    console.error('Claude auth check failed:', authErr);
  } else {
    await postAs(client, 'EM', { channel: ctx.intakeChannel, text: ':wave: EM online. Tell me a goal here or in a DM.' });
  }
  // Agents do not auto-resume mid-run after a restart; answered questions do (see router), anything else needs a nudge.
  for (const j of db.activeJobs()) {
    if (j.channel_id) await postAs(client, 'EM', { channel: j.channel_id, text: 'Restarted. Send a message here to continue where we left off.' }).catch(() => undefined);
  }
  console.log('slackteam running');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
