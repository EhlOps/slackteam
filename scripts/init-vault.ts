// Scaffolds the Obsidian vault in the product-vault repo (must already exist on GitHub, can be empty).
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { loadConfig } from '../src/config.js';
import { Vault } from '../src/vault/git.js';

const cfg = loadConfig();
const vault = new Vault(join(cfg.env.DATA_DIR, 'vault'), `https://github.com/${cfg.env.VAULT_REPO}.git`);
await vault.sync();

for (const d of ['OKRs', 'PRDs', 'TechPlans', 'Teams', '.obsidian']) mkdirSync(join(vault.dir, d), { recursive: true });
vault.writeSchemas();
writeFileSync(join(vault.dir, '.obsidian', 'app.json'), JSON.stringify({ newLinkFormat: 'shortest', useMarkdownLinks: false }, null, 2) + '\n');
for (const t of cfg.teams) {
  const f = join(vault.dir, 'Teams', `${t.key}.md`);
  if (!existsSync(f)) writeFileSync(f, `# ${t.key}\n\n${t.description}\n\n## Shipped work\n`);
}
for (const d of ['OKRs', 'PRDs', 'TechPlans']) writeFileSync(join(vault.dir, d, '.gitkeep'), '');
writeFileSync(join(vault.dir, 'README.md'), '# Product vault\n\nOpen this folder in Obsidian. Every OKR/PRD/Tech plan is a `.md` (for reading) plus a `.json` (source of truth, validated against `_schemas/`). Written by the EM and SWE agents; do not edit the `.md` by hand.\n');

const git = simpleGit(vault.dir);
await git.add('.');
if ((await git.status()).files.length) {
  await git.commit('chore: scaffold vault');
  await git.push(['-u', 'origin', 'HEAD']);
}
console.log('vault ready at', vault.dir);
