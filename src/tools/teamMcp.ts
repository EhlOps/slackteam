import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { archiveChannel, createJobChannel, findChannel, readContext } from '../slack/channels.js';
import { postAs } from '../slack/personas.js';
import { Prd, TechPlan } from '../vault/schema.js';
import type { AgentName } from '../workflow/db.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: `ERROR: ${t}` }], isError: true });
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Build the in-process MCP server for one agent in one job (jobId 0 = intake, before a job exists).
 * `channel` is where this agent talks to the PM.
 */
export function buildTeamServer(ctx: Ctx, jobId: number, agent: AgentName, channel: string) {
  const { db, client, vault, interactions } = ctx;
  const isEm = agent === 'EM';
  const guard = <A>(fn: (a: A) => Promise<ReturnType<typeof text>>) => async (a: A) => {
    try {
      return await fn(a);
    } catch (e: any) {
      return fail(e?.message ?? String(e));
    }
  };

  const common = [
    tool('post_update', 'Post a short status update to the PM in this channel.', { text: z.string() }, guard(async ({ text: t }) => {
      await postAs(client, agent, { channel, text: t });
      return text('posted');
    })),
    tool('ask_pm', 'Ask the PM a question and wait for the answer. Use whenever requirements or a decision are unclear. Do not guess.',
      { question: z.string() }, guard(async ({ question }) => text(await interactions.ask(jobId || null, agent, channel, question)))),
    tool('request_approval', 'Ask the PM to approve a risky action before you do it. Returns APPROVED or DENIED.',
      { action: z.string(), reason: z.string() }, guard(async ({ action, reason }) =>
        text((await interactions.approve(jobId || null, agent, channel, action, reason)) ? 'APPROVED' : 'DENIED'))),
  ];

  const em = [
    tool('get_team_context', `Read pinned messages and recent history of a team context channel. Teams: ${ctx.cfg.teams.map((t) => t.key).join(', ')}`,
      { team: z.string() }, guard(async ({ team }) => {
        const t = ctx.cfg.teams.find((x) => x.key === team);
        if (!t) return fail(`unknown team; use one of ${ctx.cfg.teams.map((x) => x.key).join(', ')}`);
        const id = await findChannel(client, t.channel);
        return text(id ? `# ${t.key}: ${t.description}\n${await readContext(client, id)}` : `Channel #${t.channel} not found. Run bootstrap:slack.`);
      })),
    tool('create_job', 'Create a job and its private Slack channel (invites the PM). Call once the goal is clear enough to start. Afterwards, continue the work in the job channel.',
      { slug: z.string().describe('short kebab-case name'), goal: z.string() }, guard(async ({ slug, goal }) => {
        if (db.activeJobs().length >= ctx.cfg.env.MAX_CONCURRENT_JOBS) return fail(`already at MAX_CONCURRENT_JOBS=${ctx.cfg.env.MAX_CONCURRENT_JOBS}; tell the PM`);
        const id = db.createJob(slug, goal);
        const ch = await createJobChannel(client, id, slug, ctx.cfg.env.PM_SLACK_USER_ID);
        db.setChannel(id, ch);
        await postAs(client, 'EM', { channel: ch, text: `*Job ${id}: ${slug}*\n${goal}` });
        void ctx.runner.send(id, 'EM', `Job ${id} was created for this goal:\n${goal}\n\nContinue in this channel: gather team context, ask the PM clarifying questions, then write the OKR and PRD.`, ch);
        return text(`job ${id} created in channel ${ch}. Tell the PM to continue there.`);
      })),
    tool('write_okr', 'Create or update an OKR in the vault (validated; writes .json and .md, commits, pushes). id format OKR-2026Q4-01.',
      { okr: z.record(z.string(), z.unknown()) }, guard(async ({ okr }) => {
        await vault.sync();
        const r = await vault.write('okr', { created: today(), updated: today(), ...okr }, String(okr.id ?? 'okr').toLowerCase());
        return text(`wrote ${r.id}`);
      })),
    tool('write_prd', 'Create or update a PRD in the vault (validated; writes .json and .md, commits, pushes). Omit id to allocate one. Set status in_review when asking for PM approval, approved after the PM approves.',
      { prd: z.record(z.string(), z.unknown()), slug: z.string() }, guard(async ({ prd, slug }) => {
        await vault.sync();
        const job = jobId ? db.getJob(jobId) : undefined;
        const id = (prd.id as string | undefined) ?? vault.nextPrdId();
        const existing = vault.read('prd', id) as { created?: string } | undefined;
        const full = { slack_channel: job?.channel_id ?? undefined, pm: 'PM', ...prd, id, created: existing?.created ?? today(), updated: today() };
        const r = await vault.write('prd', full, slug);
        if (jobId) db.setPrd(jobId, r.id);
        return text(`wrote ${r.id}`);
      })),
    tool('assign_work', 'Start a SWE on a workstream of an APPROVED PRD. Creates its git worktree. Max SWE-1 and SWE-2 per job.',
      { swe: z.enum(['SWE-1', 'SWE-2']), repo: z.string(), workstream: z.string().describe('what this SWE owns'), slug: z.string() },
      guard(async ({ swe, repo, workstream, slug }) => {
        const job = db.getJob(jobId);
        if (!job?.prd_id) return fail('write the PRD first');
        await vault.sync();
        const prd = vault.read('prd', job.prd_id) as { status?: string } | undefined;
        if (prd?.status !== 'approved' && prd?.status !== 'in_progress') return fail(`PRD ${job.prd_id} must be approved by the PM first (status: ${prd?.status})`);
        const wt = await ctx.worktrees.create(repo, jobId, swe, slug);
        db.putWorkdir({ job_id: jobId, agent: swe, repo, path: wt.path, branch: wt.branch, workstream });
        db.setState(jobId, 'planning');
        void ctx.runner.send(jobId, swe,
          `You are ${swe} on job ${jobId}. PRD: ${job.prd_id} (read vault file via the path in your system prompt).\nYour workstream: ${workstream}\nRepo: ${repo}, worktree: ${wt.path}, branch: ${wt.branch}.\nStudy the code, then call submit_tech_plan. Do not edit code until the EM approves your plan.`, job.channel_id ?? channel);
        return text(`${swe} started on ${wt.branch}`);
      })),
    tool('review_tech_plan', 'Review a submitted tech plan. verdict approve unlocks implementation for that SWE; changes sends it back (max 3 rounds, then escalate to the PM with ask_pm).',
      { tp_id: z.string(), verdict: z.enum(['approve', 'changes']), comments: z.string() }, guard(async ({ tp_id, verdict, comments }) => {
        await vault.sync();
        const tp = TechPlan.parse(vault.read('techplan', tp_id));
        const round = tp.review.length + 1;
        const next = { ...tp, status: verdict === 'approve' ? 'approved' : 'changes_requested', updated: today(), review: [...tp.review, { round, verdict, comments }] };
        await vault.write('techplan', next, 'review');
        const swe = tp.author as AgentName;
        const job = db.getJob(jobId)!;
        if (verdict === 'approve') {
          db.setApproved(jobId, swe, true);
          db.setState(jobId, 'implementing');
          void ctx.runner.send(jobId, swe, `Your plan ${tp_id} is APPROVED. ${comments}\nImplement it in your worktree, run the repo tests, push the branch, open a PR with gh (link the PRD and TP in the body), then call report_pr.`, job.channel_id ?? channel);
        } else {
          void ctx.runner.send(jobId, swe, `EM requested changes on ${tp_id} (round ${round}/3):\n${comments}\nRevise and call submit_tech_plan again with the same id.`, job.channel_id ?? channel);
        }
        return text(round >= 3 && verdict === 'changes' ? `recorded; round ${round} reached the limit, escalate to the PM with ask_pm` : 'recorded and sent to SWE');
      })),
    tool('close_job', 'Close the job: mark the PRD shipped (or cancelled), post a summary into each relevant team channel, remove worktrees and archive the job channel.',
      { summary: z.string(), outcome: z.enum(['shipped', 'cancelled']) }, guard(async ({ summary, outcome }) => {
        const job = db.getJob(jobId);
        if (!job) return fail('no job');
        if (job.prd_id) {
          await vault.sync();
          const prd = Prd.parse(vault.read('prd', job.prd_id));
          await vault.write('prd', { ...prd, status: outcome, updated: today() }, 'close');
          for (const key of prd.teams) {
            const t = ctx.cfg.teams.find((x) => x.key === key);
            const id = t && (await findChannel(client, t.channel));
            if (id) await postAs(client, 'EM', { channel: id, text: `*${prd.id} ${prd.title}* (${outcome})\n${summary}` });
          }
        }
        for (const w of db.jobWorkdirs(jobId)) await ctx.worktrees.remove(w.repo, w.path);
        db.setState(jobId, outcome === 'shipped' ? 'done' : 'cancelled');
        if (job.channel_id) {
          await postAs(client, 'EM', { channel: job.channel_id, text: `Closing job ${jobId} (${outcome}). ${summary}` });
          await archiveChannel(client, job.channel_id);
        }
        return text('closed');
      })),
  ];

  const swe = [
    tool('submit_tech_plan', 'Submit (or resubmit) your tech plan for EM review. Include id TP-<prd number>-a for SWE-1, -b for SWE-2 (e.g. TP-0001-a). After submitting, END your turn; you will be resumed with the review.',
      { plan: z.record(z.string(), z.unknown()), slug: z.string() }, guard(async ({ plan, slug }) => {
        const w = db.getWorkdir(jobId, agent);
        const job = db.getJob(jobId);
        if (!w || !job?.prd_id) return fail('no assignment');
        await vault.sync();
        const prev = vault.read('techplan', String(plan.id)) as { review?: unknown[]; created?: string } | undefined;
        const full = { prd: job.prd_id, author: agent, repo: w.repo, branch: w.branch, ...plan, status: 'in_review', review: prev?.review ?? [], created: prev?.created ?? today(), updated: today() };
        const r = await vault.write('techplan', full, slug);
        db.setTp(jobId, agent, r.id);
        db.setState(jobId, 'review');
        void ctx.runner.send(jobId, 'EM', `${agent} submitted ${r.id} for review. Read it in the vault (TechPlans/) and call review_tech_plan.`, job.channel_id ?? channel);
        return text(`submitted ${r.id}; end your turn and wait for the EM`);
      })),
    tool('report_pr', 'Record the pull request you opened. Call once after gh pr create.', { url: z.string().url() }, guard(async ({ url }) => {
      const w = db.getWorkdir(jobId, agent);
      const job = db.getJob(jobId);
      if (!w?.tp_id || !job?.prd_id) return fail('no approved plan');
      await vault.sync();
      const tp = TechPlan.parse(vault.read('techplan', w.tp_id));
      await vault.write('techplan', { ...tp, status: 'implemented', pr: url, updated: today() }, 'pr');
      const prd = Prd.parse(vault.read('prd', job.prd_id));
      await vault.write('prd', { ...prd, status: 'in_progress', prs: [...new Set([...prd.prs, url])], updated: today() }, 'pr');
      db.setPr(jobId, agent, url);
      const all = db.jobWorkdirs(jobId);
      if (all.every((x) => x.pr)) db.setState(jobId, 'pr');
      await postAs(client, agent, { channel, text: `:rocket: PR ready: ${url}` });
      if (all.every((x) => x.pr)) void ctx.runner.send(jobId, 'EM', `All PRs are open: ${all.map((x) => x.pr).join(', ')}. Summarize for the PM and ask whether to close the job once merged.`, job.channel_id ?? channel);
      return text('recorded');
    })),
  ];

  return createSdkMcpServer({ name: 'team', version: '1.0.0', tools: [...common, ...(isEm ? em : swe)] });
}

