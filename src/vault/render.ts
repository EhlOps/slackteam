import { stringify } from 'yaml';
import type { Okr, Prd, TechPlan } from './schema.js';

const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '_None_');
const links = (ids: string[]) => (ids.length ? ids.map((i) => `[[${i}]]`).join(', ') : '_None_');
const front = (o: Record<string, unknown>) => `---\n${stringify(o).trimEnd()}\n---\n`;

export function renderPrd(p: Prd): string {
  const { problem, goals, non_goals, user_stories, requirements, acceptance_criteria, success_metrics, risks, dependencies, open_questions, ...meta } = p;
  return `${front(meta)}
# ${p.id}: ${p.title}

**Status:** ${p.status} · **Teams:** ${p.teams.join(', ')} · **OKRs:** ${links(p.okr_refs)}

## Problem
${problem}

## Goals
${list(goals)}

## Non-goals
${list(non_goals)}

## User stories
${list(user_stories)}

## Requirements
${requirements.map((r) => `- **${r.id}** (${r.priority}) ${r.text}`).join('\n')}

## Acceptance criteria
${acceptance_criteria.map((a) => `- [ ] ${a}`).join('\n')}

## Success metrics
${list(success_metrics)}

## Risks
${list(risks)}

## Dependencies
${list(dependencies)}

## Open questions
${list(open_questions)}

## Tech plans
${links(p.tech_plans)}

## Pull requests
${list(p.prs)}
`;
}

export function renderOkr(o: Okr): string {
  const { objective, key_results, ...meta } = o;
  return `${front(meta)}
# ${o.id}: ${objective}

**Quarter:** ${o.quarter} · **Owner:** ${o.owner} · **Teams:** ${o.teams.join(', ')}

## Key results
${key_results.map((k) => `- **${k.id}** ${k.text} — ${k.metric}: ${k.baseline ? `${k.baseline} → ` : ''}${k.target}`).join('\n')}
`;
}

export function renderTechPlan(t: TechPlan): string {
  const { summary, approach, files, test_plan, rollout, remote_changes, risks, review, ...meta } = t;
  return `${front(meta)}
# ${t.id}: ${summary}

**PRD:** [[${t.prd}]] · **Author:** ${t.author} · **Status:** ${t.status} · **Branch:** \`${t.branch}\`

## Approach
${approach}

## File changes
${files.length ? files.map((f) => `- \`${f.path}\` — ${f.change}`).join('\n') : '_None_'}

## Test plan
${list(test_plan)}

## Remote host changes
${list(remote_changes)}

## Rollout
${rollout || '_n/a_'}

## Risks
${list(risks)}

## Review
${review.length ? review.map((r) => `- Round ${r.round}: **${r.verdict}** — ${r.comments}`).join('\n') : '_Pending_'}
`;
}
