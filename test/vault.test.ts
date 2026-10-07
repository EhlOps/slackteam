import { describe, expect, it } from 'vitest';
import { Prd } from '../src/vault/schema.js';
import { renderPrd } from '../src/vault/render.js';

const prd = Prd.parse({
  id: 'PRD-0001', title: 'Healthz endpoint', status: 'in_review', teams: ['backend'], okr_refs: ['OKR-2026Q4-01'], pm: 'Sam',
  problem: 'No liveness probe.', goals: ['Expose /healthz'],
  requirements: [{ id: 'R1', text: 'GET /healthz returns 200', priority: 'must' }],
  acceptance_criteria: ['curl /healthz returns 200'], created: '2026-10-07', updated: '2026-10-07',
});

describe('vault', () => {
  it('renders deterministically with frontmatter and wikilinks', () => {
    const md = renderPrd(prd);
    expect(md).toBe(renderPrd(prd));
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('[[OKR-2026Q4-01]]');
    expect(md).toContain('- **R1** (must) GET /healthz returns 200');
  });
  it('rejects a PRD without requirements', () => {
    expect(() => Prd.parse({ ...prd, requirements: [] })).toThrow();
  });
});
