import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { query, type CanUseTool, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { Ctx, Runner } from '../ctx.js';
import { classify } from '../guard/risky.js';
import { postAs } from '../slack/personas.js';
import { buildTeamServer } from '../tools/teamMcp.js';
import type { AgentName } from '../workflow/db.js';

const AUTH_ERR = /401|authenticat|oauth|token (has )?expired|invalid.*(token|api key)/i;
const promptFile = (name: string) => readFileSync(join(process.cwd(), 'prompts', name), 'utf8');

export class AgentRunner implements Runner {
  private chains = new Map<string, Promise<void>>();
  private authBroken = false;
  ctx!: Ctx;

  /** Serialize runs per (job, agent): a second message waits for the first run to finish. */
  send(jobId: number, agent: AgentName, prompt: string, channel?: string): Promise<void> {
    const key = `${jobId}:${agent}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.run(jobId, agent, prompt, channel)).catch((e) => this.report(jobId, agent, channel, e));
    this.chains.set(key, next);
    return next;
  }

  private channelFor(jobId: number, channel?: string) {
    return channel ?? this.ctx.db.getJob(jobId)?.channel_id ?? this.ctx.intakeChannel;
  }

  private async report(jobId: number, agent: AgentName, channel: string | undefined, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const ch = this.channelFor(jobId, channel);
    if (AUTH_ERR.test(msg)) {
      this.authBroken = true;
      await postAs(this.ctx.client, 'EM', {
        channel: this.ctx.intakeChannel,
        text: ':rotating_light: Claude auth failed (token expired?). Run `claude setup-token`, update `CLAUDE_CODE_OAUTH_TOKEN` in `.env`, then `docker compose up -d`.',
      }).catch(() => undefined);
      return;
    }
    await postAs(this.ctx.client, agent, { channel: ch, text: `:x: ${agent} crashed: ${msg.slice(0, 500)}` }).catch(() => undefined);
  }

  private canUseTool(jobId: number, agent: AgentName, channel: string, cwd: string): CanUseTool {
    const { db, interactions, cfg } = this.ctx;
    const inside = (p: unknown) => typeof p === 'string' && (resolve(cwd, p) + sep).startsWith(resolve(cwd) + sep);
    return async (tool, input) => {
      if (tool === 'Bash') {
        const cmd = String(input.command ?? '');
        const c = classify(cmd, cfg.hosts);
        if (!c.risky) return { behavior: 'allow' };
        const ok = await interactions.approve(jobId || null, agent, channel, cmd, c.reasons.join(', '));
        return ok ? { behavior: 'allow' } : { behavior: 'deny', message: 'The PM denied (or did not answer) this command. Choose a safer approach or ask_pm.' };
      }
      if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
        if (agent === 'EM') return { behavior: 'deny', message: 'The EM writes through write_okr / write_prd only.' };
        if (!db.getWorkdir(jobId, agent)?.approved) return { behavior: 'deny', message: 'Your tech plan is not approved yet. Submit it with submit_tech_plan and wait for the EM.' };
        if (!inside(input.file_path ?? input.notebook_path)) return { behavior: 'deny', message: `Edits are limited to your worktree (${cwd}).` };
        return { behavior: 'allow' };
      }
      return { behavior: 'allow' };
    };
  }

  private async run(jobId: number, agent: AgentName, prompt: string, channelArg?: string) {
    const { db, vault, client, cfg } = this.ctx;
    if (this.authBroken) throw new Error('401 authentication previously failed; restart after renewing the token');
    const channel = this.channelFor(jobId, channelArg);
    const wd = agent === 'EM' ? undefined : db.getWorkdir(jobId, agent);
    const cwd = wd?.path ?? vault.dir;
    const job = jobId ? db.getJob(jobId) : undefined;
    const isEm = agent === 'EM';

    const hosts = cfg.hosts.map((h) => `- ${h.alias}${h.prod ? ' (prod: writes need approval)' : ''}: ${h.description}`).join('\n');
    const system = [
      promptFile(isEm ? 'em.md' : 'swe.md'),
      `\n## This session\nAgent: ${agent}. Job: ${jobId || 'none yet (intake)'}${job ? ` (${job.slug}), PRD: ${job.prd_id ?? 'not yet written'}` : ''}.`,
      `Vault (read PRDs/OKRs/TechPlans here as .json): ${vault.dir}`,
      `Teams: ${cfg.teams.map((t) => `${t.key} (${t.description})`).join('; ')}`,
      `Repos: ${cfg.repos.map((r) => `${r.name}${r.test_cmd ? ` [tests: ${r.test_cmd}]` : ''}`).join('; ')}`,
      `SSH hosts:\n${hosts}`,
      wd ? `Worktree: ${wd.path} (branch ${wd.branch}). Workstream: ${wd.workstream}` : '',
    ].join('\n');

    const options: Options = {
      cwd,
      systemPrompt: system,
      resume: db.getSession(jobId, agent),
      settingSources: [],
      mcpServers: { team: buildTeamServer(this.ctx, jobId, agent, channel) },
      // Bash/Edit/Write are deliberately NOT pre-allowed so every call reaches canUseTool.
      allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'mcp__team__*'],
      permissionMode: 'default',
      canUseTool: this.canUseTool(jobId, agent, channel, cwd),
      ...(isEm ? { disallowedTools: ['Bash'] } : {}),
      env: { ...process.env } as Record<string, string>,
    };

    let finalText = '';
    for await (const m of query({ prompt, options })) {
      if (m.type === 'system' && m.subtype === 'init') db.putSession(jobId, agent, m.session_id);
      if (m.type === 'result') {
        if (m.subtype === 'success') finalText = m.result;
        else throw new Error(`${m.subtype}: ${(m as { errors?: string[] }).errors?.join('; ') ?? ''}`);
      }
    }
    if (finalText.trim()) await postAs(client, agent, { channel, text: finalText });
  }
}
