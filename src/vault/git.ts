import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { ZodType } from 'zod';
import { jsonSchemas, Okr, Prd, TechPlan } from './schema.js';
import { renderOkr, renderPrd, renderTechPlan } from './render.js';

type Kind = 'okr' | 'prd' | 'techplan';
const DIRS: Record<Kind, string> = { okr: 'OKRs', prd: 'PRDs', techplan: 'TechPlans' };

export class Vault {
  constructor(readonly dir: string, private remote: string) {}

  /** Clone on first use, otherwise fast-forward. */
  async sync() {
    if (!existsSync(join(this.dir, '.git'))) {
      mkdirSync(this.dir, { recursive: true });
      await simpleGit().clone(this.remote, this.dir);
    } else {
      await simpleGit(this.dir).pull(['--ff-only']).catch(() => undefined); // empty remote has nothing to pull
    }
  }

  nextPrdId(): string {
    const dir = join(this.dir, DIRS.prd);
    const nums = existsSync(dir) ? readdirSync(dir).map((f) => /^PRD-(\d{4})/.exec(f)?.[1]).filter(Boolean).map(Number) : [];
    return `PRD-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, '0')}`;
  }

  read(kind: Kind, id: string): unknown | undefined {
    const f = this.find(kind, id, 'json');
    return f ? JSON.parse(readFileSync(f, 'utf8')) : undefined;
  }

  private find(kind: Kind, id: string, ext: 'md' | 'json'): string | undefined {
    const dir = join(this.dir, DIRS[kind]);
    if (!existsSync(dir)) return;
    const hit = readdirSync(dir).find((f) => f.startsWith(id) && f.endsWith(`.${ext}`));
    return hit && join(dir, hit);
  }

  /** Validate, write JSON then derive the Markdown from it so the pair never drifts, then commit + push. */
  async write(kind: Kind, data: unknown, slug: string): Promise<{ id: string; files: string[] }> {
    const schema: Record<Kind, ZodType> = { okr: Okr, prd: Prd, techplan: TechPlan };
    const parsed = schema[kind].parse(data) as Okr | Prd | TechPlan;
    const render = { okr: renderOkr, prd: renderPrd, techplan: renderTechPlan }[kind] as (x: any) => string;
    const dir = join(this.dir, DIRS[kind]);
    mkdirSync(dir, { recursive: true });
    const base = this.find(kind, parsed.id, 'json')?.replace(/\.json$/, '') ?? join(dir, `${parsed.id}-${slug}`);
    writeFileSync(`${base}.json`, JSON.stringify(parsed, null, 2) + '\n');
    writeFileSync(`${base}.md`, render(parsed));
    this.writeSchemas();
    const git = simpleGit(this.dir);
    await git.add('.');
    await git.commit(`${kind}: ${parsed.id} ${slug}`);
    await git.push(['-u', 'origin', 'HEAD']).catch(async () => {
      await git.pull(['--rebase']);
      await git.push(['-u', 'origin', 'HEAD']);
    });
    return { id: parsed.id, files: [`${base}.json`, `${base}.md`] };
  }

  writeSchemas() {
    const dir = join(this.dir, '_schemas');
    mkdirSync(dir, { recursive: true });
    for (const [k, v] of Object.entries(jsonSchemas)) writeFileSync(join(dir, `${k}.schema.json`), JSON.stringify(v, null, 2) + '\n');
  }
}
