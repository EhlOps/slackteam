import { z } from 'zod';

export const Priority = z.enum(['must', 'should', 'could']);
export const PrdStatus = z.enum(['draft', 'in_review', 'approved', 'in_progress', 'shipped', 'cancelled']);

export const KeyResult = z.object({
  id: z.string(), // KR1
  text: z.string(),
  metric: z.string(),
  baseline: z.string().optional(),
  target: z.string(),
});

export const Okr = z.object({
  id: z.string().regex(/^OKR-\d{4}Q[1-4]-\d{2}$/),
  objective: z.string(),
  quarter: z.string(),
  owner: z.string(),
  teams: z.array(z.string()),
  key_results: z.array(KeyResult).min(1),
  created: z.string(),
  updated: z.string(),
});

export const Prd = z.object({
  id: z.string().regex(/^PRD-\d{4}$/),
  title: z.string(),
  status: PrdStatus,
  teams: z.array(z.string()),
  okr_refs: z.array(z.string()).default([]),
  pm: z.string(),
  em: z.string().default('EM'),
  slack_channel: z.string().optional(),
  repos: z.array(z.string()).default([]),
  problem: z.string(),
  goals: z.array(z.string()).min(1),
  non_goals: z.array(z.string()).default([]),
  user_stories: z.array(z.string()).default([]),
  requirements: z.array(z.object({ id: z.string(), text: z.string(), priority: Priority })).min(1),
  acceptance_criteria: z.array(z.string()).min(1),
  success_metrics: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
  tech_plans: z.array(z.string()).default([]),
  prs: z.array(z.string()).default([]),
  created: z.string(),
  updated: z.string(),
});

export const TechPlan = z.object({
  id: z.string().regex(/^TP-\d{4}-[ab]$/),
  prd: z.string(),
  author: z.string(), // SWE-1 | SWE-2
  status: z.enum(['draft', 'in_review', 'changes_requested', 'approved', 'implemented']),
  repo: z.string(),
  branch: z.string(),
  summary: z.string(),
  approach: z.string(),
  files: z.array(z.object({ path: z.string(), change: z.string() })).default([]),
  test_plan: z.array(z.string()).min(1),
  rollout: z.string().default(''),
  remote_changes: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  review: z.array(z.object({ round: z.number(), verdict: z.enum(['approve', 'changes']), comments: z.string() })).default([]),
  pr: z.string().optional(),
  created: z.string(),
  updated: z.string(),
});

export type Okr = z.infer<typeof Okr>;
export type Prd = z.infer<typeof Prd>;
export type TechPlan = z.infer<typeof TechPlan>;

export const jsonSchemas = {
  okr: z.toJSONSchema(Okr),
  prd: z.toJSONSchema(Prd),
  techplan: z.toJSONSchema(TechPlan),
};
